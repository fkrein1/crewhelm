import {
  composioConnectedAccountIdSchema,
  connectionAuthConfigIdSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
  ownerKeySchema,
  type IntegrationToolParameterValue,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL =
  "https://backend.composio.dev/api/v3.1/webhook_subscriptions";
const COMPOSIO_TRIGGER_MESSAGE_EVENT = "composio.trigger.message";
const COMPOSIO_WEBHOOK_TIMEOUT_MS = 5_000;
const MAXIMUM_COMPOSIO_WEBHOOK_BODY_BYTES = 256 * 1_024;
const MAXIMUM_COMPOSIO_WEBHOOK_RESPONSE_BYTES = 256 * 1_024;
const MAXIMUM_COMPOSIO_WEBHOOK_AGE_MS = 5 * 60 * 1_000;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioWebhookSecretSchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioWebhookSubscriptionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const safeComposioWebhookUrlSchema = z
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
const crewhelmComposioWebhookUrlSchema = safeComposioWebhookUrlSchema.refine(
  (value) => new URL(value).pathname === "/webhooks/composio",
);
const publicOriginSchema = z
  .url()
  .max(2_048)
  .transform((value, context) => {
    const url = new URL(value);

    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      context.addIssue({ code: "custom", message: "Expected a safe installation origin." });
      return z.NEVER;
    }

    return url.origin;
  });
const composioWebhookEventTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9._-]+$/);
const composioWebhookSubscriptionSchema = z.looseObject({
  enabled_events: z.array(composioWebhookEventTypeSchema).min(1).max(32),
  id: composioWebhookSubscriptionIdSchema,
  secret: composioWebhookSecretSchema,
  version: z.enum(["V1", "V2", "V3"]),
  webhook_url: safeComposioWebhookUrlSchema,
});
const composioWebhookSubscriptionV3Schema = composioWebhookSubscriptionSchema.extend({
  version: z.literal("V3"),
});
const composioWebhookSubscriptionListSchema = z.looseObject({
  items: z.array(z.unknown()).max(2),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const composioTriggerEventEnvelopeSchema = z.looseObject({
  data: integrationToolParameterMapSchema,
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  metadata: z.looseObject({
    auth_config_id: connectionAuthConfigIdSchema,
    connected_account_id: composioConnectedAccountIdSchema,
    log_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    trigger_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^ti_[A-Za-z0-9_-]+$/),
    trigger_slug: integrationToolSlugSchema,
    user_id: ownerKeySchema,
  }),
  timestamp: z.iso.datetime(),
  type: z.literal(COMPOSIO_TRIGGER_MESSAGE_EVENT),
});
const composioWebhookEnvelopeSchema = z.looseObject({
  type: composioWebhookEventTypeSchema,
});
const webhookHeaderSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
  signature: z.string().min(16).max(512).regex(/^\S+$/),
  timestamp: z.string().regex(/^[0-9]{10}$/),
});

export interface ComposioWebhookSubscription {
  enabledEvents: string[];
  id: string;
  secret: string;
  url: string;
}

export type EnsureComposioWebhookSubscriptionResult =
  | {
      ok: true;
      state: "created" | "reused" | "updated";
      subscription: ComposioWebhookSubscription;
    }
  | {
      error: {
        code:
          | "webhook_subscription_conflict"
          | "webhook_subscription_outcome_unknown"
          | "webhook_subscription_unavailable";
        message: "Integration webhook subscription request denied.";
      };
      ok: false;
    };

export interface ComposioWebhookSubscriptions {
  ensure(): Promise<EnsureComposioWebhookSubscriptionResult>;
}

export interface ComposioWebhookSubscriptionsOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  publicOrigin: string;
  signal?: AbortSignal;
}

export interface VerifiedComposioTriggerEvent {
  authConfigId: string;
  data: Record<string, IntegrationToolParameterValue>;
  eventId: string;
  occurredAt: string;
  ownerKey: string;
  providerConnectionId: string;
  providerTriggerId: string;
  sourceSlug: string;
}

export const verifiedComposioTriggerEventSchema: z.ZodType<VerifiedComposioTriggerEvent> =
  z.strictObject({
    authConfigId: connectionAuthConfigIdSchema,
    data: integrationToolParameterMapSchema,
    eventId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+$/),
    occurredAt: z.iso.datetime(),
    ownerKey: ownerKeySchema,
    providerConnectionId: composioConnectedAccountIdSchema,
    providerTriggerId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^ti_[A-Za-z0-9_-]+$/),
    sourceSlug: integrationToolSlugSchema,
  });

export type VerifyComposioTriggerEventResult =
  | { event: VerifiedComposioTriggerEvent; kind: "trigger"; ok: true }
  | { kind: "unsupported"; ok: true }
  | {
      error: {
        code: "invalid_webhook";
        message: "Integration webhook request denied.";
      };
      ok: false;
    };

export interface VerifyComposioTriggerEventInput {
  body: ArrayBuffer | Uint8Array;
  headers: Headers;
  now?: number;
  projectApiKey: string;
  secret: string;
}

