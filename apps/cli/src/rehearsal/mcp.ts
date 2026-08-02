import * as z from "zod";

import { mcpControlPlaneStatusResultSchema } from "../mcp-result-schemas.js";
import {
  parseMcpToolResult,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolCallResponseSchema,
  type TemporaryOwnerMcpSession,
} from "../temporary-owner-session.js";

interface RehearsalToolCallOptions {
  acceptErrorResult?: boolean;
  timeoutMs?: number;
}

const rehearsalFailureSchema = z.object({
  code: temporaryOwnerSessionErrorCodeSchema,
  message: z.string().max(512),
});

export type RehearsalFailure = z.infer<typeof rehearsalFailureSchema>;

type RehearsalPayload<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "invalid_json" | "invalid_payload" };

function decodeRehearsalPayload<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
): RehearsalPayload<T> {
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    return { ok: false, reason: "invalid_json" };
  }

  const parsed = schema.safeParse(payload);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, reason: "invalid_payload" };
}

export function normalizeRehearsalFailure(
  error: unknown,
  fallbackMessage: string,
): RehearsalFailure {
  try {
    const parsed = rehearsalFailureSchema.safeParse(error);

    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // A hostile thrown value must not escape diagnostic normalization.
  }

  return { code: "request_failed", message: fallbackMessage };
}

export async function callRehearsalTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
  options: RehearsalToolCallOptions = {},
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: arguments_, name },
    toolCallResponseSchema,
    options.timeoutMs,
  );

  if (!options.acceptErrorResult) {
    return parseMcpToolResult(response, schema, invalidMessage);
  }

  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  const payload = decodeRehearsalPayload(text, schema);

  if (!payload.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }

  return payload.value;
}

export async function readRehearsalStatus(
  session: TemporaryOwnerMcpSession,
  options: Pick<RehearsalToolCallOptions, "timeoutMs"> = {},
): Promise<Extract<z.infer<typeof mcpControlPlaneStatusResultSchema>, { ok: true }>["status"]> {
  const result = await callRehearsalTool(
    session,
    "crewhelm_status",
    {},
    mcpControlPlaneStatusResultSchema,
    "Fleet status returned an invalid payload.",
    options,
  );

  if (!result.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", "Fleet status request was denied.");
  }
  return result.status;
}
