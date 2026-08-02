import { describe, expect, it, vi } from "vitest";

import {
  createComposioWebhookSubscriptions,
  verifyComposioTriggerEvent,
} from "./webhook-subscriptions.js";

const API_KEY = "composio-project-secret";
const WEBHOOK_SECRET = "composio-webhook-secret";
const WEBHOOK_URL = "https://crewhelm.example.com/webhooks/composio";
const PUBLIC_ORIGIN = "https://crewhelm.example.com";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return Response.json(body, { ...init, headers });
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    enabled_events: ["composio.trigger.message"],
    id: "whsub_crewhelm",
    secret: WEBHOOK_SECRET,
    version: "V3",
    webhook_url: WEBHOOK_URL,
    ...overrides,
  };
}

function triggerEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      issue: { id: "issue-42", title: "A bounded event" },
      labels: ["bug"],
    },
    id: "msg_event_42",
    metadata: {
      auth_config_id: "ac_github",
      connected_account_id: "ca_github_owner",
      log_id: "log_event_42",
      trigger_id: "ti_github_issue",
      trigger_slug: "GITHUB_ISSUE_EVENT",
      user_id: `owner_${"a".repeat(43)}`,
    },
    timestamp: "2026-08-02T09:20:00.000Z",
    type: "composio.trigger.message",
    ...overrides,
  };
}

async function signedRequest(input?: {
  body?: string;
  id?: string;
  secret?: string;
  signaturePrefix?: boolean;
  timestamp?: string;
}) {
  const body = input?.body ?? JSON.stringify(triggerEvent());
  const id = input?.id ?? "webhook_event_42";
  const secret = input?.secret ?? WEBHOOK_SECRET;
  const timestamp = input?.timestamp ?? "1785662400";
  const signingInput = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, signingInput));
  const encoded = btoa(String.fromCodePoint(...signature));

  return {
    body: new TextEncoder().encode(body),
    headers: new Headers({
      "webhook-id": id,
      "webhook-signature": input?.signaturePrefix === false ? encoded : `v1,${encoded}`,
      "webhook-timestamp": timestamp,
    }),
  };
}

