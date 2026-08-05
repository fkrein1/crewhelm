import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
  DEFAULT_FLEET_MAX_AGENTS,
  DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
  DEFAULT_FLEET_MAX_CONNECTIONS,
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  type AgentInboxDeferredReason,
  type AgentEventTriggersInput,
  type OwnerScope,
  type StartRunResult,
} from "@crewhelm/contracts";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_SCHEMA_VERSION,
  applyControlPlaneMigration,
  runControlPlaneMigrationTransaction,
} from "./migrations.js";
import { controlPlaneSchema } from "./schema.js";
import { deriveOwnerKey } from "./identity.js";
import { digestRunPrompt } from "../agent/admitted-runs/index.js";

import { agentInput, authorityFor, fixedRunAdmissionFailure } from "./testkit.js";
import { agentEventTriggerRequiredScope, scheduledRunFailureReason } from "./durable-object.js";

type RunStartFailureCode = Extract<StartRunResult, { ok: false }>["error"]["code"];

const SCHEDULED_RUN_FAILURE_CASES = [
  ["admission_limit_exceeded", "admission_limit_exceeded"],
  ["agent_not_found", "agent_not_found"],
  ["agent_unavailable", "agent_unavailable"],
  ["branch_revision_conflict", "run_unavailable"],
  ["brief_context_too_large", "brief_context_too_large"],
  ["brief_unavailable", "brief_unavailable"],
  ["budget_exhausted", "budget_exhausted"],
  ["capability_unavailable", "capability_unavailable"],
  ["idempotency_conflict", "idempotency_conflict"],
  ["incompatible_schema", "run_unavailable"],
  ["insufficient_scope", "run_unavailable"],
  ["invalid_authority", "run_unavailable"],
  ["invalid_request", "run_unavailable"],
  ["model_unavailable", "model_unavailable"],
  ["model_disabled", "model_unavailable"],
  ["owner_mismatch", "run_unavailable"],
  ["revision_conflict", "revision_conflict"],
  ["run_unavailable", "run_unavailable"],
  ["session_busy", "run_unavailable"],
  ["session_not_found", "run_unavailable"],
] as const satisfies readonly (readonly [RunStartFailureCode, AgentInboxDeferredReason])[];
const ALL_RUN_START_FAILURES_ARE_COVERED: Exclude<
  RunStartFailureCode,
  (typeof SCHEDULED_RUN_FAILURE_CASES)[number][0]
> extends never
  ? true
  : false = true;
const EVENT_TRIGGER_SCOPE_CASES = [
  ["create", AUTONOMY_WRITE_SCOPE],
  ["delete", AUTONOMY_WRITE_SCOPE],
  ["history", AGENTS_READ_SCOPE],
  ["inspect", AGENTS_READ_SCOPE],
  ["list", AGENTS_READ_SCOPE],
  ["pause", AUTONOMY_WRITE_SCOPE],
  ["resume", AUTONOMY_WRITE_SCOPE],
  ["sources", OWNER_READ_SCOPE],
  ["update", AUTONOMY_WRITE_SCOPE],
] as const satisfies readonly (readonly [AgentEventTriggersInput["action"], OwnerScope])[];
const ALL_EVENT_TRIGGER_ACTIONS_ARE_COVERED: Exclude<
  AgentEventTriggersInput["action"],
  (typeof EVENT_TRIGGER_SCOPE_CASES)[number][0]
> extends never
  ? true
  : false = true;

describe("OwnerControlPlane control flow", () => {
  it("translates every expected scheduled Run failure", () => {
    expect(ALL_RUN_START_FAILURES_ARE_COVERED).toBe(true);
    for (const [failure, reason] of SCHEDULED_RUN_FAILURE_CASES) {
      expect(scheduledRunFailureReason(failure)).toBe(reason);
    }
  });

  it("selects authority scopes exhaustively for every Agent Event Trigger action", () => {
    expect(ALL_EVENT_TRIGGER_ACTIONS_ARE_COVERED).toBe(true);
    for (const [action, scope] of EVENT_TRIGGER_SCOPE_CASES) {
      expect(agentEventTriggerRequiredScope(action)).toBe(scope);
    }
  });
});

