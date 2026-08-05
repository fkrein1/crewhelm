import {
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  composioConnectedAccountIdSchema,
  connectionAuthorizationAuthenticatorSchema,
  connectionAuthorizationTokenSchema,
  connectionAuthConfigIdSchema,
  connectionLinkUrlSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_CONNECTION_LINK_URL =
  "https://backend.composio.dev/api/v3.1/connected_accounts/link";
const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";
const CONNECTION_LINK_TIMEOUT_MS = 5_000;
const MAXIMUM_CONNECTION_LINK_RESPONSE_BYTES = 32 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioLinkTokenSchema = z
  .string()
  .min(4)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);
const connectionAuthorizationCallbackUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  });
const composioConnectionLinkInputSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  callbackSecrets: z.tuple([
    connectionAuthorizationTokenSchema,
    connectionAuthorizationAuthenticatorSchema,
  ]),
  callbackUrl: connectionAuthorizationCallbackUrlSchema,
  userId: ownerKeySchema,
});
const composioConnectionLinkResponseSchema = z.looseObject({
  connected_account_id: composioConnectedAccountIdSchema,
  expires_at: z.iso.datetime(),
  // v3.1 does not require this response field even when the request explicitly pins PRIVATE.
  experimental: z
    .looseObject({
      account_type: z.literal("PRIVATE"),
    })
    .optional(),
  link_token: composioLinkTokenSchema,
  redirect_url: connectionLinkUrlSchema,
});

export interface ComposioConnectionLink {
  expiresAt: string;
  providerConnectionId: string;
  url: string;
}

export type ComposioConnectionLinkResult =
  | {
      connectionLink: ComposioConnectionLink;
      ok: true;
    }
  | {
      error: {
        code: "connection_link_outcome_unknown";
        message: "Connection link request denied.";
      };
      ok: false;
    };

export interface ComposioConnectionLinks {
  create(input: {
    authConfigId: string;
    callbackSecrets: [string, string];
    callbackUrl: string;
    userId: string;
  }): Promise<ComposioConnectionLinkResult>;
  isAvailable(): boolean;
}

export interface ComposioConnectionLinksOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  onResponse?: (event: ComposioConnectionLinkResponseEvent) => void;
  signal?: AbortSignal;
}

export interface ComposioConnectionLinkResponseEvent {
  durationMs: number;
  operation: "link";
  outcome:
    | "accepted"
    | "invalid_connected_account_id"
    | "invalid_expires_at"
    | "invalid_link_token"
    | "invalid_redirect_url"
    | "invalid_response"
    | "policy_rejected"
    | "provider_rejected";
  status: number;
}

function outcomeUnknown(): ComposioConnectionLinkResult {
  return {
    error: {
      code: "connection_link_outcome_unknown",
      message: "Connection link request denied.",
    },
    ok: false,
  };
}

function isExpectedConnectUrl(value: string, linkToken: string): boolean {
  const url = new URL(value);

  return (
    url.origin === COMPOSIO_CONNECT_ORIGIN &&
    url.pathname === `/link/${linkToken}` &&
    url.search === "" &&
    url.hash === ""
  );
}

export function createComposioConnectionLinks(
  options: ComposioConnectionLinksOptions,
): ComposioConnectionLinks {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;

  function recordResponse(
    status: number,
    outcome: ComposioConnectionLinkResponseEvent["outcome"],
    startedAt: number,
  ): void {
    try {
      options.onResponse?.({
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        operation: "link",
        outcome,
        status,
      });
    } catch {
      // Diagnostic telemetry must not alter provider behavior.
    }
  }

  return {
    async create(input) {
      const request = composioConnectionLinkInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return outcomeUnknown();
      }

      try {
        const startedAt = performance.now();
        const response = await fetchImplementation(COMPOSIO_CONNECTION_LINK_URL, {
          body: JSON.stringify({
            auth_config_id: request.data.authConfigId,
            callback_url: request.data.callbackUrl,
            experimental: {
              account_type: "PRIVATE",
            },
            user_id: request.data.userId,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": apiKey.data,
          },
          method: "POST",
          redirect: "manual",
          signal:
            options.signal === undefined
              ? AbortSignal.timeout(CONNECTION_LINK_TIMEOUT_MS)
              : AbortSignal.any([options.signal, AbortSignal.timeout(CONNECTION_LINK_TIMEOUT_MS)]),
        });
        if (
          response.status !== 201 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          recordResponse(response.status, "provider_rejected", startedAt);
          return outcomeUnknown();
        }

        const body = await readBoundedJson(response, MAXIMUM_CONNECTION_LINK_RESPONSE_BYTES);
        const connectionLink = body.ok
          ? composioConnectionLinkResponseSchema.safeParse(body.value)
          : { success: false as const };

        if (!connectionLink.success) {
          const field =
            "error" in connectionLink ? connectionLink.error.issues[0]?.path[0] : undefined;
          const outcome =
            field === "connected_account_id"
              ? "invalid_connected_account_id"
              : field === "expires_at"
                ? "invalid_expires_at"
                : field === "link_token"
                  ? "invalid_link_token"
                  : field === "redirect_url"
                    ? "invalid_redirect_url"
                    : "invalid_response";

          recordResponse(response.status, outcome, startedAt);
          return outcomeUnknown();
        }

        const expiresAt = Date.parse(connectionLink.data.expires_at);
        const currentTime = now();

        if (
          expiresAt <= currentTime ||
          expiresAt > currentTime + CONNECTION_LINK_UNKNOWN_RECOVERY_MS ||
          !isExpectedConnectUrl(connectionLink.data.redirect_url, connectionLink.data.link_token)
        ) {
          recordResponse(response.status, "policy_rejected", startedAt);
          return outcomeUnknown();
        }

        const result: ComposioConnectionLink = {
          expiresAt: connectionLink.data.expires_at,
          providerConnectionId: connectionLink.data.connected_account_id,
          url: connectionLink.data.redirect_url,
        };

        const serializedResult = JSON.stringify(result);

        if (
          [apiKey.data, ...request.data.callbackSecrets].some((secret) =>
            serializedResult.includes(secret),
          )
        ) {
          recordResponse(response.status, "policy_rejected", startedAt);
          return outcomeUnknown();
        }

        recordResponse(response.status, "accepted", startedAt);
        return { connectionLink: result, ok: true };
      } catch {
        return outcomeUnknown();
      }
    },
    isAvailable() {
      return apiKey.success;
    },
  };
}