describe("Composio webhook subscriptions", () => {
  it("creates the one signed V3 trigger subscription through fixed requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse(subscription(), { status: 201 }));
    const result = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: fetchMock,
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listEndpoint, listInit] = fetchMock.mock.calls[0] ?? [];
    const [createEndpoint, createInit] = fetchMock.mock.calls[1] ?? [];

    expect(listEndpoint).toBeInstanceOf(URL);
    expect(createEndpoint).toBeInstanceOf(URL);
    if (!(listEndpoint instanceof URL) || !(createEndpoint instanceof URL)) {
      throw new TypeError("Expected fixed Composio URLs.");
    }

    expect(listEndpoint.href).toBe(
      "https://backend.composio.dev/api/v3.1/webhook_subscriptions?limit=2",
    );
    expect(createEndpoint.href).toBe("https://backend.composio.dev/api/v3.1/webhook_subscriptions");
    expect(listInit?.method).toBe("GET");
    expect(createInit?.method).toBe("POST");
    expect(new Headers(createInit?.headers).get("x-api-key")).toBe(API_KEY);
    if (typeof createInit?.body !== "string") {
      throw new TypeError("Expected a JSON request body.");
    }
    expect(JSON.parse(createInit.body)).toEqual({
      enabled_events: ["composio.trigger.message"],
      version: "V3",
      webhook_url: WEBHOOK_URL,
    });
    expect(result).toEqual({
      ok: true,
      state: "created",
      subscription: {
        enabledEvents: ["composio.trigger.message"],
        id: "whsub_crewhelm",
        secret: WEBHOOK_SECRET,
        url: WEBHOOK_URL,
      },
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("reuses the exact Crewhelm subscription without a provider mutation", async () => {
    const existing = subscription({
      enabled_events: ["composio.connected_account.expired", "composio.trigger.message"],
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ items: [existing], next_cursor: null }));
    const result = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: fetchMock,
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      state: "reused",
      subscription: {
        enabledEvents: ["composio.connected_account.expired", "composio.trigger.message"],
        id: "whsub_crewhelm",
        secret: WEBHOOK_SECRET,
        url: WEBHOOK_URL,
      },
    });
  });

  it("upgrades Crewhelm's endpoint to V3 while preserving other event types", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            subscription({
              enabled_events: ["composio.connected_account.expired"],
              version: "V2",
            }),
          ],
          next_cursor: null,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          subscription({
            enabled_events: ["composio.connected_account.expired", "composio.trigger.message"],
          }),
        ),
      );
    const result = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: fetchMock,
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();
    const [endpoint, init] = fetchMock.mock.calls[1] ?? [];

    expect(endpoint).toBeInstanceOf(URL);
    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected a fixed Composio URL.");
    }

    expect(endpoint.pathname).toBe("/api/v3.1/webhook_subscriptions/whsub_crewhelm");
    expect(init?.method).toBe("PATCH");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a JSON request body.");
    }
    expect(JSON.parse(init.body)).toEqual({
      enabled_events: ["composio.connected_account.expired", "composio.trigger.message"],
      version: "V3",
      webhook_url: WEBHOOK_URL,
    });
    expect(result).toMatchObject({ ok: true, state: "updated" });
  });

  it("refuses to hijack a project subscription pointing somewhere else", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: [subscription({ webhook_url: "https://another.example.com/events" })],
        next_cursor: null,
      }),
    );
    const result = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: fetchMock,
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      error: {
        code: "webhook_subscription_conflict",
        message: "Integration webhook subscription request denied.",
      },
      ok: false,
    });
  });

  it("distinguishes read failures from unknown mutation outcomes", async () => {
    const readFailure = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("read failed")),
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();
    const mutationFailure = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
        .mockRejectedValueOnce(new Error("lost create response")),
      publicOrigin: PUBLIC_ORIGIN,
    }).ensure();

    expect(readFailure).toMatchObject({
      error: { code: "webhook_subscription_unavailable" },
      ok: false,
    });
    expect(mutationFailure).toMatchObject({
      error: { code: "webhook_subscription_outcome_unknown" },
      ok: false,
    });
  });

  it("rejects invalid input, pagination, multiplicity, and secret-bearing responses", async () => {
    const invalidUrlFetch = vi.fn<typeof fetch>();
    const invalidUrl = await createComposioWebhookSubscriptions({
      apiKey: API_KEY,
      fetch: invalidUrlFetch,
      publicOrigin: "https://crewhelm.example.com/not-an-origin",
    }).ensure();
    const cases = [
      { items: [], next_cursor: "unexpected-page" },
      { items: [subscription(), subscription({ id: "whsub_second" })], next_cursor: null },
      {
        items: [subscription({ secret: `reflected-${API_KEY}` })],
        next_cursor: null,
      },
      {
        items: [
          subscription({
            enabled_events: Array.from({ length: 32 }, (_, index) => `provider.event_${index}`),
          }),
        ],
        next_cursor: null,
      },
    ];

    expect(invalidUrlFetch).not.toHaveBeenCalled();
    expect(invalidUrl.ok).toBe(false);

    for (const response of cases) {
      const result = await createComposioWebhookSubscriptions({
        apiKey: API_KEY,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response)),
        publicOrigin: PUBLIC_ORIGIN,
      }).ensure();

      expect(result.ok).toBe(false);
    }
  });
});

