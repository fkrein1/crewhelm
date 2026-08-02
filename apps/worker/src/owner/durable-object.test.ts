import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
  DEFAULT_FLEET_MAX_AGENTS,
  DEFAULT_FLEET_MAX_CONCURRENT_RUNS,
  DEFAULT_FLEET_MAX_CONNECTIONS,
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
  MAXIMUM_FLEET_CONCURRENT_RUNS,
  MAXIMUM_FLEET_CONNECTIONS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  runBudgetReservationSchema,
} from "@crewhelm/contracts";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import {
  CONTROL_PLANE_SCHEMA_VERSION,
  applyControlPlaneMigration,
  applyControlPlaneMigrationSql,
  runControlPlaneMigrationTransaction,
} from "./migrations.js";
import { controlPlaneSchema } from "./schema.js";
import { deriveOwnerKey } from "./identity.js";
import { digestRunPrompt } from "../agent/admitted-runs/index.js";
import migration1 from "../../control-plane-migrations/0001_windy_bushwacker.sql";
import migration2 from "../../control-plane-migrations/0002_cool_rictor.sql";
import migration22 from "../../control-plane-migrations/0022_adorable_marrow.sql";
import { controlPlaneMigrations } from "../../control-plane-migrations/index.js";

import { agentInput, authorityFor, fixedRunAdmissionFailure } from "./testkit.js";

function removeSkillLibrarySchema(storage: DurableObjectStorage): void {
  storage.sql.exec("DROP TABLE agent_blueprint_mutations");
  storage.sql.exec("DROP TABLE agent_blueprint_versions");
  storage.sql.exec("DROP TABLE agent_blueprints");
  storage.sql.exec("DROP TABLE skill_mutations");
  storage.sql.exec("DROP TABLE skill_versions");
  storage.sql.exec("DROP TABLE skill_objects");
  storage.sql.exec("DROP TABLE skills");
}

function removeAgentWorkflowSchema(storage: DurableObjectStorage): void {
  storage.sql.exec("DROP TABLE agent_workflow_stages");
  storage.sql.exec("DROP TABLE agent_workflow_deletions");
  storage.sql.exec("DROP TABLE agent_workflows");
}

function removeBriefSchema(storage: DurableObjectStorage): void {
  storage.sql.exec("DROP TABLE brief_versions");
  storage.sql.exec("DROP TABLE brief_mutations");
  storage.sql.exec("DROP TABLE brief_deletions");
  storage.sql.exec("DROP TABLE briefs");
}

function removeRuntimeToolSchema(storage: DurableObjectStorage): void {
  storage.sql.exec("DROP TABLE runtime_tool_executions");
}

