import {
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  composioConnectedAccountIdSchema,
  connectionAuthConfigIdSchema,
  connectionLinkUrlSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_CONNECTION_LINK_URL = "https://backend.composio.dev/api/v3/connected_accounts/link";
const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";
const CONNECTION_LINK_TIMEOUT_MS = 5_000;
const MAXIMUM_CONNECTION_LINK_RESPONSE_BYTES = 32 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioLinkTokenSchema = z
  .string()
  .min(4)
  .max(256)
  .regex(/^ln_[A-Za-z0-9_-]+$/);
const composioConnectionLinkInputSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  userId: ownerKeySchema,
});
const composioConnectionLinkResponseSchema = z.looseObject({
  connected_account_id: composioConnectedAccountIdSchema,
  expires_at: z.iso.datetime(),
  experimental: z.looseObject({
    account_type: z.literal("PRIVATE"),
  }),
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
  create(input: { authConfigId: string; userId: string }): Promise<ComposioConnectionLinkResult>;
  isAvailable(): boolean;
}

export interface ComposioConnectionLinksOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  signal?: AbortSignal;
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

  return {
    async create(input) {
      const request = composioConnectionLinkInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return outcomeUnknown();
      }

      try {
        const response = await fetchImplementation(COMPOSIO_CONNECTION_LINK_URL, {
          body: JSON.stringify({
            auth_config_id: request.data.authConfigId,
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
          return outcomeUnknown();
        }

        const connectionLink = composioConnectionLinkResponseSchema.safeParse(
          await readBoundedJson(response, MAXIMUM_CONNECTION_LINK_RESPONSE_BYTES),
        );

        if (!connectionLink.success) {
          return outcomeUnknown();
        }

        const expiresAt = Date.parse(connectionLink.data.expires_at);
        const currentTime = now();

        if (
          expiresAt <= currentTime ||
          expiresAt > currentTime + CONNECTION_LINK_UNKNOWN_RECOVERY_MS ||
          !isExpectedConnectUrl(connectionLink.data.redirect_url, connectionLink.data.link_token)
        ) {
          return outcomeUnknown();
        }

        const result: ComposioConnectionLink = {
          expiresAt: connectionLink.data.expires_at,
          providerConnectionId: connectionLink.data.connected_account_id,
          url: connectionLink.data.redirect_url,
        };

        return JSON.stringify(result).includes(apiKey.data)
          ? outcomeUnknown()
          : { connectionLink: result, ok: true };
      } catch {
        return outcomeUnknown();
      }
    },
    isAvailable() {
      return apiKey.success;
    },
  };
}
