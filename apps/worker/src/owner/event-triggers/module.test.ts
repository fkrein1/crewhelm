import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  crewAgentObjectName,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { TestCrewAgent } from "../../agent/admitted-runs/test-agent.js";
import { agentInput, authorityFor } from "../testkit.js";
import { COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME } from "./composio-ingress.js";

const EVENT_TRIGGER_SCOPES = [
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
] as const;

function composioJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

async function signComposioWebhook(
  body: Uint8Array,
  id: string,
  timestamp: string,
  secret: string,
): Promise<string> {
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + body.byteLength);
  signed.set(prefix);
  signed.set(body, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  let binary = "";

  for (const byte of signature) {
    binary += String.fromCharCode(byte);
  }

  return `v1,${btoa(binary)}`;
}

describe("OwnerControlPlane Agent Event Triggers", () => {
  it("turns one signed Composio event into one duplicate-safe Event Trigger Run", async () => {
    const webhookSecret = "composio-webhook-secret-at-least-sixteen";
    let triggerUpsertAttempts = 0;
    let activeTriggerLookups = 0;
    let webhookSubscriptionReads = 0;
    let webhookSubscriptionWrites = 0;
    const source = {
      config: {
        repo: { display_name: "Repository", required: true, type: "string" },
      },
      description: "Triggers when an issue is created.",
      name: "Issue created",
      requires_webhook_endpoint_setup: false,
      slug: "GITHUB_ISSUE_CREATED",
      toolkit: { name: "GitHub", slug: "github" },
      type: "webhook",
      version: "20260802_00",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url =
        request instanceof URL ? request.href : request instanceof Request ? request.url : request;
      const method = init?.method ?? "GET";

      if (url.startsWith("https://backend.composio.dev/api/v3.1/triggers_types")) {
        return composioJson({ items: [source], next_cursor: null });
      }

      if (
        url === "https://backend.composio.dev/api/v3.1/webhook_subscriptions?limit=2" &&
        method === "GET"
      ) {
        webhookSubscriptionReads += 1;
        return composioJson({ items: [], next_cursor: null });
      }

      if (
        url === "https://backend.composio.dev/api/v3.1/webhook_subscriptions" &&
        method === "POST"
      ) {
        webhookSubscriptionWrites += 1;
        return composioJson(
          {
            enabled_events: ["composio.trigger.message"],
            id: "subscription_event_trigger",
            secret: webhookSecret,
            version: "V3",
            webhook_url: "https://crewhelm.test/webhooks/composio",
          },
          201,
        );
      }

      if (url.endsWith("/GITHUB_ISSUE_CREATED/upsert") && method === "POST") {
        triggerUpsertAttempts += 1;

        if (triggerUpsertAttempts <= 5) {
          return composioJson({ message: "temporary provider failure" }, 503);
        }

        return composioJson({ trigger_id: "ti_issue_event_trigger" }, 201);
      }

      if (url.startsWith("https://backend.composio.dev/api/v3.1/trigger_instances/active?")) {
        activeTriggerLookups += 1;
        const endpoint = new URL(url);
        return composioJson({
          items:
            activeTriggerLookups < 5
              ? []
              : [
                  {
                    connected_account_id: "ca_event_trigger_github",
                    id: "ti_issue_event_trigger",
                    trigger_config: { repo: "crewhelm" },
                    trigger_name: "GITHUB_ISSUE_CREATED",
                    user_id: endpoint.searchParams.get("user_ids"),
                    version: "20260802_00",
                  },
                ],
          next_cursor: null,
        });
      }

      if (url.endsWith("/manage/ti_issue_event_trigger") && method === "PATCH") {
        return composioJson({ status: "success" });
      }

      if (url.endsWith("/manage/ti_issue_event_trigger") && method === "DELETE") {
        return composioJson({ trigger_id: "ti_issue_event_trigger" });
      }

      throw new Error(`Unexpected Composio request: ${method} ${url}`);
    });
    const authority = await authorityFor("eventTrigger-composio-owner", [...EVENT_TRIGGER_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const ingress = env.OWNER_CONTROL_PLANE.getByName(COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("eventTrigger-composio-agent", "Composio Event Trigger Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Composio Event Trigger Agent fixture.");
    }
    const brief = await controlPlane.createBrief(authority, {
      content: "Prioritize customer-impacting issues and state uncertainty.",
      idempotencyKey: "event-trigger-context-brief",
      mediaType: "text/plain",
      name: "Issue triage policy",
    });
    if (!brief.ok) throw new Error("Expected Event Trigger Brief fixture.");

    await runInDurableObject(controlPlane, (_instance, state) => {
      const now = Date.now();
      const connectionId = "connection_12345678-1234-4123-8123-123456789abc";
      state.storage.sql.exec(
        `INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, account_label,
            status, created_at, revoked_at)
         VALUES (?, 'composio', 'ca_event_trigger_github', 'ac_event_trigger_github', 'GitHub test',
            'active', ?, NULL)`,
        connectionId,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO provider_auth_configs
          (auth_config_id, integration_slug, auth_scheme, source, display_name, created_at, updated_at)
         VALUES ('ac_event_trigger_github', 'github', 'OAUTH2', 'crewhelm_custom', 'GitHub test', ?, ?)`,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO connection_link_requests
          (client_id, idempotency_key, request_digest, auth_config_id, reservation_id, status,
            recover_after, connection_id, redirect_url, expires_at, created_at, completed_at)
         VALUES ('eventTrigger-fixture', 'link-github', ?, 'ac_event_trigger_github', 'connection_link_fixture',
            'completed', ?, ?, 'https://connect.composio.dev/link/fixture', ?, ?, ?)`,
        "l".repeat(43),
        now + 60_000,
        connectionId,
        now + 3_600_000,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO connection_authorization_returns
          (reservation_id, token_digest, status, connection_id, expires_at, created_at, completed_at)
         VALUES ('connection_link_fixture', ?, 'returned', ?, ?, ?, ?)`,
        "t".repeat(43),
        connectionId,
        now + 3_600_000,
        now,
        now,
      );
    });

    const connectionId = "connection_12345678-1234-4123-8123-123456789abc";
    await expect(
      controlPlane.agentEventTriggers(
        { ...authority, scopes: [OWNER_READ_SCOPE] },
        { action: "sources", connectionId },
      ),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      controlPlane.agentEventTriggers(authority, { action: "sources", connectionId }),
    ).resolves.toMatchObject({
      action: "sources",
      ok: true,
      sources: [
        {
          connectionId,
          kind: "connection_event",
          name: "Issue created",
          sourceSlug: "GITHUB_ISSUE_CREATED",
        },
      ],
    });

    const createInput = {
      action: "create",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      idempotencyKey: "create-composio-eventTrigger",
      eventTrigger: {
        briefs: [{ id: brief.brief.id, revision: brief.version.revision }],
        instruction: "Summarize the new issue and recommend the next owner action.",
        name: "New GitHub issues",
        source: {
          configuration: { repo: "crewhelm" },
          connectionId,
          delivery: "realtime",
          integrationSlug: "github",
          kind: "connection_event",
          sourceSlug: "GITHUB_ISSUE_CREATED",
          sourceVersion: "20260802_00",
        },
      },
    } as const;

    await expect(
      controlPlane.agentEventTriggers(authority, {
        ...createInput,
        idempotencyKey: "create-event-trigger-missing-brief",
        eventTrigger: {
          ...createInput.eventTrigger,
          briefs: [{ id: "brief_00000000-0000-4000-8000-000000000001", revision: 1 }],
        },
      }),
    ).resolves.toMatchObject({ error: { code: "brief_unavailable" }, ok: false });

    await runInDurableObject(controlPlane, (_instance, state) => {
      const now = Date.now();

      for (let revision = 1; revision <= 8; revision += 1) {
        const scheduleId = `schedule_00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`;
        state.storage.sql.exec(
          `INSERT INTO agent_schedule_revisions
            (schedule_id, agent_id, revision, agent_revision, name, configuration, created_at)
           VALUES (?, ?, ?, ?, 'Capacity fixture', ?, ?)`,
          scheduleId,
          created.agent.id,
          revision,
          created.agent.revision,
          JSON.stringify({
            prompt: "Capacity fixture.",
            trigger: { intervalSeconds: 600, type: "interval" },
          }),
          now,
        );
        state.storage.sql.exec(
          `INSERT INTO agent_schedules
            (schedule_id, agent_id, current_revision, status, next_run_at, created_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
          scheduleId,
          created.agent.id,
          revision,
          now + 600_000,
          now,
        );
      }
    });
    await expect(controlPlane.agentEventTriggers(authority, createInput)).resolves.toMatchObject({
      error: { code: "event_trigger_limit_exceeded" },
      ok: false,
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agent_schedules WHERE agent_id = ?", created.agent.id);
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_revisions WHERE agent_id = ?",
        created.agent.id,
      );
    });

    await expect(controlPlane.agentEventTriggers(authority, createInput)).resolves.toMatchObject({
      error: { code: "event_trigger_operation_unknown" },
      ok: false,
    });

    const pending = await runInDurableObject(controlPlane, (_instance, state) =>
      state.storage.sql
        .exec<{ providerAttempts: number; eventTriggerId: string }>(
          `SELECT provider_attempts AS providerAttempts, event_trigger_id AS eventTriggerId
           FROM agent_event_triggers
           WHERE agent_id = ?`,
          created.agent.id,
        )
        .one(),
    );
    const webhook = await runInDurableObject(ingress, (_instance, state) =>
      state.storage.sql
        .exec<{ secretCiphertext: string; secretNonce: string }>(
          `SELECT secret_ciphertext AS secretCiphertext, secret_nonce AS secretNonce
           FROM composio_event_trigger_webhook
           WHERE singleton = 1`,
        )
        .one(),
    );
    const reserved = { pending, webhook };

    expect(reserved).toMatchObject({
      pending: { providerAttempts: 1, eventTriggerId: expect.stringMatching(/^event_trigger_/) },
      webhook: {
        secretCiphertext: expect.any(String),
        secretNonce: expect.any(String),
      },
    });
    expect(reserved.webhook.secretCiphertext).not.toContain(webhookSecret);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await runInDurableObject(controlPlane, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE agent_event_triggers
           SET provider_retry_at = ?
           WHERE event_trigger_id = ?`,
          Date.now() - 1,
          reserved.pending.eventTriggerId,
        );
      });
      await runDurableObjectAlarm(controlPlane);
    }

    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ operation: string; providerAttempts: number; providerRetryAt: number | null }>(
            `SELECT provider_attempts AS providerAttempts,
               provider_operation AS operation,
               provider_retry_at AS providerRetryAt
             FROM agent_event_triggers
             WHERE event_trigger_id = ?`,
            reserved.pending.eventTriggerId,
          )
          .one(),
      ),
    ).resolves.toEqual({
      operation: "creating",
      providerAttempts: 5,
      providerRetryAt: null,
    });

    const configured = await controlPlane.agentEventTriggers(authority, createInput);

    expect(configured).toMatchObject({
      action: "create",
      changed: true,
      ok: true,
      eventTrigger: {
        id: expect.stringMatching(/^event_trigger_/),
        revision: 1,
      },
    });

    if (!configured.ok || !("eventTrigger" in configured)) {
      throw new Error("Expected configured Composio Event Trigger.");
    }

    await expect(
      controlPlane.agentEventTriggers(authority, {
        action: "update",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedEventTriggerRevision: configured.eventTrigger.revision,
        idempotencyKey: "retarget-composio-eventTrigger",
        eventTrigger: {
          ...createInput.eventTrigger,
          source: {
            ...createInput.eventTrigger.source,
            configuration: { repo: "another-repository" },
          },
        },
        eventTriggerId: configured.eventTrigger.id,
      }),
    ).resolves.toMatchObject({ error: { code: "invalid_request" }, ok: false });

    await runInDurableObject(
      env.CREW_AGENT.getByName(
        crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewAgent)) {
          throw new Error("Expected Composio Event Trigger test Agent.");
        }

        instance.enableDurableSessionsForTest();
      },
    );

    const timestamp = String(Math.floor(Date.now() / 1_000));
    const webhookId = "webhook_issue_event_trigger";
    const eventBodyFor = (
      eventId: string,
      triggerId = "ti_issue_event_trigger",
      data: Record<string, unknown> = {
        issue: { id: "issue-42", title: "One exact issue" },
      },
    ) =>
      new TextEncoder().encode(
        JSON.stringify({
          data,
          id: eventId,
          metadata: {
            auth_config_id: "ac_event_trigger_github",
            connected_account_id: "ca_event_trigger_github",
            log_id: eventId,
            trigger_id: triggerId,
            trigger_slug: "GITHUB_ISSUE_CREATED",
            user_id: authority.ownerKey,
          },
          timestamp: new Date(Number(timestamp) * 1_000).toISOString(),
          type: "composio.trigger.message",
        }),
      );
    const eventBody = eventBodyFor("event_issue_42");
    const signature = await signComposioWebhook(eventBody, webhookId, timestamp, webhookSecret);
    const deliver = () =>
      ingress.receiveComposioWebhook({
        body: eventBody,
        headers: { id: webhookId, signature, timestamp },
      });

    const irrelevantBody = eventBodyFor("event_irrelevant", "ti_deleted_event_trigger");
    const irrelevantSignature = await signComposioWebhook(
      irrelevantBody,
      "webhook_irrelevant",
      timestamp,
      webhookSecret,
    );
    await expect(
      ingress.receiveComposioWebhook({
        body: irrelevantBody,
        headers: {
          id: "webhook_irrelevant",
          signature: irrelevantSignature,
          timestamp,
        },
      }),
    ).resolves.toEqual({ ok: true });

    const unsupportedBody = new TextEncoder().encode(
      JSON.stringify({ data: {}, type: "composio.connected_account.expired" }),
    );
    const unsupportedSignature = await signComposioWebhook(
      unsupportedBody,
      "webhook_unsupported",
      timestamp,
      webhookSecret,
    );
    await expect(
      ingress.receiveComposioWebhook({
        body: unsupportedBody,
        headers: {
          id: "webhook_unsupported",
          signature: unsupportedSignature,
          timestamp,
        },
      }),
    ).resolves.toEqual({ ok: true });

    await runInDurableObject(ingress, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE composio_event_trigger_webhook SET updated_at = ? WHERE singleton = 1",
        Date.now() - 61_000,
      );
      await state.storage.delete("composio-webhook-refresh-not-before");
    });
    const providerCallsBeforeInvalid = webhookSubscriptionReads + webhookSubscriptionWrites;
    const invalidDelivery = () =>
      ingress.receiveComposioWebhook({
        body: eventBody,
        headers: { id: webhookId, signature: "v1,invalid-signature", timestamp },
      });
    await expect(invalidDelivery()).resolves.toEqual({ error: "invalid_webhook", ok: false });
    const providerCallsAfterInvalid = webhookSubscriptionReads + webhookSubscriptionWrites;
    expect(providerCallsAfterInvalid).toBe(providerCallsBeforeInvalid + 2);
    await expect(invalidDelivery()).resolves.toEqual({ error: "invalid_webhook", ok: false });
    expect(webhookSubscriptionReads + webhookSubscriptionWrites).toBe(providerCallsAfterInvalid);

    await expect(deliver()).resolves.toMatchObject({ ok: true });
    await expect(deliver()).resolves.toMatchObject({ ok: true });
    for (let index = 2; index <= 22; index += 1) {
      const queuedBody = eventBodyFor(`event_issue_${index}`);
      const queuedWebhookId = `webhook_issue_${index}`;
      const queuedSignature = await signComposioWebhook(
        queuedBody,
        queuedWebhookId,
        timestamp,
        webhookSecret,
      );
      await expect(
        ingress.receiveComposioWebhook({
          body: queuedBody,
          headers: { id: queuedWebhookId, signature: queuedSignature, timestamp },
        }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      runInDurableObject(controlPlane, async (_instance, state) => {
        const counts = state.storage.sql
          .exec<{ count: number; status: string }>(
            `SELECT status, COUNT(*) AS count
             FROM agent_event_trigger_occurrences
             WHERE event_trigger_id = ?
             GROUP BY status
             ORDER BY status`,
            configured.eventTrigger.id,
          )
          .toArray();
        const queuedAlarm = await state.storage.getAlarm();
        state.storage.sql.exec(
          `DELETE FROM agent_event_trigger_occurrences
           WHERE event_trigger_id = ? AND event_id != 'event_issue_42'`,
          configured.eventTrigger.id,
        );
        return { counts, queuedAlarm };
      }),
    ).resolves.toMatchObject({
      counts: [
        { count: 20, status: "pending" },
        { count: 2, status: "skipped" },
      ],
      queuedAlarm: expect.any(Number),
    });

    for (let index = 1; index <= 7; index += 1) {
      const queuedBody = eventBodyFor(`event_bytes_${index}`, "ti_issue_event_trigger", {
        text: "é".repeat(10_000),
      });
      const queuedWebhookId = `webhook_bytes_${index}`;
      const queuedSignature = await signComposioWebhook(
        queuedBody,
        queuedWebhookId,
        timestamp,
        webhookSecret,
      );
      await expect(
        ingress.receiveComposioWebhook({
          body: queuedBody,
          headers: { id: queuedWebhookId, signature: queuedSignature, timestamp },
        }),
      ).resolves.toEqual({ ok: true });
    }
    await expect(
      runInDurableObject(controlPlane, (_instance, state) => {
        const counts = state.storage.sql
          .exec<{ count: number; status: string }>(
            `SELECT status, COUNT(*) AS count
             FROM agent_event_trigger_occurrences
             WHERE event_trigger_id = ? AND event_id LIKE 'event_bytes_%'
             GROUP BY status
             ORDER BY status`,
            configured.eventTrigger.id,
          )
          .toArray();
        state.storage.sql.exec(
          `DELETE FROM agent_event_trigger_occurrences
           WHERE event_trigger_id = ? AND event_id LIKE 'event_bytes_%'`,
          configured.eventTrigger.id,
        );
        return counts;
      }),
    ).resolves.toEqual([
      { count: 6, status: "pending" },
      { count: 1, status: "skipped" },
    ]);
    await runDurableObjectAlarm(controlPlane);

    await vi.waitFor(
      async () => {
        const durableDispatch = await runInDurableObject(controlPlane, (_instance, state) =>
          state.storage.sql
            .exec<{
              lastRunId: string | null;
              occurrenceData: string;
              occurrenceRunId: string | null;
              occurrenceStatus: string;
              providerOperation: string;
            }>(
              `SELECT w.last_run_id AS lastRunId,
                 w.provider_operation AS providerOperation,
                 o.event_data AS occurrenceData,
                 o.run_id AS occurrenceRunId,
                 o.status AS occurrenceStatus
               FROM agent_event_triggers w
               INNER JOIN agent_event_trigger_occurrences o ON o.event_trigger_id = w.event_trigger_id
               WHERE w.event_trigger_id = ?`,
              configured.eventTrigger.id,
            )
            .one(),
        );
        expect(durableDispatch).toMatchObject({
          lastRunId: expect.stringMatching(/^run_/),
          occurrenceData: "{}",
          occurrenceRunId: expect.stringMatching(/^run_/),
          occurrenceStatus: "dispatched",
          providerOperation: "stable",
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    const history = await controlPlane.agentEventTriggers(authority, {
      action: "history",
      agentId: created.agent.id,
      limit: 10,
      eventTriggerId: configured.eventTrigger.id,
    });

    expect(history).toMatchObject({
      action: "history",
      occurrences: [
        {
          eventId: "event_issue_42",
          outcome: "dispatched",
          eventTriggerRevision: 1,
        },
      ],
      ok: true,
    });

    if (!history.ok || !("occurrences" in history) || history.occurrences[0]?.runId === null) {
      throw new Error("Expected dispatched Composio Event Trigger history.");
    }

    const runId = history.occurrences[0]?.runId;

    if (runId === undefined) {
      throw new Error("Expected dispatched Composio Event Trigger Run.");
    }

    const dispatchedRun = await controlPlane.inspectRun(authority, { runId });
    expect(dispatchedRun).toMatchObject({
      briefs: [{ id: brief.brief.id, revision: brief.version.revision }],
      ok: true,
      run: {
        runId,
        trigger: "event_trigger",
        eventTrigger: {
          eventId: "event_issue_42",
          id: configured.eventTrigger.id,
          revision: 1,
        },
      },
    });
    expect(dispatchedRun.ok ? dispatchedRun.run : {}).not.toHaveProperty("schedule");
    await expect(
      controlPlane.deleteBrief(authority, {
        expectedRevision: brief.version.revision,
        id: brief.brief.id,
        idempotencyKey: "delete-event-trigger-brief",
      }),
    ).resolves.toMatchObject({ error: { code: "brief_busy" }, ok: false });

    await vi.waitFor(
      async () => {
        const inbox = await controlPlane.agentInbox(authority, {
          action: "list",
          agentId: created.agent.id,
          includeAcknowledged: true,
          kinds: ["outcome"],
          limit: 1,
        });

        expect(inbox).toMatchObject({
          action: "list",
          items: [{ runId }],
          ok: true,
        });

        if (!inbox.ok || inbox.action !== "list" || inbox.items[0] === undefined) {
          throw new Error("Expected Composio Event Trigger inbox outcome.");
        }

        expect(inbox.items[0].configuration).toMatchObject({
          scheduleId: null,
          scheduleRevision: null,
          eventTrigger: {
            eventId: "event_issue_42",
            id: configured.eventTrigger.id,
            revision: 1,
          },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    const readWithoutConnections = {
      ...authority,
      scopes: authority.scopes.filter((scope) => scope !== CONNECTIONS_READ_SCOPE),
    };
    await expect(
      controlPlane.agentEventTriggers(readWithoutConnections, {
        action: "list",
        agentId: created.agent.id,
      }),
    ).resolves.toEqual({
      error: { code: "insufficient_scope", message: "Agent Event Trigger request denied." },
      ok: false,
    });

    const pauseInput = {
      action: "pause" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedEventTriggerRevision: configured.eventTrigger.revision,
      idempotencyKey: "pause-composio-eventTrigger",
      eventTriggerId: configured.eventTrigger.id,
    };
    const paused = await controlPlane.agentEventTriggers(authority, pauseInput);

    expect(paused).toMatchObject({
      action: "pause",
      changed: true,
      ok: true,
      eventTrigger: { revision: 2, status: "paused" },
    });
    await expect(controlPlane.agentEventTriggers(authority, pauseInput)).resolves.toMatchObject({
      action: "pause",
      changed: false,
      ok: true,
    });

    if (!paused.ok || !("eventTrigger" in paused)) {
      throw new Error("Expected paused Composio Event Trigger.");
    }

    const resumed = await controlPlane.agentEventTriggers(authority, {
      action: "resume",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedEventTriggerRevision: paused.eventTrigger.revision,
      idempotencyKey: "resume-composio-eventTrigger",
      eventTriggerId: paused.eventTrigger.id,
    });

    expect(resumed).toMatchObject({
      action: "resume",
      changed: true,
      ok: true,
      eventTrigger: { revision: 3, status: "active" },
    });

    if (!resumed.ok || !("eventTrigger" in resumed)) {
      throw new Error("Expected resumed Composio Event Trigger.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE agent_event_triggers
         SET provider_trigger_id = NULL,
             provider_operation = 'creating',
             provider_attempts = 5,
             provider_retry_at = NULL
         WHERE event_trigger_id = ?`,
        resumed.eventTrigger.id,
      );
    });
    await expect(
      controlPlane.batchDisableAgents(authority, {
        agents: [{ agentId: created.agent.id, expectedRevision: created.agent.revision }],
      }),
    ).resolves.toMatchObject({
      ok: true,
      receipts: [{ outcome: "disabled" }],
    });

    await expect(
      controlPlane.agentEventTriggers(authority, {
        action: "delete",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedEventTriggerRevision: resumed.eventTrigger.revision,
        idempotencyKey: "delete-composio-eventTrigger",
        eventTriggerId: resumed.eventTrigger.id,
      }),
    ).resolves.toMatchObject({ error: { code: "event_trigger_operation_unknown" }, ok: false });

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await runInDurableObject(controlPlane, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE agent_event_triggers
           SET provider_retry_at = ?
           WHERE event_trigger_id = ?`,
          Date.now() - 1,
          resumed.eventTrigger.id,
        );
      });
      await runDurableObjectAlarm(controlPlane);
    }

    expect(activeTriggerLookups).toBe(5);
    await expect(
      controlPlane.agentEventTriggers(authority, {
        action: "inspect",
        agentId: created.agent.id,
        eventTriggerId: resumed.eventTrigger.id,
      }),
    ).resolves.toMatchObject({ error: { code: "event_trigger_not_found" }, ok: false });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ definitions: number }>(
            `SELECT count(definition) AS definitions
             FROM agent_event_trigger_revisions
             WHERE event_trigger_id = ?`,
            resumed.eventTrigger.id,
          )
          .one(),
      ),
    ).resolves.toEqual({ definitions: 0 });
    fetchMock.mockRestore();
  });

  it("reserves one shared capacity budget across Event Triggers and Schedules", async () => {
    const authority = await authorityFor("eventTrigger-shared-capacity-owner", [
      ...EVENT_TRIGGER_SCOPES,
    ]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("eventTrigger-shared-capacity-agent", "Shared Event Trigger capacity Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected shared Event Trigger capacity Agent fixture.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      const now = Date.now();
      const connectionId = "connection_87654321-4321-4321-8321-123456789abc";
      state.storage.sql.exec(
        `INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, account_label,
            status, created_at, revoked_at)
         VALUES (?, 'composio', 'ca_capacity', 'ac_capacity', 'Capacity fixture',
            'active', ?, NULL)`,
        connectionId,
        now,
      );

      for (let index = 1; index <= 8; index += 1) {
        const eventTriggerId = `event_trigger_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const sourceSlug = `GITHUB_CAPACITY_EVENT_${index}`;
        state.storage.sql.exec(
          `INSERT INTO agent_event_trigger_revisions
            (event_trigger_id, agent_id, revision, agent_revision, definition, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
          eventTriggerId,
          created.agent.id,
          created.agent.revision,
          JSON.stringify({
            instruction: "Capacity fixture.",
            name: `Capacity event ${index}`,
            source: {
              configuration: {},
              connectionId,
              delivery: "realtime",
              integrationSlug: "github",
              kind: "connection_event",
              sourceSlug,
              sourceVersion: "20260802_00",
            },
          }),
          now,
        );
        state.storage.sql.exec(
          `INSERT INTO agent_event_triggers
            (event_trigger_id, agent_id, current_revision, connection_id, source_slug, status,
              provider_trigger_id, provider_operation, provider_attempts, provider_retry_at,
              created_at)
           VALUES (?, ?, 1, ?, ?, 'active', ?, 'stable', 0, NULL, ?)`,
          eventTriggerId,
          created.agent.id,
          connectionId,
          sourceSlug,
          `ti_capacity_${index}`,
          now,
        );
      }
    });

    await expect(
      controlPlane.configureAgentSchedule(authority, {
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedScheduleRevision: null,
        idempotencyKey: "shared-capacity-schedule",
        schedule: {
          name: "Capacity schedule",
          prompt: "Check capacity.",
          trigger: { intervalSeconds: 600, type: "interval" },
        },
        scheduleId: null,
      }),
    ).resolves.toMatchObject({ error: { code: "schedule_limit_exceeded" }, ok: false });
  });
});