function denied(
  code: Extract<EnsureComposioWebhookSubscriptionResult, { ok: false }>["error"]["code"],
): EnsureComposioWebhookSubscriptionResult {
  return {
    error: { code, message: "Integration webhook subscription request denied." },
    ok: false,
  };
}

function invalidWebhook(): VerifyComposioTriggerEventResult {
  return {
    error: { code: "invalid_webhook", message: "Integration webhook request denied." },
    ok: false,
  };
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
      continue;
    }

    if (typeof current === "object" && current !== null) {
      pending.push(...Object.values(current));
    }
  }

  return false;
}

function normalizeSubscription(
  subscription: z.infer<typeof composioWebhookSubscriptionSchema>,
): ComposioWebhookSubscription {
  return {
    enabledEvents: [...new Set(subscription.enabled_events)].toSorted(),
    id: subscription.id,
    secret: subscription.secret,
    url: subscription.webhook_url,
  };
}

function subscriptionMatches(
  subscription: z.infer<typeof composioWebhookSubscriptionSchema>,
  webhookUrl: string,
  enabledEvents: string[],
): boolean {
  const returnedEvents = [...new Set(subscription.enabled_events)].toSorted();

  return (
    subscription.version === "V3" &&
    subscription.webhook_url === webhookUrl &&
    returnedEvents.length === enabledEvents.length &&
    returnedEvents.every((event, index) => event === enabledEvents[index])
  );
}

export function createComposioWebhookSubscriptions(
  options: ComposioWebhookSubscriptionsOptions,
): ComposioWebhookSubscriptions {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const publicOrigin = publicOriginSchema.safeParse(options.publicOrigin);
  const webhookUrl = crewhelmComposioWebhookUrlSchema.safeParse(
    publicOrigin.success ? `${publicOrigin.data}/webhooks/composio` : null,
  );
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  async function providerRequest(
    endpoint: URL,
    method: "GET" | "PATCH" | "POST",
    body?: Record<string, unknown>,
  ): Promise<Response> {
    if (!apiKey.success) {
      throw new Error("Composio webhook subscriptions are unavailable.");
    }

    return fetchImplementation(endpoint, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-api-key": apiKey.data,
      },
      method,
      redirect: "manual",
      signal:
        options.signal === undefined
          ? AbortSignal.timeout(COMPOSIO_WEBHOOK_TIMEOUT_MS)
          : AbortSignal.any([options.signal, AbortSignal.timeout(COMPOSIO_WEBHOOK_TIMEOUT_MS)]),
    });
  }

  async function parseSubscriptionResponse(
    response: Response,
    expectedStatus: 200 | 201,
    expectedWebhookUrl: string,
    enabledEvents: string[],
  ): Promise<ComposioWebhookSubscription | null> {
    if (
      response.status !== expectedStatus ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return null;
    }

    const parsed = composioWebhookSubscriptionV3Schema.safeParse(
      await readBoundedJson(response, MAXIMUM_COMPOSIO_WEBHOOK_RESPONSE_BYTES),
    );

    if (
      !parsed.success ||
      !subscriptionMatches(parsed.data, expectedWebhookUrl, enabledEvents) ||
      (apiKey.success && containsSecret(normalizeSubscription(parsed.data), apiKey.data))
    ) {
      return null;
    }

    return normalizeSubscription(parsed.data);
  }

  return {
    async ensure() {
      let mutationDispatched = false;

      if (!apiKey.success || !webhookUrl.success) {
        return denied("webhook_subscription_unavailable");
      }

      try {
        const listEndpoint = new URL(COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL);
        listEndpoint.searchParams.set("limit", "2");
        const response = await providerRequest(listEndpoint, "GET");

        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return denied("webhook_subscription_unavailable");
        }

        const listed = composioWebhookSubscriptionListSchema.safeParse(
          await readBoundedJson(response, MAXIMUM_COMPOSIO_WEBHOOK_RESPONSE_BYTES),
        );

        if (!listed.success || listed.data.next_cursor != null || listed.data.items.length > 1) {
          return denied("webhook_subscription_unavailable");
        }

        if (listed.data.items.length === 0) {
          mutationDispatched = true;
          const created = await parseSubscriptionResponse(
            await providerRequest(new URL(COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL), "POST", {
              enabled_events: [COMPOSIO_TRIGGER_MESSAGE_EVENT],
              version: "V3",
              webhook_url: webhookUrl.data,
            }),
            201,
            webhookUrl.data,
            [COMPOSIO_TRIGGER_MESSAGE_EVENT],
          );

          return created === null
            ? denied("webhook_subscription_outcome_unknown")
            : { ok: true, state: "created", subscription: created };
        }

        const existing = composioWebhookSubscriptionSchema.safeParse(listed.data.items[0]);

        if (!existing.success || (apiKey.success && containsSecret(existing.data, apiKey.data))) {
          return denied("webhook_subscription_unavailable");
        }

        if (existing.data.webhook_url !== webhookUrl.data) {
          return denied("webhook_subscription_conflict");
        }

        const enabledEvents = [
          ...new Set([...existing.data.enabled_events, COMPOSIO_TRIGGER_MESSAGE_EVENT]),
        ].toSorted();

        if (enabledEvents.length > 32) {
          return denied("webhook_subscription_conflict");
        }

        if (subscriptionMatches(existing.data, webhookUrl.data, enabledEvents)) {
          return {
            ok: true,
            state: "reused",
            subscription: normalizeSubscription(existing.data),
          };
        }

        mutationDispatched = true;
        const updated = await parseSubscriptionResponse(
          await providerRequest(
            new URL(
              `${COMPOSIO_WEBHOOK_SUBSCRIPTIONS_URL}/${encodeURIComponent(existing.data.id)}`,
            ),
            "PATCH",
            {
              enabled_events: enabledEvents,
              version: "V3",
              webhook_url: webhookUrl.data,
            },
          ),
          200,
          webhookUrl.data,
          enabledEvents,
        );

        return updated === null
          ? denied("webhook_subscription_outcome_unknown")
          : { ok: true, state: "updated", subscription: updated };
      } catch {
        return denied(
          mutationDispatched
            ? "webhook_subscription_outcome_unknown"
            : "webhook_subscription_unavailable",
        );
      }
    },
  };
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const decoded = atob(value);

    return Uint8Array.from(decoded, (character) => character.codePointAt(0) ?? 0);
  } catch {
    return null;
  }
}

