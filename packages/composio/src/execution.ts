import {
  composioConnectedAccountIdSchema,
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_CONNECTED_ACCOUNTS_URL = "https://backend.composio.dev/api/v3.1/connected_accounts";
const COMPOSIO_TOOL_EXECUTION_URL = "https://backend.composio.dev/api/v3.1/tools/execute";
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
const requiredParameterSchema = z.object({ required: z.literal(true) }).loose();

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
  }): Promise<unknown>;
  verifyConnection(
    providerConnectionId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; toolkitSlug: string } | { ok: false }>;
}

export interface ComposioRuntimeOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
}

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

export function createComposioRuntime(options: ComposioRuntimeOptions): ComposioRuntime {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    createInputSchema(parametersJson) {
      const parsedParameters = integrationToolParameterMapSchema.parse(JSON.parse(parametersJson));
      const required = Object.entries(parsedParameters)
        .filter(([, parameter]) => requiredParameterSchema.safeParse(parameter).success)
        .map(([name]) => name);
      const properties: Record<string, ZodJsonSchema> = {};

      for (const [name, parameter] of Object.entries(parsedParameters)) {
        if (!isJsonSchema(parameter)) {
          throw new Error("Composio tool schema is unavailable.");
        }

        properties[name] = parameter;
      }

      const schema = z.fromJSONSchema({
        additionalProperties: false,
        properties,
        required,
        type: "object",
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
      const endpoint = new URL(`${COMPOSIO_TOOL_EXECUTION_URL}/${encodeURIComponent(toolSlug)}`);
      const response = await fetchImplementation(endpoint, {
        body: JSON.stringify({
          arguments: input.arguments,
          connected_account_id: providerConnectionId,
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

      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        throw new Error("Composio tool execution failed.");
      }

      const execution = toolExecutionResponseSchema.safeParse(
        await readBoundedJson(response, input.maximumOutputBytes),
      );

      if (
        !execution.success ||
        (execution.data.success ?? execution.data.successful) !== true ||
        execution.data.error != null ||
        containsSensitiveProviderOutput(execution.data.data, providerConnectionId, apiKey.data)
      ) {
        throw new Error("Composio tool execution failed.");
      }

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
          return { ok: false };
        }

        const account = connectedAccountSchema.safeParse(
          await readBoundedJson(response, MAXIMUM_CONNECTION_RESPONSE_BYTES),
        );

        if (
          !account.success ||
          account.data.id !== parsedId.data ||
          containsSecret(account.data, apiKey.data)
        ) {
          return { ok: false };
        }

        return { ok: true, toolkitSlug: account.data.toolkit.slug };
      } catch {
        return { ok: false };
      }
    },
  };
}