async function migrationChecksum(source: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
  );

  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
          name: "0000_wooden_newton_destine",
          version: 1,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0001_windy_bushwacker",
          version: 2,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0002_cool_rictor",
          version: 3,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0003_windy_stepford_cuckoos",
          version: 4,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0004_eminent_mongoose",
          version: 5,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0005_young_norman_osborn",
          version: 6,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0006_concerned_mesmero",
          version: 7,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0007_pale_spencer_smythe",
          version: 8,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0008_backfill_tool_authorization",
          version: 9,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0009_colorful_skullbuster",
          version: 10,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0010_famous_george_stacy",
          version: 11,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0011_remove_fleet_ai_budget",
          version: 12,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0012_acoustic_killraven",
          version: 13,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0013_scale_fleet_configuration",
          version: 14,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0014_closed_patriot",
          version: 15,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0015_simple_thaddeus_ross",
          version: 16,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0016_skinny_rattler",
          version: 17,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0017_messy_argent",
          version: 18,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0018_clear_franklin_richards",
          version: 19,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0019_dashing_dragon_lord",
          version: 20,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0020_expand_inference_profiles",
          version: 21,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0021_futuristic_adam_destine",
          version: 22,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0022_adorable_marrow",
          version: 23,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0023_abnormal_sister_grimm",
          version: 24,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0024_broad_micromacro",
          version: 25,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0025_charming_squadron_supreme",
          version: 26,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0026_fresh_white_queen",
          version: 27,
        },
        {
          checksum: expect.stringMatching(/^[a-f0-9]{64}$/),
          name: "0027_classy_switch",
          version: 28,
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

  it("migrates persisted model selections and issued admissions into capability plans", async () => {
    const authority = await authorityFor("capability-plan-migration", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("capability-plan-agent"));

    if (!created.ok) {
      throw new Error("Expected capability migration Agent fixture.");
    }

    const prompt = "Preserve this issued admission.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "capability-plan-admission",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected capability migration admission fixture.");
    }

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("PRAGMA foreign_keys=OFF");
      state.storage.sql.exec(
        `CREATE TABLE legacy_agent_revisions (
           agent_id text NOT NULL,
           revision integer NOT NULL,
           name text NOT NULL,
           model text NOT NULL,
           instructions text NOT NULL,
           execution_limits text NOT NULL,
           capability_grants text NOT NULL,
           created_at integer NOT NULL,
           PRIMARY KEY(agent_id, revision),
           FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE restrict
         )`,
      );
      state.storage.sql.exec(
        `INSERT INTO legacy_agent_revisions
           (agent_id, revision, name, model, instructions, execution_limits,
            capability_grants, created_at)
         SELECT
           agent_id, revision, name, model, instructions, execution_limits,
           capability_grants, created_at
         FROM agent_revisions`,
      );
      state.storage.sql.exec("DROP TABLE agent_revisions");
      state.storage.sql.exec("ALTER TABLE legacy_agent_revisions RENAME TO agent_revisions");
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET budget_reservation = json_set(
           json_remove(budget_reservation, '$.runtimePlan'),
           '$.model',
           json_extract(budget_reservation, '$.runtimePlan.inference.model')
         )`,
      );
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 18");
      await state.storage.sync();
      state.storage.sql.exec("PRAGMA foreign_keys=ON");
    });
    await evictDurableObject(stub);

    await expect(stub.getAgent(authority, { id: created.agent.id })).resolves.toMatchObject({
      agent: {
        capabilities: created.agent.capabilities,
        id: created.agent.id,
      },
      ok: true,
    });
    await expect(stub.verifyRunAdmission(admission.permit)).resolves.toMatchObject({
      configuration: {
        capabilities: created.agent.capabilities,
        runtimePlan: admission.permit.budgetReservation.runtimePlan,
      },
      ok: true,
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

  it("removes the retired local AI budget from existing fleet configuration revisions", async () => {
    const authority = await authorityFor("1010-ai-budget-removal", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE fleet_configuration_revisions
         SET configuration = json_set(
           configuration,
           '$.ai',
           json('{"dailySpendMicrousd":5000000,"runReservationMicrousd":50000}')
         )`,
      );
      state.storage.sql.exec("DROP TABLE agent_inbox_acknowledgements");
      state.storage.sql.exec("DROP TABLE agent_inbox_items");
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 12");
    });
    await evictDurableObject(stub);

    const current = await stub.getFleetConfiguration(authority, { target: { kind: "fleet" } });

    expect(current).toMatchObject({ ok: true });
    expect(current.ok ? Reflect.has(current.configuration.data, "ai") : true).toBe(false);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ value: string | null }>(
            `SELECT json_type(configuration, '$.ai') AS value
             FROM fleet_configuration_revisions
             ORDER BY revision`,
          )
          .toArray(),
      ),
    ).resolves.toEqual([{ value: null }]);
  });

  it("backfills revisioned fleet capacity, retention, and admitted-run retention", async () => {
    const authority = await authorityFor("fleet-capacity-migration", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("fleet-capacity-migration-agent"));

    if (!created.ok) {
      throw new Error("Expected migration fixture Agent.");
    }

    const prompt = "Preserve this admitted run while capacity policy is migrated.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "fleet-capacity-migration-run",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected migration fixture admission.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE fleet_configuration_revisions
         SET configuration = json_remove(configuration, '$.capacity', '$.retention')`,
      );
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET budget_reservation = json_remove(budget_reservation, '$.retentionSeconds')
         WHERE run_id = ?`,
        admission.permit.runId,
      );
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 14");
    });
    await evictDurableObject(stub);

    await expect(
      stub.getFleetConfiguration(authority, { target: { kind: "fleet" } }),
    ).resolves.toMatchObject({
      configuration: {
        data: {
          capacity: {
            maxAgents: DEFAULT_FLEET_MAX_AGENTS,
            maxConcurrentRuns: MAXIMUM_FLEET_CONCURRENT_RUNS,
            maxConnections: MAXIMUM_FLEET_CONNECTIONS,
          },
          retention: {
            inboxSeconds: DEFAULT_FLEET_INBOX_RETENTION_SECONDS,
            runSeconds: DEFAULT_FLEET_RUN_RETENTION_SECONDS,
          },
        },
      },
      ok: true,
    });
    const storedReservation = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ budget_reservation: string }>(
          `SELECT budget_reservation
           FROM run_admissions
           WHERE run_id = ?`,
          admission.permit.runId,
        )
        .one(),
    );

    expect(
      runBudgetReservationSchema.parse(JSON.parse(storedReservation.budget_reservation)),
    ).toMatchObject({
      retentionSeconds: DEFAULT_FLEET_RUN_RETENTION_SECONDS,
    });
  });

  it("backfills the pending Gateway reservation from a populated v10 database", async () => {
    const authority = await authorityFor("1011", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("migration-reservation-agent"));

    if (!created.ok) {
      throw new Error("Expected migration reservation Agent.");
    }

    const prompt = "Preserve the exact pending reservation during migration.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "migration-reservation-run-1011",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected migration reservation admission.");
    }
    await runInDurableObject(stub, (_instance, state) => {
      const recordedAt = Date.now();
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET budget_reservation = json_set(
           budget_reservation,
           '$.aiSpendReservationMicrousd',
           50000
         )
         WHERE run_id = ?`,
        admission.permit.runId,
      );
      state.storage.sql.exec("DROP TABLE ai_gateway_calls");
      state.storage.sql.exec(
        `CREATE TABLE ai_gateway_calls (
           gateway_log_id TEXT PRIMARY KEY NOT NULL,
           run_id TEXT NOT NULL,
           agent_id TEXT NOT NULL,
           status TEXT NOT NULL,
           cost_microusd INTEGER,
           input_tokens INTEGER,
           output_tokens INTEGER,
           recorded_at INTEGER NOT NULL,
           settled_at INTEGER,
           next_reconciliation_at INTEGER NOT NULL,
           reconciliation_attempts INTEGER DEFAULT 0 NOT NULL
         )`,
      );
      state.storage.sql.exec(
        `INSERT INTO ai_gateway_calls (
           gateway_log_id,
           run_id,
           agent_id,
           status,
           recorded_at,
           next_reconciliation_at
         ) VALUES (?, ?, ?, 'pending', ?, ?)`,
        "gateway-log-migration-1011",
        admission.permit.runId,
        admission.permit.agentId,
        recordedAt,
        recordedAt,
      );
      state.storage.sql.exec("DROP TABLE agent_inbox_acknowledgements");
      state.storage.sql.exec("DROP TABLE agent_inbox_items");
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 11");
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ reservation_microusd: number }>(
            `SELECT reservation_microusd
             FROM ai_gateway_calls
             WHERE gateway_log_id = ?`,
            "gateway-log-migration-1011",
          )
          .one(),
      ),
    ).resolves.toEqual({ reservation_microusd: 50_000 });
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

  it("applies a Drizzle table rebuild with populated foreign keys and survives eviction", async () => {
    const authority = await authorityFor("90133", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("rebuild-90133"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await runInDurableObject(stub, async (_instance, state) => {
      const rebuildSql = `PRAGMA foreign_keys=OFF;
                            --> statement-breakpoint
                            CREATE TABLE __new_agents (
                              agent_id text PRIMARY KEY NOT NULL,
                              current_revision integer NOT NULL,
                              status text NOT NULL,
                              created_at integer NOT NULL,
                              disabled_at integer,
                              CONSTRAINT "agents_current_revision_positive"
                                CHECK(current_revision > 0),
                              CONSTRAINT "agents_status"
                                CHECK(status IN ('active', 'disabled')),
                              CONSTRAINT "agents_created_at_positive" CHECK(created_at > 0)
                            );
                            --> statement-breakpoint
                            INSERT INTO __new_agents
                              (agent_id, current_revision, status, created_at, disabled_at)
                              SELECT agent_id, current_revision, status, created_at, disabled_at
                              FROM agents;
                            --> statement-breakpoint
                            DROP TABLE agents;
                            --> statement-breakpoint
                            ALTER TABLE __new_agents RENAME TO agents;
                            --> statement-breakpoint
                            PRAGMA foreign_keys=ON;`;

      await runControlPlaneMigrationTransaction(state.storage, [rebuildSql], () => {
        applyControlPlaneMigrationSql(state.storage, rebuildSql);
      });
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("PRAGMA foreign_keys").one(),
      ),
    ).resolves.toEqual({ foreign_keys: 1 });
    await evictDurableObject(stub);

    await expect(stub.getAgent(authority, { id: created.agent.id })).resolves.toMatchObject({
      agent: { id: created.agent.id, revision: 1 },
      ok: true,
    });
  });

  it("preserves a legacy schedule and its deferred inbox identity through migration", async () => {
    const authority = await authorityFor("90136", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const legacyMigrations = controlPlaneMigrations.slice(0, -2);
    const migrations = await Promise.all(
      legacyMigrations.map(async (migration) => ({
        ...migration,
        checksum: await migrationChecksum(migration.sql),
      })),
    );
    const agentId = "agent_00000000-0000-4000-8000-000000009136";
    const scheduleId = "schedule_00000000-0000-4000-8000-000000009136";
    const createdAt = 1_800_000_000_000;
    const scheduledAt = createdAt + 3_600_000;

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("PRAGMA foreign_keys=OFF");

      for (const { name } of state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .toArray()) {
        state.storage.sql.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
      }

      await state.storage.sync();
      state.storage.sql.exec("PRAGMA foreign_keys=ON");

      const database = drizzle(state.storage, { schema: controlPlaneSchema });

      await runControlPlaneMigrationTransaction(
        state.storage,
        legacyMigrations.map((migration) => migration.sql),
        () => {
          for (const migration of migrations) {
            applyControlPlaneMigration(database, state.storage, migration);
          }
        },
      );

      state.storage.sql.exec(
        `INSERT INTO agents
           (agent_id, current_revision, status, created_at, disabled_at)
         VALUES (?, 1, 'active', ?, NULL)`,
        agentId,
        createdAt,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_revisions
           (agent_id, revision, name, model, capabilities, instructions, execution_limits,
            capability_grants, blueprint_provenance, created_at)
         VALUES (?, 1, 'Legacy Agent', 'gpt-5-mini', '[]', 'Preserve me.',
           '{"maxDurationSeconds":300,"maxModelCalls":5,"maxToolCalls":10}', '[]', NULL, ?)`,
        agentId,
        createdAt,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_schedule_revisions
           (agent_id, revision, agent_revision, configuration, created_at)
         VALUES (?, 1, 1, ?, ?)`,
        agentId,
        JSON.stringify({ intervalSeconds: 3_600, prompt: "Run the legacy responsibility." }),
        createdAt,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_schedules
           (agent_id, current_revision, status, next_run_at, last_run_id, last_dispatched_at,
            created_at)
         VALUES (?, 1, 'active', ?, NULL, NULL, ?)`,
        agentId,
        scheduledAt,
        createdAt,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_inbox_items
           (item_id, agent_id, agent_revision, fleet_revision, schedule_revision, run_id,
            trigger, run_status, kind, approval_count, request_preview, result_preview, reason,
            scheduled_at, retry_at, occurred_at, version, cleanup_at)
         VALUES (?, ?, 1, 1, 1, NULL, NULL, NULL, 'deferred', 0, ?, NULL, 'active_run',
           ?, ?, ?, 'legacy-version', ?)`,
        "inbox_00000000-0000-4000-8000-000000009136",
        agentId,
        "Run the legacy responsibility.",
        scheduledAt,
        scheduledAt + 60_000,
        createdAt,
        createdAt + 86_400_000,
      );

      expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });

    await evictDurableObject(stub);
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await expect(stub.listAgentSchedules(authority, { agentId })).resolves.toMatchObject({
      ok: true,
      schedules: [
        {
          configuration: {
            intervalSeconds: 3_600,
            prompt: "Run the legacy responsibility.",
          },
          id: scheduleId,
          name: "Recurring schedule",
          revision: 1,
          status: "active",
        },
      ],
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        foreignKeys: state.storage.sql.exec("PRAGMA foreign_key_check").toArray(),
        inbox: state.storage.sql
          .exec<{ schedule_id: string }>(
            "SELECT schedule_id FROM agent_inbox_items WHERE item_id = ?",
            "inbox_00000000-0000-4000-8000-000000009136",
          )
          .one(),
      })),
    ).resolves.toEqual({
      foreignKeys: [],
      inbox: { schedule_id: scheduleId },
    });
  });

  it("recovers a populated v2 control plane through the tool-execution migration", async () => {
    const authority = await authorityFor("90135", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("migration-v2-agent"));

    if (!created.ok) {
      throw new Error("Expected migration recovery Agent fixture.");
    }

    const issuedPrompt = "Preserve this issued legacy run.";
    const redeemedPrompt = "Preserve this consumed legacy run.";
    const issued = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "migration-v2-issued",
      promptCharacters: issuedPrompt.length,
      promptDigest: await digestRunPrompt(issuedPrompt),
    });
    const redeemed = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "migration-v2-redeemed",
      promptCharacters: redeemedPrompt.length,
      promptDigest: await digestRunPrompt(redeemedPrompt),
    });

    if (!issued.ok || issued.state !== "issued" || !redeemed.ok || redeemed.state !== "issued") {
      throw new Error("Expected populated legacy run fixtures.");
    }

    await expect(stub.confirmRunAdmission(redeemed.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
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
    ).resolves.toMatchObject({ ok: true });

    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("PRAGMA foreign_keys=OFF");
      state.storage.sql.exec("DROP TABLE agent_schedule_updates");
      state.storage.sql.exec("DROP TABLE agent_schedules");
      state.storage.sql.exec("DROP TABLE agent_schedule_revisions");
      state.storage.sql.exec("DROP TABLE ai_gateway_calls");
      state.storage.sql.exec("DROP TABLE fleet_configuration_updates");
      state.storage.sql.exec("DROP TABLE fleet_configurations");
      state.storage.sql.exec("DROP TABLE fleet_configuration_revisions");
      state.storage.sql.exec("DROP TABLE integration_usage_events");
      state.storage.sql.exec("DROP TABLE integration_enablement_requests");
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec("DROP TABLE tool_executions");
      state.storage.sql.exec("DROP TABLE tool_approvals");
      state.storage.sql.exec("DROP TABLE capability_grants");
      state.storage.sql.exec(
        `CREATE TABLE migration_v2_run_rows AS
         SELECT
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           json_remove(budget_reservation, '$.toolGrants') AS budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at,
           model_call_consumed_at
         FROM run_admissions`,
      );
      state.storage.sql.exec("DROP TABLE run_admissions");
      applyControlPlaneMigrationSql(state.storage, migration1);
      state.storage.sql.exec(
        `INSERT INTO run_admissions (
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at,
           model_call_consumed_at
         )
         SELECT
           client_id,
           idempotency_key,
           request_digest,
           run_id,
           agent_id,
           agent_revision,
           prompt_digest,
           budget_reservation,
           nonce_digest,
           status,
           expires_at,
           cleanup_at,
           created_at,
           redeemed_at,
           model_call_consumed_at
         FROM migration_v2_run_rows`,
      );
      state.storage.sql.exec("DROP TABLE migration_v2_run_rows");
      state.storage.sql.exec("DROP TABLE agent_inbox_acknowledgements");
      state.storage.sql.exec("DROP TABLE agent_inbox_items");
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 3");
      state.storage.sql.exec("PRAGMA foreign_keys=ON");

      await expect(
        runControlPlaneMigrationTransaction(state.storage, [migration2], () => {
          applyControlPlaneMigrationSql(state.storage, migration2);
          throw new Error("Injected migration interruption.");
        }),
      ).rejects.toThrow("Injected migration interruption.");

      expect(
        [
          ...state.storage.sql.exec<{ name: string }>(
            "SELECT name FROM pragma_table_info('run_admissions') ORDER BY cid",
          ),
        ].map((column) => column.name),
      ).not.toContain("model_calls_consumed");
      expect([
        ...state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tool_executions'",
        ),
      ]).toEqual([]);
      expect([...state.storage.sql.exec("PRAGMA foreign_key_check")]).toEqual([]);
    });

    await evictDurableObject(stub);
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      const rows = [
        ...state.storage.sql.exec<{
          budget_reservation: string;
          cancellation_requested_at: number | null;
          cancelled_at: number | null;
          model_calls_consumed: number;
          run_id: string;
        }>(
          `SELECT
             run_id,
             budget_reservation,
             cancellation_requested_at,
             cancelled_at,
             model_calls_consumed
           FROM run_admissions
           WHERE run_id IN (?, ?)
           ORDER BY run_id`,
          issued.permit.runId,
          redeemed.permit.runId,
        ),
      ];

      expect(rows).toHaveLength(2);
      expect(
        rows.map((row) => ({
          modelCallsConsumed: row.model_calls_consumed,
          cancellationRequestedAt: row.cancellation_requested_at,
          cancelledAt: row.cancelled_at,
          runId: row.run_id,
          toolGrants: runBudgetReservationSchema.parse(JSON.parse(row.budget_reservation))
            .toolGrants,
        })),
      ).toEqual(
        [
          {
            cancellationRequestedAt: null,
            cancelledAt: null,
            modelCallsConsumed: 0,
            runId: issued.permit.runId,
            toolGrants: [],
          },
          {
            cancellationRequestedAt: null,
            cancelledAt: null,
            modelCallsConsumed: 1,
            runId: redeemed.permit.runId,
            toolGrants: [],
          },
        ].toSorted((left, right) => left.runId.localeCompare(right.runId)),
      );
      expect([...state.storage.sql.exec("PRAGMA foreign_key_check")]).toEqual([]);
      expect([
        ...state.storage.sql.exec<{ version: number }>(
          "SELECT version FROM control_plane_migrations ORDER BY version",
        ),
      ]).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
        { version: 22 },
        { version: 23 },
        { version: 24 },
        { version: 25 },
        { version: 26 },
        { version: 27 },
        { version: 28 },
      ]);
    });
  });

  it("preserves completed executions through the cancellation timeline migrations", async () => {
    const authority = await authorityFor("90136", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("migration-v4-agent"));

    if (!created.ok) {
      throw new Error("Expected populated v4 migration Agent fixture.");
    }

    const prompt = "Preserve this completed legacy tool execution.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "migration-v4-run",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected populated v4 migration run fixture.");
    }

    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    const toolCallId = "tool_call_90136000-0000-4000-8000-000000000001";
    const unknownToolCallId = "tool_call_90136000-0000-4000-8000-000000000002";

    await runInDurableObject(stub, (_instance, state) => {
      const startedAt = Date.now() - 2;
      const completedAt = startedAt + 1;

      state.storage.sql.exec(
        `INSERT INTO connections
           (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
         VALUES (?, 'composio', ?, ?, 'active', ?)`,
        "connection_90136000-0000-4000-8000-000000000001",
        "ca_migration_v4",
        "ac_migration_v4",
        startedAt,
      );
      state.storage.sql.exec(
        `INSERT INTO capability_grants
           (grant_id, agent_id, agent_revision, connection_id, grant, status, created_at)
         VALUES (?, ?, ?, ?, '{}', 'active', ?)`,
        "grant_90136000-0000-4000-8000-000000000001",
        created.agent.id,
        created.agent.revision,
        "connection_90136000-0000-4000-8000-000000000001",
        startedAt,
      );
      state.storage.sql.exec(
        `INSERT INTO tool_executions
           (tool_call_id, run_id, grant_id, action_digest, effect_digest, input_digest, nonce_digest, status,
            cost_microusd, output_bytes, expires_at, started_at, dispatched_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 0, 16, ?, ?, ?, ?)`,
        toolCallId,
        admission.permit.runId,
        "grant_90136000-0000-4000-8000-000000000001",
        "a".repeat(64),
        "f".repeat(64),
        "0".repeat(64),
        "b".repeat(43),
        completedAt + 1,
        startedAt,
        startedAt,
        completedAt,
      );
      state.storage.sql.exec(
        `INSERT INTO tool_executions
           (tool_call_id, run_id, grant_id, action_digest, effect_digest, input_digest, nonce_digest, status,
            cost_microusd, output_bytes, expires_at, started_at, dispatched_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', 0, 0, ?, ?, ?, ?)`,
        unknownToolCallId,
        admission.permit.runId,
        "grant_90136000-0000-4000-8000-000000000001",
        "c".repeat(64),
        "d".repeat(64),
        "0".repeat(64),
        "e".repeat(43),
        completedAt + 1,
        startedAt,
        startedAt,
        completedAt,
      );
      state.storage.sql.exec("PRAGMA foreign_keys=OFF");
      state.storage.sql.exec("DROP TABLE agent_schedule_updates");
      state.storage.sql.exec("DROP TABLE agent_schedules");
      state.storage.sql.exec("DROP TABLE agent_schedule_revisions");
      state.storage.sql.exec("DROP TABLE ai_gateway_calls");
      state.storage.sql.exec("DROP TABLE fleet_configuration_updates");
      state.storage.sql.exec("DROP TABLE fleet_configurations");
      state.storage.sql.exec("DROP TABLE fleet_configuration_revisions");
      state.storage.sql.exec("DROP TABLE integration_usage_events");
      removeRuntimeToolSchema(state.storage);
      state.storage.sql.exec(
        `CREATE TABLE legacy_tool_executions AS
         SELECT
           tool_call_id, run_id, grant_id, action_digest, nonce_digest, status,
           cost_microusd, output_bytes, expires_at, started_at, completed_at
         FROM tool_executions`,
      );
      state.storage.sql.exec("DROP TABLE tool_executions");
      state.storage.sql.exec("ALTER TABLE legacy_tool_executions RENAME TO tool_executions");
      state.storage.sql.exec("ALTER TABLE tool_approvals DROP COLUMN grant_id");
      state.storage.sql.exec(
        `CREATE TABLE legacy_run_admissions AS
         SELECT
           client_id, idempotency_key, request_digest, run_id, agent_id, agent_revision,
           prompt_digest, budget_reservation, nonce_digest, status, expires_at, cleanup_at,
           created_at, redeemed_at, model_call_consumed_at, model_calls_consumed,
           tool_calls_consumed
         FROM run_admissions`,
      );
      state.storage.sql.exec("DROP TABLE run_admissions");
      state.storage.sql.exec("ALTER TABLE legacy_run_admissions RENAME TO run_admissions");
      state.storage.sql.exec("DROP TABLE agent_inbox_acknowledgements");
      state.storage.sql.exec("DROP TABLE agent_inbox_items");
      removeSkillLibrarySchema(state.storage);
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 5");
      state.storage.sql.exec("PRAGMA foreign_keys=ON");
    });

    await evictDurableObject(stub);
    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, status: "ready" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{
            cancellation_requested_at: number | null;
            cancelled_at: number | null;
            completed_at: number;
            dispatched_at: number;
          }>(
            `SELECT
               run_admissions.cancellation_requested_at,
               run_admissions.cancelled_at,
               tool_executions.dispatched_at,
               tool_executions.completed_at
             FROM run_admissions
             INNER JOIN tool_executions USING (run_id)
             WHERE tool_executions.tool_call_id = ?`,
            toolCallId,
          )
          .one(),
      ).toEqual({
        cancellation_requested_at: null,
        cancelled_at: null,
        completed_at: expect.any(Number),
        dispatched_at: expect.any(Number),
      });
      expect([...state.storage.sql.exec("PRAGMA foreign_key_check")]).toEqual([]);
      expect(
        state.storage.sql
          .exec<{ effect_digest: string; status: string }>(
            "SELECT effect_digest, status FROM tool_executions WHERE tool_call_id = ?",
            unknownToolCallId,
          )
          .one(),
      ).toEqual({ effect_digest: "0".repeat(64), status: "unknown" });
    });
    await expect(
      stub.reconcileToolExecution(authority, {
        resolution: "not_applied",
        toolCallId: unknownToolCallId,
      }),
    ).resolves.toMatchObject({ ok: true, reconciled: true });
  });

  it("preserves admitted Runs while adding Workflow, Brief, and deliverable storage", async () => {
    const authority = await authorityFor("workflow-schema-migration", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("workflow-migration-agent"));

    if (!created.ok) {
      throw new Error("Expected Workflow migration Agent fixture.");
    }

    const prompt = "Preserve this admitted Run while adding durable Workflow storage.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "workflow-migration-run",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    });

    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected Workflow migration Run fixture.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      removeBriefSchema(state.storage);
      removeAgentWorkflowSchema(state.storage);
      applyControlPlaneMigrationSql(state.storage, migration22);
      const now = Date.now();
      const fleetRevision = state.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM fleet_configuration_revisions ORDER BY revision DESC LIMIT 1",
        )
        .one().revision;
      state.storage.sql.exec(
        `INSERT INTO agent_workflows
           (workflow_id, client_id, idempotency_key, request_digest, agent_id, agent_revision,
            fleet_revision, objective, budget, status, workflow_revision, stage_count,
            completed_stages, current_stage_index, current_run_id, created_at, updated_at,
            cleanup_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 3, 2, 0, 0, ?, ?, ?, ?)`,
        "workflow_00000000-0000-4000-8000-000000000923",
        authority.clientId,
        "workflow-migration-existing",
        "w".repeat(43),
        created.agent.id,
        created.agent.revision,
        fleetRevision,
        "Preserve this active Workflow and its exact stage state.",
        JSON.stringify({
          maxDurationSeconds: 90,
          maxModelTokens: 4_000,
          maxToolCalls: 0,
          maxTurns: 8,
        }),
        admission.permit.runId,
        now,
        now,
        now + 86_400_000,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_workflow_stages
           (workflow_id, stage_index, name, prompt, prompt_digest, status, run_id, started_at)
         VALUES (?, 0, 'Existing', 'Preserve this running stage.', ?, 'running', ?, ?)`,
        "workflow_00000000-0000-4000-8000-000000000923",
        "d".repeat(64),
        admission.permit.runId,
        now,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_workflow_stages
           (workflow_id, stage_index, name, prompt, prompt_digest, status)
         VALUES (?, 1, 'Pending', 'Preserve this pending stage.', ?, 'pending')`,
        "workflow_00000000-0000-4000-8000-000000000923",
        "e".repeat(64),
      );
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version >= 24");
      removeRuntimeToolSchema(state.storage);
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: CONTROL_PLANE_SCHEMA_VERSION, usage: { workflows: { active: 1 } } },
    });
    await expect(stub.confirmRunAdmission(admission.permit)).resolves.toMatchObject({
      confirmed: true,
      ok: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        admission: state.storage.sql
          .exec<{ run_id: string; trigger: string }>(
            "SELECT run_id, trigger FROM run_admissions WHERE run_id = ?",
            admission.permit.runId,
          )
          .one(),
        foreignKeys: state.storage.sql.exec("PRAGMA foreign_key_check").toArray(),
        migration: state.storage.sql
          .exec<{ name: string; version: number }>(
            "SELECT name, version FROM control_plane_migrations WHERE version = ?",
            CONTROL_PLANE_SCHEMA_VERSION,
          )
          .one(),
        workflow: state.storage.sql
          .exec<{
            brief_context: string | null;
            current_run_id: string;
            deliverable: string | null;
            deliverable_object_key: string | null;
            status: string;
          }>(
            `SELECT brief_context, current_run_id, deliverable, deliverable_object_key, status
             FROM agent_workflows WHERE workflow_id = ?`,
            "workflow_00000000-0000-4000-8000-000000000923",
          )
          .one(),
      })),
    ).resolves.toEqual({
      admission: { run_id: admission.permit.runId, trigger: "manual" },
      foreignKeys: [],
      migration: {
        name: "0027_classy_switch",
        version: CONTROL_PLANE_SCHEMA_VERSION,
      },
      workflow: {
        brief_context: null,
        current_run_id: admission.permit.runId,
        deliverable: null,
        deliverable_object_key: null,
        status: "running",
      },
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