function signatureBytes(header: string): Uint8Array | null {
  const parts = header.split(",");

  if (parts.length > 2 || (parts.length === 2 && parts[0] !== "v1")) {
    return null;
  }

  const encoded = parts.at(-1);

  return encoded === undefined || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ? null
    : decodeBase64(encoded);
}

export async function verifyComposioTriggerEvent(
  input: VerifyComposioTriggerEventInput,
): Promise<VerifyComposioTriggerEventResult> {
  const secret = composioWebhookSecretSchema.safeParse(input.secret);
  const projectApiKey = composioApiKeySchema.safeParse(input.projectApiKey);
  const body = input.body instanceof Uint8Array ? input.body : new Uint8Array(input.body);
  const headers = webhookHeaderSchema.safeParse({
    id: input.headers.get("webhook-id"),
    signature: input.headers.get("webhook-signature"),
    timestamp: input.headers.get("webhook-timestamp"),
  });

  if (
    !secret.success ||
    !projectApiKey.success ||
    !headers.success ||
    body.byteLength > MAXIMUM_COMPOSIO_WEBHOOK_BODY_BYTES
  ) {
    return invalidWebhook();
  }

  const occurredAt = Number(headers.data.timestamp) * 1_000;
  const currentTime = z
    .number()
    .int()
    .nonnegative()
    .safe()
    .safeParse(input.now ?? Date.now());

  if (
    !currentTime.success ||
    !Number.isSafeInteger(occurredAt) ||
    Math.abs(currentTime.data - occurredAt) > MAXIMUM_COMPOSIO_WEBHOOK_AGE_MS
  ) {
    return invalidWebhook();
  }

  const receivedSignature = signatureBytes(headers.data.signature);

  if (receivedSignature === null) {
    return invalidWebhook();
  }

  try {
    const signingPrefix = new TextEncoder().encode(`${headers.data.id}.${headers.data.timestamp}.`);
    const signingInput = new Uint8Array(signingPrefix.byteLength + body.byteLength);
    signingInput.set(signingPrefix);
    signingInput.set(body, signingPrefix.byteLength);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret.data),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      Uint8Array.from(receivedSignature),
      signingInput,
    );

    if (!verified) {
      return invalidWebhook();
    }

    const decoded: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
    );
    const envelope = composioWebhookEnvelopeSchema.safeParse(decoded);

    if (!envelope.success) {
      return invalidWebhook();
    }

    if (envelope.data.type !== COMPOSIO_TRIGGER_MESSAGE_EVENT) {
      return { kind: "unsupported", ok: true };
    }

    const parsed = composioTriggerEventEnvelopeSchema.safeParse(decoded);

    if (
      !parsed.success ||
      containsSecret(parsed.data, secret.data) ||
      containsSecret(parsed.data, projectApiKey.data)
    ) {
      return invalidWebhook();
    }

    return {
      event: {
        authConfigId: parsed.data.metadata.auth_config_id,
        data: parsed.data.data,
        eventId: parsed.data.id,
        occurredAt: parsed.data.timestamp,
        ownerKey: parsed.data.metadata.user_id,
        providerConnectionId: parsed.data.metadata.connected_account_id,
        providerTriggerId: parsed.data.metadata.trigger_id,
        sourceSlug: parsed.data.metadata.trigger_slug,
      },
      kind: "trigger",
      ok: true,
    };
  } catch {
    return invalidWebhook();
  }
}
