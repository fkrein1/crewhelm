import {
  composioConnectedAccountIdSchema,
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_CONNECTED_ACCOUNTS_URL = "https://backend.composio.dev/api/v3.1/connected_accounts";
const COMPOSIO_TOOL_EXECUTION_URL = "https://backend.composio.dev/api/v3/tools/execute";
const MAXIMUM_CONNECTION_RESPONSE_BYTES = 256 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const connectedAccountSchema = z.object({
  id: composioConnectedAccountIdSchema,
  status: z.literal("ACTIVE"),
  toolkit: z.object({
    slug: integrationSlugSchema,
  }),
});
const toolExecutionResponseSchema = z.object({
  data: z.unknown(),
  error: z.string().nullish(),
  log_id: z.string().min(1).max(512).nullish(),
  success: z.boolean().optional(),
  successful: z.boolean().optional(),
});
const toolExecutionErrorSchema = z.object({
  error: z.object({
    code: z.number().int().nonnegative().safe(),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._-]+$/),
  }),
});

export interface ComposioRuntime {
  createInputSchema(parametersJson: string): z.ZodType<Record<string, unknown>>;
  execute(input: {
    arguments: Record<string, unknown>;
    maximumOutputBytes: number;
    providerConnectionId: string;
    signal: AbortSignal;
    timeoutMs: number;
    toolSlug: string;
    toolkitVersion: string;
    userId: string;
  }): Promise<unknown>;
  verifyConnection(
    providerConnectionId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; toolkitSlug: string } | { ok: false }>;
}

export interface ComposioRuntimeOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  onResponse?: (event: ComposioRuntimeResponseEvent) => void;
}

export type ComposioRuntimeResponseEvent =
  | {
      durationMs: number;
      operation: "execute";
      outcome:
        | "accepted"
        | "invalid_response"
        | "provider_rejected"
        | "sensitive_response"
        | "transport_error";
      providerErrorCode?: number;
      providerErrorSlug?: string;
      status: number | null;
      toolSlug: string;
    }
  | {
      durationMs: number;
      operation: "verify";
      outcome: "accepted" | "invalid_response" | "provider_rejected" | "transport_error";
      status: number | null;
    };
type WithoutDuration<Event> = Event extends unknown ? Omit<Event, "durationMs"> : never;

function containsSecret(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === "string" && current.includes(secret)) {
      return true;
    }

    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === "object" && current !== null) {
      pending.push(...Object.values(current));
    }
  }

  return false;
}

function containsSensitiveProviderOutput(
  value: unknown,
  providerConnectionId: string,
  apiKey: string,
): boolean {
  const sensitiveKeys = new Set([
    "accesskey",
    "accesstoken",
    "apikey",
    "apisecret",
    "authcode",
    "authorization",
    "authorizationcode",
    "bearer",
    "clientsecret",
    "cookie",
    "credential",
    "credentials",
    "idtoken",
    "jwt",
    "oauthcode",
    "password",
    "passphrase",
    "privatekey",
    "refreshtoken",
    "secret",
    "secretkey",
    "sessioncookie",
    "sessionid",
    "sessiontoken",
    "setcookie",
    "token",
  ]);
  const sensitiveStringPatterns = [
    /^Bearer\s+\S+/i,
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
    /(?:^|;\s*)(?:auth|session|sessionid|token)=[^;\s]+/i,
    /^(?:github_pat_|gh[oprsu]_|sk-|xox[a-z]-)[A-Za-z0-9_-]+$/,
  ];
  const sensitiveKeyFragments = [
    "accesskey",
    "accesstoken",
    "apikey",
    "apisecret",
    "authorizationcode",
    "clientsecret",
    "idtoken",
    "privatekey",
    "refreshtoken",
    "secretkey",
    "sessioncookie",
    "sessiontoken",
  ];
  const isSensitiveKey = (key: string): boolean => {
    const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

    return (
      sensitiveKeys.has(normalizedKey) ||
      sensitiveKeyFragments.some((fragment) => normalizedKey.includes(fragment)) ||
      /(?:^|auth|oauth|bearer|jwt)token(?:value|string|text|data)?$/.test(normalizedKey) ||
      /secret(?:value|string|text|data)$/.test(normalizedKey)
    );
  };
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (
      typeof current === "string" &&
      (current.includes(apiKey) ||
        current.includes(providerConnectionId) ||
        sensitiveStringPatterns.some((pattern) => pattern.test(current)))
    ) {
      return true;
    }

    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (typeof current === "object" && current !== null) {
      const descriptor = Object.entries(current).find(
        ([key, item]) =>
          ["key", "label", "name", "type"].includes(key.toLowerCase().replaceAll(/[^a-z]/g, "")) &&
          typeof item === "string",
      )?.[1];

      if (typeof descriptor === "string" && isSensitiveKey(descriptor)) {
        return true;
      }

      for (const [key, item] of Object.entries(current)) {
        if (isSensitiveKey(key)) {
          return true;
        }

        pending.push(item);
      }
    }
  }

  return false;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

type ZodJsonSchema = Parameters<typeof z.fromJSONSchema>[0];

function isJsonSchema(value: unknown): value is Exclude<ZodJsonSchema, boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRootObjectJsonSchema(value: Record<string, unknown>): value is Exclude<
  ZodJsonSchema,
  boolean
> & {
  properties: Record<string, unknown>;
  type: "object";
} {
  return value.type === "object" && isJsonSchema(value.properties);
}

