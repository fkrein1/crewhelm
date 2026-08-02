import {
  CONNECTION_CONFIGS_READ_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  unavailableMcpToolResultSchema,
  type OwnerAuthority,
  type RetryDisposition,
} from "@crewhelm/contracts";
import type * as z from "zod";

type UnavailableCode =
  | "control_plane_unavailable"
  | "integration_provider_unavailable"
  | "invalid_control_plane_response"
  | "invalid_integration_response";

interface UnavailableToolOptions {
  code?: UnavailableCode;
  disposition?: RetryDisposition;
  phase?: string;
  reason?: string;
}

interface McpToolResult {
  [key: string]: unknown;
  content: Array<{
    text: string;
    type: "text";
  }>;
  isError: boolean;
}

type EncodedToolResult<Result> = { ok: true; result: Result; text: string } | { ok: false };

function encodeToolResult<Result extends { ok: boolean }>(
  input: unknown,
  schema: z.ZodType<Result>,
): EncodedToolResult<Result> {
  try {
    const parsed = schema.safeParse(input);

    if (!parsed.success) {
      return { ok: false };
    }

    const text = JSON.stringify(parsed.data);
    return typeof text === "string" ? { ok: true, result: parsed.data, text } : { ok: false };
  } catch {
    // Hostile dependency values can still throw through accessors during validation or serialization.
    return { ok: false };
  }
}

export function validatedToolResult<Result extends { ok: boolean }>(
  input: unknown,
  schema: z.ZodType<Result>,
  invalidResponse: UnavailableToolOptions = {
    code: "invalid_control_plane_response",
    disposition: "contact_operator",
    phase: "control_plane.response",
    reason: "invalid_response",
  },
): McpToolResult {
  const encoded = encodeToolResult(input, schema);

  if (!encoded.ok) {
    return unavailableToolResult(invalidResponse);
  }

  return {
    content: [
      {
        text: encoded.text,
        type: "text" as const,
      },
    ],
    isError: !encoded.result.ok,
  };
}

export function unavailableToolResult(options: UnavailableToolOptions = {}): McpToolResult {
  const diagnosticId = `diag_${crypto.randomUUID()}`;
  const code = options.code ?? "control_plane_unavailable";
  const result = unavailableMcpToolResultSchema.parse({
    error: {
      code,
      diagnostic: {
        certainty: "confirmed",
        disposition: options.disposition ?? "wait_then_retry",
        id: diagnosticId,
        nextAction:
          (options.disposition ?? "wait_then_retry") === "contact_operator"
            ? "contact_operator"
            : "retry_request",
        phase: options.phase ?? "control_plane.rpc",
        reason: options.reason ?? "dependency_unavailable",
      },
      message: "Crewhelm request unavailable.",
    },
    ok: false,
  });

  try {
    console.warn({
      code,
      diagnosticId,
      event: "crewhelm.mcp.tool_unavailable",
      phase: result.error.diagnostic.phase,
      reason: result.error.diagnostic.reason,
    });
  } catch {
    // Diagnostic logging must not alter the bounded MCP response.
  }

  return {
    content: [
      {
        text: JSON.stringify(result),
        type: "text" as const,
      },
    ],
    isError: true,
  };
}

export async function controlPlaneToolResult<Result extends { ok: boolean }>(
  operation: () => Promise<unknown>,
  schema: z.ZodType<Result>,
): Promise<McpToolResult> {
  let result: unknown;

  try {
    result = await operation();
  } catch {
    return unavailableToolResult({
      phase: "control_plane.rpc",
      reason: "transport_error",
    });
  }

  return validatedToolResult(result, schema);
}

export async function optionalControlPlaneToolResult<Result extends { ok: boolean }>(
  operation: (() => Promise<unknown>) | undefined,
  schema: z.ZodType<Result>,
): Promise<McpToolResult> {
  return operation === undefined
    ? unavailableToolResult({
        phase: "control_plane.rpc",
        reason: "dependency_unavailable",
      })
    : controlPlaneToolResult(operation, schema);
}

export async function integrationReadToolResult<Result extends { ok: boolean }>(
  authority: OwnerAuthority,
  operation: () => Promise<unknown>,
  schema: z.ZodType<Result>,
): Promise<McpToolResult> {
  if (!authority.scopes.includes(INTEGRATIONS_READ_SCOPE)) {
    return validatedToolResult(
      {
        error: {
          code: "insufficient_scope",
          message: "Integration catalog request denied.",
        },
        ok: false,
      },
      schema,
    );
  }

  let result: unknown;

  try {
    result = await operation();
  } catch {
    return unavailableToolResult({
      code: "integration_provider_unavailable",
      phase: "integration.rpc",
      reason: "transport_error",
    });
  }

  return validatedToolResult(result, schema, {
    code: "invalid_integration_response",
    disposition: "contact_operator",
    phase: "integration.response",
    reason: "invalid_response",
  });
}

export async function connectionConfigurationToolResult<Result extends { ok: boolean }>(
  authority: OwnerAuthority,
  operation: () => Promise<unknown>,
  schema: z.ZodType<Result>,
): Promise<McpToolResult> {
  return authority.scopes.includes(INTEGRATIONS_READ_SCOPE) &&
    authority.scopes.includes(CONNECTION_CONFIGS_READ_SCOPE)
    ? integrationReadToolResult(authority, operation, schema)
    : validatedToolResult(
        {
          error: {
            code: "insufficient_scope",
            message: "Integration catalog request denied.",
          },
          ok: false,
        },
        schema,
      );
}