describe("owner identity", () => {
  it("derives a deterministic opaque key without retaining provider identity", async () => {
    const identity = {
      issuer: "https://github.com",
      subject: "12345678",
    };

    const first = await deriveOwnerKey(identity);
    const second = await deriveOwnerKey(identity);

    expect(first).toBe(second);
    expect(first).toMatch(/^owner_[A-Za-z0-9_-]{43}$/);
    expect(first).not.toContain(identity.subject);
    expect(first).not.toContain("github");
  });

  it("separates issuers, subjects, and validated tenants", async () => {
    const identities = [
      { issuer: "https://github.com", subject: "1" },
      { issuer: "https://github.com", subject: "2" },
      { issuer: "https://identity.example", subject: "1" },
      { issuer: "https://github.com", subject: "1", tenant: "team-a" },
    ];

    const keys = await Promise.all(identities.map((identity) => deriveOwnerKey(identity)));

    expect(new Set(keys).size).toBe(identities.length);
  });

  it("rejects malformed or ambiguous identity input", async () => {
    await expect(deriveOwnerKey({ issuer: "github.com", subject: "1" })).rejects.toThrow(
      "Invalid URL",
    );
    await expect(
      deriveOwnerKey({ issuer: "https://github.com", subject: "", extra: "untrusted" }),
    ).rejects.toThrow("Too small");
  });
});