export function createComposioRuntime(options: ComposioRuntimeOptions): ComposioRuntime {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  function recordResponse(event: WithoutDuration<ComposioRuntimeResponseEvent>, startedAt: number) {
    try {
      options.onResponse?.({
        ...event,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    } catch {
      // Diagnostic telemetry must not alter provider behavior.
    }
  }

  return {
    createInputSchema(parametersJson) {
      const parsedParameters = integrationToolParameterMapSchema.parse(JSON.parse(parametersJson));

      if (!isRootObjectJsonSchema(parsedParameters)) {
        throw new Error("Composio tool schema is unavailable.");
      }

      const schema = z.fromJSONSchema({
        ...parsedParameters,
        additionalProperties: false,
      });

      return z.pipe(schema, z.record(z.string(), z.unknown()));
    },

    async execute(input) {
      if (!apiKey.success) {
        throw new Error("Composio tool execution is unavailable.");
      }

      const providerConnectionId = composioConnectedAccountIdSchema.parse(
        input.providerConnectionId,
      );
      const toolSlug = integrationToolSlugSchema.parse(input.toolSlug);
      const toolkitVersion = integrationToolkitVersionSchema.parse(input.toolkitVersion);
      const userId = ownerKeySchema.parse(input.userId);
      const endpoint = new URL(`${COMPOSIO_TOOL_EXECUTION_URL}/${encodeURIComponent(toolSlug)}`);
      const startedAt = performance.now();
      let response: Response;

      try {
        response = await fetchImplementation(endpoint, {
          body: JSON.stringify({
            arguments: input.arguments,
            connected_account_id: providerConnectionId,
            user_id: userId,
            version: toolkitVersion,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": apiKey.data,
          },
          method: "POST",
          redirect: "manual",
          signal: requestSignal(input.signal, input.timeoutMs),
        });
      } catch {
        recordResponse(
          {
            operation: "execute",
            outcome: "transport_error",
            status: null,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        let providerError: z.infer<typeof toolExecutionErrorSchema> | undefined;

        if (response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
          try {
            const parsedError = toolExecutionErrorSchema.safeParse(
              await readBoundedJson(response, 32 * 1_024),
            );
            providerError = parsedError.success ? parsedError.data : undefined;
          } catch {
            // The bounded status and generic outcome remain useful without provider error details.
          }
        }

        recordResponse(
          {
            operation: "execute",
            outcome: "provider_rejected",
            ...(providerError === undefined
              ? {}
              : {
                  providerErrorCode: providerError.error.code,
                  providerErrorSlug: providerError.error.slug,
                }),
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      let execution: ReturnType<typeof toolExecutionResponseSchema.safeParse>;

      try {
        execution = toolExecutionResponseSchema.safeParse(
          await readBoundedJson(response, input.maximumOutputBytes),
        );
      } catch {
        recordResponse(
          {
            operation: "execute",
            outcome: "invalid_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      if (
        !execution.success ||
        (execution.data.success ?? execution.data.successful) !== true ||
        execution.data.error != null
      ) {
        recordResponse(
          {
            operation: "execute",
            outcome: execution.success ? "provider_rejected" : "invalid_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      if (containsSensitiveProviderOutput(execution.data.data, providerConnectionId, apiKey.data)) {
        recordResponse(
          {
            operation: "execute",
            outcome: "sensitive_response",
            status: response.status,
            toolSlug,
          },
          startedAt,
        );
        throw new Error("Composio tool execution failed.");
      }

      recordResponse(
        {
          operation: "execute",
          outcome: "accepted",
          status: response.status,
          toolSlug,
        },
        startedAt,
      );
      return execution.data.data;
    },

    async verifyConnection(providerConnectionId, signal) {
      if (!apiKey.success) {
        return { ok: false };
      }

      const parsedId = composioConnectedAccountIdSchema.safeParse(providerConnectionId);

      if (!parsedId.success) {
        return { ok: false };
      }

      const endpoint = new URL(
        `${COMPOSIO_CONNECTED_ACCOUNTS_URL}/${encodeURIComponent(parsedId.data)}`,
      );
      const startedAt = performance.now();

      try {
        const response = await fetchImplementation(endpoint, {
          headers: {
            accept: "application/json",
            "x-api-key": apiKey.data,
          },
          method: "GET",
          redirect: "manual",
          signal: requestSignal(signal, 5_000),
        });

        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          recordResponse(
            {
              operation: "verify",
              outcome: "provider_rejected",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false };
        }

        let account: ReturnType<typeof connectedAccountSchema.safeParse>;

        try {
          account = connectedAccountSchema.safeParse(
            await readBoundedJson(response, MAXIMUM_CONNECTION_RESPONSE_BYTES),
          );
        } catch {
          recordResponse(
            {
              operation: "verify",
              outcome: "invalid_response",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false };
        }

        if (
          !account.success ||
          account.data.id !== parsedId.data ||
          containsSecret(account.data, apiKey.data)
        ) {
          recordResponse(
            {
              operation: "verify",
              outcome: "invalid_response",
              status: response.status,
            },
            startedAt,
          );
          return { ok: false };
        }

        recordResponse(
          {
            operation: "verify",
            outcome: "accepted",
            status: response.status,
          },
          startedAt,
        );
        return { ok: true, toolkitSlug: account.data.toolkit.slug };
      } catch {
        recordResponse(
          {
            operation: "verify",
            outcome: "transport_error",
            status: null,
          },
          startedAt,
        );
        return { ok: false };
      }
    },
  };
}