describe("Composio trigger event verification", () => {
  it("verifies the raw signed V3 envelope and returns only bounded routing data", async () => {
    const signed = await signedRequest({
      body: JSON.stringify(
        triggerEvent({ data: { issue: { id: "issue-42", title: "A bounded événement ✨" } } }),
      ),
    });
    const result = await verifyComposioTriggerEvent({
      ...signed,
      now: 1_785_662_400_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });

    expect(result).toEqual({
      event: {
        authConfigId: "ac_github",
        data: {
          issue: { id: "issue-42", title: "A bounded événement ✨" },
        },
        eventId: "msg_event_42",
        occurredAt: "2026-08-02T09:20:00.000Z",
        ownerKey: `owner_${"a".repeat(43)}`,
        providerConnectionId: "ca_github_owner",
        providerTriggerId: "ti_github_issue",
        sourceSlug: "GITHUB_ISSUE_EVENT",
      },
      kind: "trigger",
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain(WEBHOOK_SECRET);
  });

  it("acknowledges a validly signed preserved event type without routing it", async () => {
    const signed = await signedRequest({
      body: JSON.stringify({ data: {}, type: "composio.connected_account.expired" }),
    });

    await expect(
      verifyComposioTriggerEvent({
        ...signed,
        now: 1_785_662_400_000,
        projectApiKey: API_KEY,
        secret: WEBHOOK_SECRET,
      }),
    ).resolves.toEqual({ kind: "unsupported", ok: true });
  });

  it("accepts the documented unprefixed base64 signature", async () => {
    const signed = await signedRequest({ signaturePrefix: false });
    const result = await verifyComposioTriggerEvent({
      ...signed,
      now: 1_785_662_400_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects bad signatures, stale or future timestamps, and malformed headers", async () => {
    const valid = await signedRequest();
    const badSignature = await verifyComposioTriggerEvent({
      ...valid,
      now: 1_785_662_400_000,
      projectApiKey: API_KEY,
      secret: "different-webhook-secret",
    });
    const stale = await verifyComposioTriggerEvent({
      ...valid,
      now: 1_785_662_701_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });
    const future = await verifyComposioTriggerEvent({
      ...valid,
      now: 1_785_662_099_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });
    const malformedHeaders = new Headers(valid.headers);
    malformedHeaders.set("webhook-signature", "v2,not-base64!");
    const malformedSignature = await verifyComposioTriggerEvent({
      body: valid.body,
      headers: malformedHeaders,
      now: 1_785_662_400_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });
    const missingHeaders = await verifyComposioTriggerEvent({
      body: valid.body,
      headers: new Headers(),
      now: 1_785_662_400_000,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });
    const invalidNow = await verifyComposioTriggerEvent({
      ...valid,
      now: Number.NaN,
      projectApiKey: API_KEY,
      secret: WEBHOOK_SECRET,
    });

    for (const result of [
      badSignature,
      stale,
      future,
      malformedSignature,
      missingHeaders,
      invalidNow,
    ]) {
      expect(result).toEqual({
        error: { code: "invalid_webhook", message: "Integration webhook request denied." },
        ok: false,
      });
    }
  });

  it("rejects invalid, secret-bearing, and oversized signed payloads", async () => {
    const invalidEnvelope = await signedRequest({
      body: JSON.stringify(triggerEvent({ data: null })),
    });
    const invalidJson = await signedRequest({ body: "not-json" });
    const secretBearing = await signedRequest({
      body: JSON.stringify(triggerEvent({ data: { leaked: WEBHOOK_SECRET } })),
    });
    const projectKeyBearing = await signedRequest({
      body: JSON.stringify(triggerEvent({ data: { leaked: API_KEY } })),
    });
    const oversizedBody = JSON.stringify({ padding: "x".repeat(256 * 1_024) });
    const oversized = await signedRequest({ body: oversizedBody });
    const cases = [
      { ...invalidEnvelope, secret: WEBHOOK_SECRET },
      { ...invalidJson, secret: WEBHOOK_SECRET },
      { ...secretBearing, secret: WEBHOOK_SECRET },
      { ...projectKeyBearing, secret: WEBHOOK_SECRET },
      { ...oversized, secret: WEBHOOK_SECRET },
    ];

    for (const input of cases) {
      const result = await verifyComposioTriggerEvent({
        ...input,
        now: 1_785_662_400_000,
        projectApiKey: API_KEY,
      });

      expect(result.ok).toBe(false);
    }
  });
});
