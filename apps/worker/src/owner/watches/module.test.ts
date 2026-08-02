import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES,
  crewAgentObjectName,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
} from "@crewhelm/contracts";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it, vi } from "vitest";

import { TestCrewAgent } from "../../agent/admitted-runs/test-agent.js";
import { AgentSchedules } from "../schedules/index.js";
import { controlPlaneSchema } from "../schema.js";
import { agentInput, authorityFor } from "../testkit.js";
import { COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME } from "./composio-ingress.js";

const WATCH_SCOPES = [
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

describe("OwnerControlPlane Agent Watches", () => {
  it("turns one signed Composio event into one duplicate-safe Watch Run", async () => {
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
            id: "subscription_watch",
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

        return composioJson({ trigger_id: "ti_issue_watch" }, 201);
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
                    connected_account_id: "ca_watch_github",
                    id: "ti_issue_watch",
                    trigger_config: { repo: "crewhelm" },
                    trigger_name: "GITHUB_ISSUE_CREATED",
                    user_id: endpoint.searchParams.get("user_ids"),
                    version: "20260802_00",
                  },
                ],
          next_cursor: null,
        });
      }

      if (url.endsWith("/manage/ti_issue_watch") && method === "PATCH") {
        return composioJson({ status: "success" });
      }

      if (url.endsWith("/manage/ti_issue_watch") && method === "DELETE") {
        return composioJson({ trigger_id: "ti_issue_watch" });
      }

      throw new Error(`Unexpected Composio request: ${method} ${url}`);
    });
    const authority = await authorityFor("watch-composio-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const ingress = env.OWNER_CONTROL_PLANE.getByName(COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-composio-agent", "Composio Watch Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Composio Watch Agent fixture.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      const now = Date.now();
      const connectionId = "connection_12345678-1234-4123-8123-123456789abc";
      state.storage.sql.exec(
        `INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, account_label,
            status, created_at, revoked_at)
         VALUES (?, 'composio', 'ca_watch_github', 'ac_watch_github', 'GitHub test',
            'active', ?, NULL)`,
        connectionId,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO integration_enablement_requests
          (client_id, idempotency_key, request_digest, integration_slug, reservation_id,
            status, recover_after, auth_config_id, auth_scheme, created_at, completed_at)
         VALUES ('watch-fixture', 'enable-github', ?, 'github', 'integration_enablement_fixture',
            'completed', ?, 'ac_watch_github', 'oauth2', ?, ?)`,
        "d".repeat(43),
        now + 60_000,
        now,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO connection_link_requests
          (client_id, idempotency_key, request_digest, auth_config_id, reservation_id, status,
            recover_after, connection_id, redirect_url, expires_at, created_at, completed_at)
         VALUES ('watch-fixture', 'link-github', ?, 'ac_watch_github', 'connection_link_fixture',
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
      controlPlane.agentWatches(
        { ...authority, scopes: [OWNER_READ_SCOPE] },
        { action: "sources", connectionId },
      ),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      controlPlane.agentWatches(authority, { action: "sources", connectionId }),
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
      idempotencyKey: "create-composio-watch",
      watch: {
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
    await expect(controlPlane.agentWatches(authority, createInput)).resolves.toMatchObject({
      error: { code: "watch_limit_exceeded" },
      ok: false,
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agent_schedules WHERE agent_id = ?", created.agent.id);
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_revisions WHERE agent_id = ?",
        created.agent.id,
      );
    });

    await expect(controlPlane.agentWatches(authority, createInput)).resolves.toMatchObject({
      error: { code: "watch_operation_unknown" },
      ok: false,
    });

    const pending = await runInDurableObject(controlPlane, (_instance, state) =>
      state.storage.sql
        .exec<{ providerAttempts: number; watchId: string }>(
          `SELECT provider_attempts AS providerAttempts, watch_id AS watchId
           FROM agent_event_watches
           WHERE agent_id = ?`,
          created.agent.id,
        )
        .one(),
    );
    const webhook = await runInDurableObject(ingress, (_instance, state) =>
      state.storage.sql
        .exec<{ secretCiphertext: string; secretNonce: string }>(
          `SELECT secret_ciphertext AS secretCiphertext, secret_nonce AS secretNonce
           FROM composio_watch_webhook
           WHERE singleton = 1`,
        )
        .one(),
    );
    const reserved = { pending, webhook };

    expect(reserved).toMatchObject({
      pending: { providerAttempts: 1, watchId: expect.stringMatching(/^watch_/) },
      webhook: {
        secretCiphertext: expect.any(String),
        secretNonce: expect.any(String),
      },
    });
    expect(reserved.webhook.secretCiphertext).not.toContain(webhookSecret);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await runInDurableObject(controlPlane, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE agent_event_watches
           SET provider_retry_at = ?
           WHERE watch_id = ?`,
          Date.now() - 1,
          reserved.pending.watchId,
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
             FROM agent_event_watches
             WHERE watch_id = ?`,
            reserved.pending.watchId,
          )
          .one(),
      ),
    ).resolves.toEqual({
      operation: "creating",
      providerAttempts: 5,
      providerRetryAt: null,
    });

    const configured = await controlPlane.agentWatches(authority, createInput);

    expect(configured).toMatchObject({
      action: "create",
      changed: true,
      ok: true,
      watch: { id: expect.stringMatching(/^watch_/), nextCheckAt: null, revision: 1 },
    });

    if (!configured.ok || !("watch" in configured)) {
      throw new Error("Expected configured Composio Watch.");
    }

    await expect(
      controlPlane.agentWatches(authority, {
        action: "update",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: configured.watch.revision,
        idempotencyKey: "retarget-composio-watch",
        watch: {
          ...createInput.watch,
          source: { ...createInput.watch.source, configuration: { repo: "another-repository" } },
        },
        watchId: configured.watch.id,
      }),
    ).resolves.toMatchObject({ error: { code: "invalid_request" }, ok: false });

    await runInDurableObject(
      env.CREW_AGENT.getByName(
        crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewAgent)) {
          throw new Error("Expected Composio Watch test Agent.");
        }

        instance.enableDurableSessionsForTest();
      },
    );

    const timestamp = String(Math.floor(Date.now() / 1_000));
    const webhookId = "webhook_issue_watch";
    const eventBodyFor = (
      eventId: string,
      triggerId = "ti_issue_watch",
      data: Record<string, unknown> = {
        issue: { id: "issue-42", title: "One exact issue" },
      },
    ) =>
      new TextEncoder().encode(
        JSON.stringify({
          data,
          id: eventId,
          metadata: {
            auth_config_id: "ac_watch_github",
            connected_account_id: "ca_watch_github",
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

    const irrelevantBody = eventBodyFor("event_irrelevant", "ti_deleted_watch");
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
        "UPDATE composio_watch_webhook SET updated_at = ? WHERE singleton = 1",
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
             FROM agent_event_watch_occurrences
             WHERE watch_id = ?
             GROUP BY status
             ORDER BY status`,
            configured.watch.id,
          )
          .toArray();
        const queuedAlarm = await state.storage.getAlarm();
        state.storage.sql.exec(
          `DELETE FROM agent_event_watch_occurrences
           WHERE watch_id = ? AND event_id != 'event_issue_42'`,
          configured.watch.id,
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
      const queuedBody = eventBodyFor(`event_bytes_${index}`, "ti_issue_watch", {
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
             FROM agent_event_watch_occurrences
             WHERE watch_id = ? AND event_id LIKE 'event_bytes_%'
             GROUP BY status
             ORDER BY status`,
            configured.watch.id,
          )
          .toArray();
        state.storage.sql.exec(
          `DELETE FROM agent_event_watch_occurrences
           WHERE watch_id = ? AND event_id LIKE 'event_bytes_%'`,
          configured.watch.id,
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
               FROM agent_event_watches w
               INNER JOIN agent_event_watch_occurrences o ON o.watch_id = w.watch_id
               WHERE w.watch_id = ?`,
              configured.watch.id,
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

    const history = await controlPlane.agentWatches(authority, {
      action: "history",
      agentId: created.agent.id,
      limit: 10,
      watchId: configured.watch.id,
    });

    expect(history).toMatchObject({
      action: "history",
      occurrences: [
        {
          eventId: "event_issue_42",
          outcome: "dispatched",
          sourceKind: "connection_event",
          watchRevision: 1,
        },
      ],
      ok: true,
    });

    if (!history.ok || !("occurrences" in history) || history.occurrences[0]?.runId === null) {
      throw new Error("Expected dispatched Composio Watch history.");
    }

    const runId = history.occurrences[0]?.runId;

    if (runId === undefined) {
      throw new Error("Expected dispatched Composio Watch Run.");
    }

    const dispatchedRun = await controlPlane.inspectRun(authority, { runId });
    expect(dispatchedRun).toMatchObject({
      ok: true,
      run: {
        runId,
        trigger: "watch",
        watch: {
          eventId: "event_issue_42",
          id: configured.watch.id,
          revision: 1,
          sourceKind: "connection_event",
        },
      },
    });
    expect(dispatchedRun.ok ? dispatchedRun.run : {}).not.toHaveProperty("schedule");

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
          throw new Error("Expected Composio Watch inbox outcome.");
        }

        expect(inbox.items[0].configuration).toMatchObject({
          scheduleId: null,
          scheduleRevision: null,
          watch: {
            eventId: "event_issue_42",
            id: configured.watch.id,
            revision: 1,
            sourceKind: "connection_event",
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
      controlPlane.agentWatches(readWithoutConnections, {
        action: "list",
        agentId: created.agent.id,
      }),
    ).resolves.toMatchObject({ action: "list", ok: true, watches: [] });

    const pauseInput = {
      action: "pause" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: configured.watch.revision,
      idempotencyKey: "pause-composio-watch",
      watchId: configured.watch.id,
    };
    const paused = await controlPlane.agentWatches(authority, pauseInput);

    expect(paused).toMatchObject({
      action: "pause",
      changed: true,
      ok: true,
      watch: { revision: 2, status: "paused" },
    });
    await expect(controlPlane.agentWatches(authority, pauseInput)).resolves.toMatchObject({
      action: "pause",
      changed: false,
      ok: true,
    });

    if (!paused.ok || !("watch" in paused)) {
      throw new Error("Expected paused Composio Watch.");
    }

    const resumed = await controlPlane.agentWatches(authority, {
      action: "resume",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: paused.watch.revision,
      idempotencyKey: "resume-composio-watch",
      watchId: paused.watch.id,
    });

    expect(resumed).toMatchObject({
      action: "resume",
      changed: true,
      ok: true,
      watch: { revision: 3, status: "active" },
    });

    if (!resumed.ok || !("watch" in resumed)) {
      throw new Error("Expected resumed Composio Watch.");
    }

    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE agent_event_watches
         SET provider_trigger_id = NULL,
             provider_operation = 'creating',
             provider_attempts = 5,
             provider_retry_at = NULL
         WHERE watch_id = ?`,
        resumed.watch.id,
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
      controlPlane.agentWatches(authority, {
        action: "delete",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: resumed.watch.revision,
        idempotencyKey: "delete-composio-watch",
        watchId: resumed.watch.id,
      }),
    ).resolves.toMatchObject({ error: { code: "watch_operation_unknown" }, ok: false });

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await runInDurableObject(controlPlane, (_instance, state) => {
        state.storage.sql.exec(
          `UPDATE agent_event_watches
           SET provider_retry_at = ?
           WHERE watch_id = ?`,
          Date.now() - 1,
          resumed.watch.id,
        );
      });
      await runDurableObjectAlarm(controlPlane);
    }

    expect(activeTriggerLookups).toBe(5);
    await expect(
      controlPlane.agentWatches(authority, {
        action: "inspect",
        agentId: created.agent.id,
        watchId: resumed.watch.id,
      }),
    ).resolves.toMatchObject({ error: { code: "watch_not_found" }, ok: false });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ definitions: number }>(
            `SELECT count(definition) AS definitions
             FROM agent_event_watch_revisions
             WHERE watch_id = ?`,
            resumed.watch.id,
          )
          .one(),
      ),
    ).resolves.toEqual({ definitions: 0 });
    fetchMock.mockRestore();
  });

  it("reserves one shared capacity budget across connected and scheduled Watches", async () => {
    const authority = await authorityFor("watch-shared-capacity-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-shared-capacity-agent", "Shared Watch capacity Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected shared Watch capacity Agent fixture.");
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
        const watchId = `watch_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const sourceSlug = `GITHUB_CAPACITY_EVENT_${index}`;
        state.storage.sql.exec(
          `INSERT INTO agent_event_watch_revisions
            (watch_id, agent_id, revision, agent_revision, definition, created_at)
           VALUES (?, ?, 1, ?, ?, ?)`,
          watchId,
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
          `INSERT INTO agent_event_watches
            (watch_id, agent_id, current_revision, connection_id, source_slug, status,
              provider_trigger_id, provider_operation, provider_attempts, provider_retry_at,
              created_at)
           VALUES (?, ?, 1, ?, ?, 'active', ?, 'stable', 0, NULL, ?)`,
          watchId,
          created.agent.id,
          connectionId,
          sourceSlug,
          `ti_capacity_${index}`,
          now,
        );
      }
    });

    await expect(
      controlPlane.agentWatches(authority, {
        action: "create",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        idempotencyKey: "shared-capacity-scheduled-watch",
        watch: {
          instruction: "Check capacity.",
          name: "Capacity schedule",
          source: { kind: "scheduled_check", trigger: { intervalSeconds: 600, type: "interval" } },
        },
      }),
    ).resolves.toMatchObject({ error: { code: "watch_limit_exceeded" }, ok: false });
  });

  it("presents scheduled checks as a plain lifecycle with exact replay and deletion", async () => {
    const authority = await authorityFor("watch-lifecycle-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-lifecycle-agent", "Watch lifecycle Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Watch lifecycle Agent fixture.");
    }

    await expect(controlPlane.agentWatches(authority, { action: "sources" })).resolves.toEqual({
      action: "sources",
      ok: true,
      sources: [
        expect.objectContaining({
          description: expect.stringContaining("no webhook or bearer token"),
          id: "scheduled_check",
          kind: "scheduled_check",
          limits: expect.objectContaining({
            minimumEveryMinutes: 1,
            retainedOccurrences: MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES,
          }),
          name: "Scheduled check",
        }),
      ],
    });

    const createInput = {
      action: "create" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      idempotencyKey: "create-inbox-watch",
      watch: {
        instruction: "Check the approved inbox and report only work that needs attention.",
        name: "Inbox attention",
        source: {
          kind: "scheduled_check" as const,
          trigger: { intervalSeconds: 600, type: "interval" as const },
        },
      },
    };
    const configured = await controlPlane.agentWatches(authority, createInput);

    expect(configured).toMatchObject({
      action: "create",
      changed: true,
      ok: true,
      watch: {
        definition: createInput.watch,
        id: expect.stringMatching(/^schedule_/),
        nextCheckAt: expect.any(String),
        revision: 1,
        status: "active",
      },
    });
    await expect(controlPlane.agentWatches(authority, createInput)).resolves.toMatchObject({
      action: "create",
      changed: false,
      ok: true,
      watch: { revision: 1 },
    });

    if (!configured.ok || !("watch" in configured)) {
      throw new Error("Expected configured Watch fixture.");
    }

    const watchId = configured.watch.id;
    const updatedDefinition = {
      instruction: "Check the approved inbox and return a prioritized attention list.",
      name: "Prioritized inbox attention",
      source: {
        kind: "scheduled_check" as const,
        trigger: { intervalSeconds: 1_200, type: "interval" as const },
      },
    };
    const updated = await controlPlane.agentWatches(authority, {
      action: "update",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: configured.watch.revision,
      idempotencyKey: "update-inbox-watch",
      watch: updatedDefinition,
      watchId,
    });

    expect(updated).toMatchObject({
      action: "update",
      changed: true,
      ok: true,
      watch: { definition: updatedDefinition, revision: 2, status: "active" },
    });

    if (!updated.ok || !("watch" in updated)) {
      throw new Error("Expected updated Watch fixture.");
    }

    const pendingScheduledAt = Date.now();
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        watchId,
        created.agent.id,
        updated.watch.revision,
        pendingScheduledAt,
        pendingScheduledAt,
        pendingScheduledAt + 60_000,
      );
    });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "pause",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: updated.watch.revision,
        idempotencyKey: "pause-busy-inbox-watch",
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_busy", message: "Agent Watch request denied." },
      ok: false,
    });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "delete",
        agentId: created.agent.id,
        expectedAgentRevision: created.agent.revision,
        expectedWatchRevision: updated.watch.revision,
        idempotencyKey: "delete-busy-inbox-watch",
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_busy", message: "Agent Watch request denied." },
      ok: false,
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_occurrences WHERE schedule_id = ? AND scheduled_at = ?",
        watchId,
        pendingScheduledAt,
      );
    });

    const paused = await controlPlane.agentWatches(authority, {
      action: "pause",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: updated.watch.revision,
      idempotencyKey: "pause-inbox-watch",
      watchId,
    });

    expect(paused).toMatchObject({
      action: "pause",
      changed: true,
      ok: true,
      watch: {
        definition: updatedDefinition,
        nextCheckAt: null,
        revision: 3,
        status: "paused",
      },
    });

    if (!paused.ok || !("watch" in paused)) {
      throw new Error("Expected paused Watch fixture.");
    }

    const resumed = await controlPlane.agentWatches(authority, {
      action: "resume",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: paused.watch.revision,
      idempotencyKey: "resume-inbox-watch",
      watchId,
    });

    expect(resumed).toMatchObject({
      action: "resume",
      changed: true,
      ok: true,
      watch: {
        definition: updatedDefinition,
        nextCheckAt: expect.any(String),
        revision: 4,
        status: "active",
      },
    });

    if (!resumed.ok || !("watch" in resumed)) {
      throw new Error("Expected resumed Watch fixture.");
    }

    const deleteInput = {
      action: "delete" as const,
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      expectedWatchRevision: resumed.watch.revision,
      idempotencyKey: "delete-inbox-watch",
      watchId,
    };

    await expect(controlPlane.agentWatches(authority, deleteInput)).resolves.toEqual({
      action: "delete",
      deleted: true,
      ok: true,
      watchId,
    });
    await expect(controlPlane.agentWatches(authority, deleteInput)).resolves.toEqual({
      action: "delete",
      deleted: false,
      ok: true,
      watchId,
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ definitions: number; names: number }>(
            `SELECT
               sum(CASE WHEN configuration IS NOT NULL THEN 1 ELSE 0 END) AS definitions,
               sum(CASE WHEN name <> 'Deleted Watch' THEN 1 ELSE 0 END) AS names
             FROM agent_schedule_revisions
             WHERE schedule_id = ?`,
            watchId,
          )
          .one(),
      ),
    ).resolves.toEqual({ definitions: 0, names: 0 });
    await expect(
      controlPlane.agentWatches(authority, {
        action: "inspect",
        agentId: created.agent.id,
        watchId,
      }),
    ).resolves.toEqual({
      error: { code: "watch_not_found", message: "Agent Watch request denied." },
      ok: false,
    });
  });

  it("records one duplicate-safe occurrence and exposes its dispatched Run", async () => {
    const authority = await authorityFor("watch-occurrence-owner", [...WATCH_SCOPES]);
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await controlPlane.createAgent(
      authority,
      agentInput("watch-occurrence-agent", "Watch occurrence Agent"),
    );

    if (!created.ok) {
      throw new Error("Expected Watch occurrence Agent fixture.");
    }

    await runInDurableObject(
      env.CREW_AGENT.getByName(
        crewAgentObjectName({ agentId: created.agent.id, ownerKey: authority.ownerKey }),
      ),
      (instance) => {
        if (!(instance instanceof TestCrewAgent)) {
          throw new Error("Expected Watch occurrence test Agent.");
        }

        instance.enableDurableSessionsForTest();
      },
    );

    const configured = await controlPlane.agentWatches(authority, {
      action: "create",
      agentId: created.agent.id,
      expectedAgentRevision: created.agent.revision,
      idempotencyKey: "create-occurrence-watch",
      watch: {
        instruction: "Check for new work and return a concise summary.",
        name: "New work",
        source: {
          kind: "scheduled_check",
          trigger: { intervalSeconds: 60, type: "interval" },
        },
      },
    });

    if (!configured.ok || !("watch" in configured)) {
      throw new Error("Expected occurrence Watch fixture.");
    }

    await runInDurableObject(controlPlane, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        Date.now() - 1,
        configured.watch.id,
      );
    });
    await runDurableObjectAlarm(controlPlane);

    const history = await vi.waitFor(
      async () => {
        const result = await controlPlane.agentWatches(authority, {
          action: "history",
          agentId: created.agent.id,
          limit: 10,
          watchId: configured.watch.id,
        });

        expect(result).toMatchObject({
          action: "history",
          occurrences: [
            {
              outcome: "dispatched",
              reason: null,
              runId: expect.stringMatching(/^run_/),
              watchRevision: configured.watch.revision,
            },
          ],
          ok: true,
        });
        return result;
      },
      { interval: 25, timeout: 5_000 },
    );

    if (!history.ok || !("occurrences" in history)) {
      throw new Error("Expected Watch occurrence history.");
    }

    const runId = history.occurrences[0]?.runId;
    if (runId === null || runId === undefined) {
      throw new Error("Expected Watch Run identity.");
    }

    await expect(controlPlane.inspectRun(authority, { runId })).resolves.toMatchObject({
      ok: true,
      run: {
        runId,
        schedule: { id: configured.watch.id, revision: configured.watch.revision },
        trigger: "schedule",
      },
    });

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, { runId });
        expect(inspected).toMatchObject({
          ok: true,
          run: { status: expect.stringMatching(/^(?:cancelled|completed|failed)$/) },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    const recoveredScheduledAt = Date.now() - 2;
    await runInDurableObject(controlPlane, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        configured.watch.id,
        created.agent.id,
        configured.watch.revision,
        recoveredScheduledAt,
        recoveredScheduledAt,
        Date.now() - 1,
      );
      await state.storage.setAlarm(Date.now() - 1);
    });
    await runDurableObjectAlarm(controlPlane);

    const recovered = await vi.waitFor(
      async () => {
        const result = await controlPlane.agentWatches(authority, {
          action: "history",
          agentId: created.agent.id,
          limit: 10,
          watchId: configured.watch.id,
        });

        if (!result.ok || result.action !== "history") {
          throw new Error("Expected recovered Watch history.");
        }
        expect(result.occurrences.filter(({ outcome }) => outcome === "dispatched")).toHaveLength(
          2,
        );
        expect(result.occurrences.filter(({ outcome }) => outcome === "pending")).toHaveLength(0);
        expect(result.occurrences).toHaveLength(2);
        return result;
      },
      { interval: 25, timeout: 5_000 },
    );

    if (!recovered.ok || !("occurrences" in recovered)) {
      throw new Error("Expected recovered Watch occurrence.");
    }

    const recoveredRunId = recovered.occurrences.find(
      (occurrence) => occurrence.outcome === "dispatched" && occurrence.runId !== runId,
    )?.runId;
    expect(recoveredRunId).toMatch(/^run_/);
    expect(recoveredRunId).not.toBe(runId);
    await runDurableObjectAlarm(controlPlane);
    await expect(
      controlPlane.agentWatches(authority, {
        action: "history",
        agentId: created.agent.id,
        limit: 10,
        watchId: configured.watch.id,
      }),
    ).resolves.toMatchObject({
      occurrences: [
        expect.objectContaining({ runId: recoveredRunId }),
        expect.objectContaining({ runId }),
      ],
      ok: true,
    });

    if (recoveredRunId === undefined || recoveredRunId === null) {
      throw new Error("Expected recovered Watch Run identity.");
    }

    await vi.waitFor(
      async () => {
        const inspected = await controlPlane.inspectRun(authority, { runId: recoveredRunId });
        expect(inspected).toMatchObject({
          ok: true,
          run: { status: expect.stringMatching(/^(?:cancelled|completed|failed)$/) },
        });
      },
      { interval: 25, timeout: 5_000 },
    );

    await runInDurableObject(controlPlane, (_instance, state) => {
      const currentTime = Date.now();
      const firstPendingAt = currentTime - 2_000_000;
      const secondPendingAt = firstPendingAt - 1;

      for (const scheduledAt of [firstPendingAt, secondPendingAt]) {
        state.storage.sql.exec(
          `INSERT INTO agent_schedule_occurrences (
             schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
             next_attempt_at, attempts, status, run_id, reason
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
          configured.watch.id,
          created.agent.id,
          configured.watch.revision,
          scheduledAt,
          scheduledAt,
          currentTime - 1,
        );
      }
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        currentTime - 1,
        configured.watch.id,
      );
      const schedules = new AgentSchedules(
        drizzle(state.storage, { schema: controlPlaneSchema }),
        state.storage,
        () => {
          throw new Error("Due occurrence claiming does not read fleet configuration.");
        },
      );
      const due = schedules.claimDue(currentTime);

      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({ scheduleId: configured.watch.id });
      expect(
        state.storage.sql
          .exec<{ pending: number }>(
            `SELECT count(*) AS pending
             FROM agent_schedule_occurrences
             WHERE schedule_id = ? AND status = 'pending'`,
            configured.watch.id,
          )
          .one(),
      ).toEqual({ pending: 2 });
      expect(
        state.storage.sql
          .exec<{ nextRunAt: number }>(
            "SELECT next_run_at AS nextRunAt FROM agent_schedules WHERE schedule_id = ?",
            configured.watch.id,
          )
          .one().nextRunAt,
      ).toBeLessThanOrEqual(currentTime);
      state.storage.sql.exec(
        "DELETE FROM agent_schedule_occurrences WHERE schedule_id = ? AND status = 'pending'",
        configured.watch.id,
      );
      state.storage.sql.exec(
        "UPDATE agent_schedules SET next_run_at = ? WHERE schedule_id = ?",
        currentTime + 60_000,
        configured.watch.id,
      );
    });

    const retentionPendingAt = Date.now() - 1;
    const retentionHistoryAt = retentionPendingAt - 1_000_000;
    await runInDurableObject(controlPlane, (_instance, state) => {
      for (let index = 1; index <= MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES + 1; index += 1) {
        const occurredAt = retentionHistoryAt - index;
        state.storage.sql.exec(
          `INSERT INTO agent_schedule_occurrences (
             schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
             next_attempt_at, attempts, status, run_id, reason
           ) VALUES (?, ?, ?, ?, ?, NULL, 1, 'skipped', NULL, 'dispatch_exception')`,
          configured.watch.id,
          created.agent.id,
          configured.watch.revision,
          occurredAt,
          occurredAt,
        );
      }
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_occurrences (
           schedule_id, agent_id, schedule_revision, scheduled_at, occurred_at,
           next_attempt_at, attempts, status, run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 'pending', NULL, NULL)`,
        configured.watch.id,
        created.agent.id,
        configured.watch.revision,
        retentionPendingAt,
        retentionPendingAt,
        retentionPendingAt,
      );
      new AgentSchedules(
        drizzle(state.storage, { schema: controlPlaneSchema }),
        state.storage,
        () => {
          throw new Error("Retention pruning does not read fleet configuration.");
        },
      ).recordSkipped(
        {
          scheduleId: configured.watch.id,
          scheduleRevision: configured.watch.revision,
          scheduledAt: retentionPendingAt,
        },
        Date.now(),
        "agent_unavailable",
      );
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec<{ pending: number; terminal: number }>(
            `SELECT
               sum(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
               sum(CASE WHEN status <> 'pending' THEN 1 ELSE 0 END) AS terminal
             FROM agent_schedule_occurrences
             WHERE schedule_id = ?`,
            configured.watch.id,
          )
          .one(),
      ),
    ).resolves.toEqual({ pending: 0, terminal: MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES });
  });
});