describe("OwnerControlPlane", () => {
  it("initializes a SQLite-backed control plane and returns only safe status", async () => {
    const authority = await authorityFor("101");
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toEqual({
      ok: true,
      status: {
        capacity: {
          maxAgents: DEFAULT_FLEET_MAX_AGENTS,
          maxConcurrentRuns: DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
          maxConnections: DEFAULT_FLEET_MAX_CONNECTIONS,
          retention: {
            inboxSeconds: DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
            runSeconds: DEFAULT_FLEET_RUN_RETENTION_SECONDS,
          },
        },
        configurationRevision: 1,
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        status: "ready",
        usage: {
          agents: { active: 0, total: 0 },
          briefs: { active: 0, storedBytes: 0, total: 0, versions: 0 },
          connections: { active: 0, pending: 0, total: 0 },
          diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
          inbox: {
            actionRequired: 0,
            attention: {
              needsAction: 0,
              oldestNeedsActionAt: null,
              warnings: 0,
            },
            deferred: 0,
            exceptions: 0,
            outcomes: 0,
            total: 0,
          },
          recovery: { unresolvedEffects: 0 },
          runs: { active: 0 },
          skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
          workflows: { active: 0, total: 0 },
        },
      },
    });
    await expect(
      stub.status(authority, { auditLimit: 5, includeRecentAudit: true }),
    ).resolves.toMatchObject({
      ok: true,
      status: { recentAudit: [] },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        migration: state.storage.sql
          .exec("SELECT version, name, checksum FROM control_plane_migrations ORDER BY version")
          .toArray(),
        owner: state.storage.sql.exec("SELECT owner_key FROM control_plane").one(),
      })),
    ).resolves.toEqual({
      migration: [
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0000_bootstrap",
          version: 1,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0001_expand_provider_auth_schemes",
          version: 2,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0002_tricky_purple_man",
          version: 3,
        },
      ],
      owner: { owner_key: authority.ownerKey },
    });
    await runInDurableObject(stub, (_instance, state) => {
      for (const [index, accountLabel] of [
        "line\nbreak",
        `delete${String.fromCharCode(127)}`,
      ].entries()) {
        expect(() =>
          state.storage.sql.exec(
            `INSERT INTO connections
               (connection_id, provider, provider_connection_id, auth_config_id, account_label,
                status, created_at)
             VALUES (?, 'composio', ?, ?, ?, 'initiated', ?)`,
            `connection_00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
            `ca_control_character_${index}`,
            `ac_control_character_${index}`,
            accountLabel,
            Date.now(),
          ),
        ).toThrow("CHECK constraint failed");
      }
    });
  });

  it("accepts only current projections for an exact redeemed run admission", async () => {
    const authority = await authorityFor("inbox-projection", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("inbox-projection-agent"));
    const prompt = "Retain this exact task behind the compact inbox projection.";

    if (!created.ok) {
      throw new Error("Expected inbox projection Agent.");
    }

    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "inbox-projection-run",
      prompt,
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected inbox projection admission.");
    }

    const reference = {
      agentId: admission.permit.agentId,
      agentRevision: admission.permit.agentRevision,
      idempotencyKey: admission.permit.idempotencyKey,
      ownerKey: admission.permit.ownerKey,
      promptDigest: admission.permit.promptDigest,
      runId: admission.permit.runId,
      scheduleRevision: admission.permit.scheduleRevision,
    };
    const occurredAt = Date.now() + 10;
    const completed = {
      event: {
        approvalCount: 0,
        kind: "outcome" as const,
        occurredAt: new Date(occurredAt).toISOString(),
        resultPreview: "A bounded outcome is ready.",
        runStatus: "completed" as const,
      },
      reference,
    };

    await expect(stub.recordAgentInboxRun(completed)).resolves.toMatchObject({
      error: { code: "invalid_admission" },
      ok: false,
    });
    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH digits(value) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         ),
         numbers(value) AS (
           SELECT
             ones.value
             + 10 * tens.value
             + 100 * hundreds.value
             + 1000 * thousands.value
             + 10000 * ten_thousands.value
             + 1
           FROM digits AS ones
           CROSS JOIN digits AS tens
           CROSS JOIN digits AS hundreds
           CROSS JOIN digits AS thousands
           CROSS JOIN digits AS ten_thousands
           ORDER BY 1
           LIMIT 10001
         )
         INSERT INTO agent_inbox_items (
           item_id,
           agent_id,
           agent_revision,
           fleet_revision,
           run_id,
           trigger,
           run_status,
           kind,
           approval_count,
           request_preview,
           result_preview,
           occurred_at,
           version,
           cleanup_at
         )
         SELECT
           'inbox_run_00000000-0000-4000-8000-' || printf('%012x', value),
           ?,
           ?,
           1,
           'run_00000000-0000-4000-8000-' || printf('%012x', value),
           'manual',
           'completed',
           'outcome',
           0,
           'Bounded capacity fixture.',
           'Fixture outcome.',
           value,
           '1970-01-01T00:00:00.001Z',
           ?
         FROM numbers`,
        created.agent.id,
        created.agent.revision,
        Date.now() + 60_000,
      );
      state.storage.sql.exec(
        `UPDATE agent_inbox_items
         SET kind = 'action_required',
             run_status = 'running',
             approval_count = 1,
             result_preview = NULL
         WHERE run_id = 'run_00000000-0000-4000-8000-000000000001'`,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_inbox_items (
           item_id,
           agent_id,
           agent_revision,
           fleet_revision,
           schedule_id,
           schedule_revision,
           kind,
           approval_count,
           request_preview,
           reason,
           scheduled_at,
           retry_at,
           occurred_at,
           version,
           cleanup_at
         )
         VALUES (
           'inbox_deferred_' || substr(?, 7),
           ?,
           ?,
           1,
           'schedule_' || substr(?, 7),
           1,
           'deferred',
           0,
           'Wait for the current run.',
           'active_run',
           2,
           3,
           2,
           '1970-01-01T00:00:00.002Z',
           ?
         )`,
        created.agent.id,
        created.agent.id,
        created.agent.revision,
        created.agent.id,
        Date.now() + 60_000,
      );
    });
    await expect(
      stub.recordAgentInboxRun({
        ...completed,
        reference: { ...reference, promptDigest: "0".repeat(64) },
      }),
    ).resolves.toMatchObject({
      error: { code: "invalid_admission" },
      ok: false,
    });
    await expect(
      stub.recordAgentInboxRun({
        ...completed,
        reference: { ...reference, scheduleRevision: 1 },
      }),
    ).resolves.toMatchObject({
      error: { code: "invalid_admission" },
      ok: false,
    });
    await expect(stub.recordAgentInboxRun(completed)).resolves.toEqual({
      ok: true,
      recorded: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ action_required: number; value: number }>(
            `SELECT
               count(*) AS value,
               count(*) FILTER (WHERE kind = 'action_required') AS action_required
             FROM agent_inbox_items`,
          )
          .one(),
      ),
    ).resolves.toEqual({ action_required: 1, value: 10_000 });
    await expect(
      stub.recordAgentInboxRun({
        event: {
          approvalCount: 1,
          kind: "action_required",
          occurredAt: new Date(occurredAt - 1).toISOString(),
          resultPreview: null,
          runStatus: "running",
        },
        reference,
      }),
    ).resolves.toEqual({
      ok: true,
      recorded: false,
    });
    await expect(
      stub.agentInbox(authority, {
        action: "list",
        agentId: created.agent.id,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      action: "list",
      items: [
        {
          kind: "outcome",
          requestPreview: prompt,
          resultPreview: completed.event.resultPreview,
          runId: admission.permit.runId,
          runStatus: "completed",
        },
      ],
      ok: true,
    });
    await expect(
      stub.agentInbox(authority, {
        action: "overview",
        agentId: created.agent.id,
      }),
    ).resolves.toMatchObject({
      action: "overview",
      counts: {
        actionRequired: 1,
        attention: {
          needsAction: 1,
          oldestNeedsActionAt: "1970-01-01T00:00:00.001Z",
          warnings: 1,
        },
        deferred: 1,
        total: 10_000,
      },
      ok: true,
      pollAfterSeconds: 30,
    });
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: {
        usage: {
          inbox: {
            attention: {
              needsAction: 1,
              oldestNeedsActionAt: "1970-01-01T00:00:00.001Z",
              warnings: 1,
            },
          },
        },
      },
    });
    await expect(
      stub.agentInbox(authority, {
        action: "list",
        agentId: created.agent.id,
        limit: 25,
        needsAction: true,
        severities: ["attention_required"],
      }),
    ).resolves.toMatchObject({
      action: "list",
      items: [
        {
          kind: "action_required",
          needsAction: true,
          severity: "attention_required",
        },
      ],
      ok: true,
      pollAfterSeconds: 30,
    });
    await expect(
      stub.agentInbox(authority, {
        action: "list",
        agentId: created.agent.id,
        limit: 25,
        needsAction: false,
        severities: ["warning"],
      }),
    ).resolves.toMatchObject({
      action: "list",
      items: [
        {
          kind: "deferred",
          needsAction: false,
          severity: "warning",
        },
      ],
      ok: true,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM agent_inbox_acknowledgements");
      state.storage.sql.exec("DELETE FROM agent_inbox_items");
      state.storage.sql.exec(
        `WITH digits(value) AS (
           VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
         ),
         numbers(value) AS (
           SELECT
             ones.value
             + 10 * tens.value
             + 100 * hundreds.value
             + 1000 * thousands.value
             + 1
           FROM digits AS ones
           CROSS JOIN digits AS tens
           CROSS JOIN digits AS hundreds
           CROSS JOIN digits AS thousands
           ORDER BY 1
         )
         INSERT INTO agent_inbox_items (
           item_id,
           agent_id,
           agent_revision,
           fleet_revision,
           schedule_id,
           schedule_revision,
           kind,
           approval_count,
           request_preview,
           reason,
           scheduled_at,
           retry_at,
           occurred_at,
           version,
           cleanup_at
         )
         SELECT
           'inbox_warning_' || printf('%012x', value),
           ?,
           ?,
           1,
           'schedule_' || substr(?, 7),
           1,
           'deferred',
           0,
           'Wait for the current run.',
           'active_run',
           value,
           value + 1,
           value,
           '1970-01-01T00:00:00.002Z',
           ?
         FROM numbers`,
        created.agent.id,
        created.agent.revision,
        created.agent.id,
        Date.now() + 60_000,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_inbox_items (
           item_id,
           agent_id,
           agent_revision,
           fleet_revision,
           run_id,
           trigger,
           run_status,
           kind,
           approval_count,
           request_preview,
           occurred_at,
           version,
           cleanup_at
         )
         VALUES (
           'inbox_run_00000000-0000-4000-8000-ffffffffffff',
           ?,
           ?,
           1,
           'run_00000000-0000-4000-8000-ffffffffffff',
           'manual',
           'failed',
           'exception',
           0,
           'Inspect this failed run.',
           1,
           '1970-01-01T00:00:00.001Z',
           ?
         )`,
        created.agent.id,
        created.agent.revision,
        Date.now() + 60_000,
      );
    });
    await expect(stub.recordAgentInboxRun(completed)).resolves.toEqual({
      ok: true,
      recorded: true,
    });
    await expect(
      stub.agentInbox(authority, {
        action: "overview",
        agentId: created.agent.id,
      }),
    ).resolves.toMatchObject({
      action: "overview",
      counts: {
        attention: {
          needsAction: 1,
          oldestNeedsActionAt: "1970-01-01T00:00:00.001Z",
          warnings: 9_999,
        },
        exceptions: 1,
        outcomes: 0,
        total: 10_000,
      },
      ok: true,
    });
  });

  it("applies revisioned inbox retention to new owner-local projections", async () => {
    const authority = await authorityFor("inbox-retention", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const current = await stub.getFleetConfiguration(authority, { target: { kind: "fleet" } });

    if (!current.ok) {
      throw new Error("Expected fleet configuration.");
    }

    const inboxSeconds = 60 * 60;

    await expect(
      stub.configureFleetConfiguration(authority, {
        expectedRevision: current.configuration.revision,
        idempotencyKey: "inbox-retention-configure",
        mode: "apply",
        patch: { retention: { inboxSeconds, runSeconds: inboxSeconds } },
        target: { kind: "fleet" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    const created = await stub.createAgent(authority, agentInput("inbox-retention-agent"));

    if (!created.ok) {
      throw new Error("Expected inbox-retention Agent.");
    }

    const prompt = "Project this run with the configured inbox retention.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "inbox-retention-run",
      prompt,
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected inbox-retention admission.");
    }

    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    const occurredAt = new Date().toISOString();
    await expect(
      stub.recordAgentInboxRun({
        event: {
          approvalCount: 0,
          kind: "outcome",
          occurredAt,
          resultPreview: "Retention configured.",
          runStatus: "completed",
        },
        reference: {
          agentId: admission.permit.agentId,
          agentRevision: admission.permit.agentRevision,
          idempotencyKey: admission.permit.idempotencyKey,
          ownerKey: admission.permit.ownerKey,
          promptDigest: admission.permit.promptDigest,
          runId: admission.permit.runId,
        },
      }),
    ).resolves.toEqual({ ok: true, recorded: true });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ retention_ms: number }>(
            `SELECT cleanup_at - occurred_at AS retention_ms
             FROM agent_inbox_items
             WHERE run_id = ?`,
            admission.permit.runId,
          )
          .one(),
      ),
    ).resolves.toEqual({ retention_ms: inboxSeconds * 1_000 });

    const queuedPrompt = "Keep one unit of owner-local work queued for fleet status.";
    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "inbox-retention-queued-run",
        promptCharacters: queuedPrompt.length,
        promptDigest: await digestRunPrompt(queuedPrompt),
      }),
    ).resolves.toMatchObject({ ok: true, state: "issued" });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (
           'connection_00000000-0000-4000-8000-000000000099',
           'composio',
           'ca_status_dashboard',
           'ac_status_dashboard',
           'active',
           ?
         )`,
        Date.now(),
      );
    });
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: {
        usage: {
          agents: { active: 1, total: 1 },
          connections: { active: 1, pending: 0, total: 1 },
          inbox: {
            actionRequired: 0,
            attention: {
              needsAction: 0,
              oldestNeedsActionAt: null,
              warnings: 0,
            },
            deferred: 0,
            exceptions: 0,
            outcomes: 1,
            total: 1,
          },
          runs: { active: 1 },
        },
      },
    });
  });

  it("fails closed for missing scopes and extra authority data", async () => {
    const authority = await authorityFor("102");
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status({ ...authority, scopes: [] })).resolves.toEqual({
      error: {
        code: "invalid_authority",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
    await expect(stub.status({ ...authority, accessToken: "must-not-cross" })).resolves.toEqual({
      error: {
        code: "invalid_authority",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  });

  it("binds an object to its name before the first write", async () => {
    const first = await authorityFor("103");
    const second = await authorityFor("104");
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);

    await expect(stub.status(second)).resolves.toEqual({
      error: {
        code: "owner_mismatch",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
    await expect(stub.status(first)).resolves.toMatchObject({
      ok: true,
      status: { status: "ready" },
    });
  });

  it("recovers the schema and owner binding after eviction", async () => {
    const first = await authorityFor("107");
    const second = await authorityFor("108");
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);

    await expect(stub.status(first)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await evictDurableObject(stub);
    await expect(stub.status(first)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await expect(stub.status(second)).resolves.toMatchObject({
      error: { code: "owner_mismatch" },
      ok: false,
    });
  });

  it("expands provider auth schemes without losing existing auth configs", async () => {
    const authority = await authorityFor("107-provider-auth-migration");
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 2");
      state.storage.sql.exec("DROP INDEX provider_auth_configs_integration");
      state.storage.sql.exec(`CREATE TABLE __old_provider_auth_configs (
        auth_config_id text PRIMARY KEY NOT NULL,
        integration_slug text NOT NULL,
        auth_scheme text NOT NULL,
        source text NOT NULL,
        display_name text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL,
        CONSTRAINT provider_auth_configs_integration_slug
          CHECK(length(integration_slug) BETWEEN 1 AND 128),
        CONSTRAINT provider_auth_configs_auth_scheme
          CHECK(auth_scheme IN ('OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC')),
        CONSTRAINT provider_auth_configs_source
          CHECK(source IN ('composio_managed', 'crewhelm_custom')),
        CONSTRAINT provider_auth_configs_display_name
          CHECK(length(display_name) BETWEEN 1 AND 160),
        CONSTRAINT provider_auth_configs_created_at_positive CHECK(created_at > 0),
        CONSTRAINT provider_auth_configs_updated_after_creation CHECK(updated_at >= created_at)
      )`);
      state.storage.sql.exec(`INSERT INTO __old_provider_auth_configs
        SELECT * FROM provider_auth_configs`);
      state.storage.sql.exec("DROP TABLE provider_auth_configs");
      state.storage.sql.exec(
        "ALTER TABLE __old_provider_auth_configs RENAME TO provider_auth_configs",
      );
      state.storage.sql.exec(
        "CREATE INDEX provider_auth_configs_integration ON provider_auth_configs (integration_slug, auth_config_id)",
      );
      state.storage.sql.exec(`INSERT INTO provider_auth_configs
        (auth_config_id, integration_slug, auth_scheme, source, display_name, created_at, updated_at)
        VALUES ('ac_existing_oauth', 'github', 'OAUTH2', 'crewhelm_custom', 'Existing OAuth', 1, 1)`);
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`INSERT INTO provider_auth_configs
          (auth_config_id, integration_slug, auth_scheme, source, display_name, created_at, updated_at)
          VALUES ('ac_service_account', 'googlebigquery', 'GOOGLE_SERVICE_ACCOUNT',
                  'crewhelm_custom', 'BigQuery service account', 2, 2)`);
        return state.storage.sql
          .exec(
            "SELECT auth_config_id, auth_scheme FROM provider_auth_configs ORDER BY auth_config_id",
          )
          .toArray();
      }),
    ).resolves.toEqual([
      { auth_config_id: "ac_existing_oauth", auth_scheme: "OAUTH2" },
      { auth_config_id: "ac_service_account", auth_scheme: "GOOGLE_SERVICE_ACCOUNT" },
    ]);
  });

  it("adds API-key remote MCP authentication without losing existing Connections", async () => {
    const authority = await authorityFor("109-remote-mcp-api-key-migration");
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version = 3");
      state.storage.sql.exec(`
        INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, account_label,
           status, created_at)
        VALUES ('connection_existing_remote_mcp', 'remote_mcp', NULL, NULL,
                'Existing MCP', 'active', 1);
        INSERT INTO remote_mcp_connections
          (connection_id, endpoint, auth_kind, catalog, catalog_bytes, snapshot_digest,
           server_name, server_version, credential_ciphertext, credential_nonce, oauth_scopes)
        VALUES ('connection_existing_remote_mcp', 'https://mcp.example.com/rpc', 'public', '[]', 2,
                '${"a".repeat(64)}', 'existing-mcp', '1', NULL, NULL, '[]');
        PRAGMA foreign_keys=OFF;
        CREATE TABLE __old_remote_mcp_connections AS SELECT * FROM remote_mcp_connections;
        DROP TABLE remote_mcp_connections;
        ALTER TABLE __old_remote_mcp_connections RENAME TO remote_mcp_connections;
        PRAGMA foreign_keys=ON;
      `);
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => {
        const existing = state.storage.sql
          .exec(
            `SELECT auth_kind, endpoint FROM remote_mcp_connections
             WHERE connection_id = 'connection_existing_remote_mcp'`,
          )
          .one();
        state.storage.sql.exec(`
          INSERT INTO connections
            (connection_id, provider, provider_connection_id, auth_config_id, account_label,
             status, created_at)
          VALUES ('connection_api_key_remote_mcp', 'remote_mcp', NULL, NULL,
                  'API MCP', 'active', 2);
          INSERT INTO remote_mcp_connections
            (connection_id, endpoint, auth_kind, api_key_header_name, catalog, catalog_bytes, snapshot_digest,
             server_name, server_version, credential_ciphertext, credential_nonce, oauth_scopes)
          VALUES ('connection_api_key_remote_mcp', 'https://api-mcp.example.com/rpc', 'api_key', 'x-api-key',
                  '[]', 2, '${"b".repeat(64)}', 'api-mcp', '1', 'ciphertext', 'nonce', '[]');
        `);
        return existing;
      }),
    ).resolves.toEqual({
      auth_kind: "public",
      endpoint: "https://mcp.example.com/rpc",
    });
  });

  it("rolls back migration DDL when its journal write fails", async () => {
    const authority = await authorityFor("90134", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await expect(
      runInDurableObject(stub, async (_instance, state) => {
        const database = drizzle(state.storage, { schema: controlPlaneSchema });
        const migrationSql = `PRAGMA foreign_keys=OFF;
                              --> statement-breakpoint
                              CREATE TABLE migration_rollback_probe (
                                id integer PRIMARY KEY
                              );
                              --> statement-breakpoint
                              PRAGMA foreign_keys=ON;`;

        await runControlPlaneMigrationTransaction(state.storage, [migrationSql], () => {
          applyControlPlaneMigration(database, state.storage, {
            checksum: "a".repeat(64),
            name: "rollback_probe",
            sql: migrationSql,
            version: 1,
          });
        });
      }),
    ).rejects.toThrow("UNIQUE constraint failed");
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        foreignKeys: state.storage.sql.exec("PRAGMA foreign_keys").one(),
        journal: state.storage.sql
          .exec("SELECT version FROM control_plane_migrations WHERE name = 'rollback_probe'")
          .toArray(),
        table: state.storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_rollback_probe'",
          )
          .toArray(),
      })),
    ).resolves.toEqual({ foreignKeys: { foreign_keys: 1 }, journal: [], table: [] });
  });

  it("fails closed instead of guessing how to apply an unknown migration", async () => {
    const authority = await authorityFor("110", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO control_plane_migrations (version, name, checksum, applied_at)
         VALUES (?, ?, ?, ?)`,
        CONTROL_PLANE_SCHEMA_VERSION + 1,
        "future_migration",
        "f".repeat(64),
        Date.now(),
      );
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
    await expect(stub.createAgent(authority, agentInput("unknown-schema"))).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("fails closed instead of adopting unjournaled Crewhelm tables", async () => {
    const authority = await authorityFor("90132", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE control_plane_migrations");
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  });

  it("fails closed when the migration journal checksum is invalid", async () => {
    const authority = await authorityFor("90130", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("invalid-journal-agent"));

    if (!created.ok) {
      throw new Error("Expected invalid-journal Agent fixture.");
    }

    const prompt = "Do not run after schema drift.";
    const issued = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "invalid-journal-issued",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });
    const redeemed = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "invalid-journal-redeemed",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!issued.ok || issued.state !== "issued" || !redeemed.ok || redeemed.state !== "issued") {
      throw new Error("Expected invalid-journal run fixtures.");
    }

    await expect(stub.confirmRunAdmission(redeemed.permit)).resolves.toMatchObject({
      ok: true,
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE control_plane_migrations SET checksum = ? WHERE version = 1",
        "0".repeat(64),
      );
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
    await expect(stub.createAgent(authority, agentInput("invalid-journal"))).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Agent request denied.",
      },
      ok: false,
    });
    await expect(stub.verifyRunAdmission(issued.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(stub.confirmRunAdmission(issued.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      stub.verifyActiveRunAdmission({
        agentId: redeemed.permit.agentId,
        agentRevision: redeemed.permit.agentRevision,
        budgetReservation: redeemed.permit.budgetReservation,
        clientId: redeemed.permit.clientId,
        idempotencyKey: redeemed.permit.idempotencyKey,
        ownerKey: redeemed.permit.ownerKey,
        promptDigest: redeemed.permit.promptDigest,
        runId: redeemed.permit.runId,
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));
    await expect(
      stub.redeemRunReceiverCapability({
        action: "inspect",
        agentId: redeemed.permit.agentId,
        agentRevision: redeemed.permit.agentRevision,
        audience: "crew_agent",
        budgetReservation: redeemed.permit.budgetReservation,
        capability: "run:inspect",
        clientId: redeemed.permit.clientId,
        connection: "none",
        effect: "none",
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
        idempotencyKey: redeemed.permit.idempotencyKey,
        nonce: redeemed.permit.nonce,
        ownerKey: redeemed.permit.ownerKey,
        promptDigest: redeemed.permit.promptDigest,
        runId: redeemed.permit.runId,
        target: "none",
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));
  });

  it("keeps distinct owner objects independent", async () => {
    const first = await authorityFor("105");
    const second = await authorityFor("106");

    await expect(
      env.OWNER_CONTROL_PLANE.getByName(first.ownerKey).status(first),
    ).resolves.toMatchObject({ ok: true, status: { status: "ready" } });
    await expect(
      env.OWNER_CONTROL_PLANE.getByName(second.ownerKey).status(second),
    ).resolves.toMatchObject({ ok: true, status: { status: "ready" } });
  });
});
