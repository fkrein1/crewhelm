import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW,
  MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW,
  MAXIMUM_REVISIONS_PER_AGENT,
  MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUN_ADMISSION_LIFETIME_MS,
  agentSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsResultSchema,
  listConnectionsResultSchema,
  ownerAuthoritySchema,
  recordConnectionAuthorizationReturnResultSchema,
  runBudgetReservationSchema,
  type CreateAgentInput,
  type CreateConnectionLinkInput,
  type OwnerAuthority,
  type OwnerScope,
  type UpdateAgentInput,
} from "@crewhelm/contracts";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import {
  applyControlPlaneMigration,
  applyControlPlaneMigrationSql,
  runControlPlaneMigrationTransaction,
} from "../src/control-plane-migrations.js";
import { controlPlaneSchema } from "../src/control-plane-schema.js";
import { deriveOwnerKey } from "../src/owner-identity.js";
import { digestRunPrompt } from "../src/run-admission.js";
import migration1 from "../control-plane-migrations/0001_windy_bushwacker.sql";
import migration2 from "../control-plane-migrations/0002_cool_rictor.sql";

async function authorityFor(
  subject: string,
  scopes: OwnerScope[] = [OWNER_READ_SCOPE],
  clientId = "https://client.example/mcp.json",
): Promise<OwnerAuthority> {
  return ownerAuthoritySchema.parse({
    clientId,
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject,
    }),
    scopes,
  });
}

function agentInput(idempotencyKey: string, name = "Inbox triage"): CreateAgentInput {
  return {
    executionLimits: {
      maxDurationSeconds: 300,
      maxModelTokens: 20_000,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    idempotencyKey,
    instructions: "Sort new work into a concise priority list.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name,
  };
}

function agentUpdate(
  agent: { id: string; revision: number },
  idempotencyKey: string,
  name = "Inbox coordinator",
): UpdateAgentInput {
  return {
    executionLimits: {
      maxDurationSeconds: 600,
      maxModelTokens: 40_000,
      maxToolCalls: 8,
      maxTurns: 8,
    },
    expectedRevision: agent.revision,
    id: agent.id,
    idempotencyKey,
    instructions: "Coordinate the inbox with the owner's approved tools.",
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name,
  };
}

function fixedAgentFailure(code: string) {
  return {
    error: {
      code,
      message: "Agent request denied.",
    },
    ok: false,
  };
}

function connectionLinkInput(
  idempotencyKey: string,
  authConfigId = "ac_github_managed",
): CreateConnectionLinkInput {
  return {
    authConfigId,
    idempotencyKey,
  };
}

function fixedConnectionLinkFailure(code: string) {
  return {
    error: {
      code,
      message: "Connection link request denied.",
    },
    ok: false,
  };
}

function fixedConnectionReadFailure(code: string) {
  return {
    error: {
      code,
      message: "Connection request denied.",
    },
    ok: false,
  };
}

function fixedConnectionAuthorizationReturnFailure() {
  return {
    error: {
      code: "invalid_return",
      message: "Connection authorization return denied.",
    },
    ok: false,
  };
}

function fixedRunAdmissionFailure(code: string) {
  return {
    error: {
      code,
      message: "Run admission denied.",
    },
    ok: false,
  };
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
        schemaVersion: 3,
        status: "ready",
      },
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
      ],
      owner: { owner_key: authority.ownerKey },
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
      status: { schemaVersion: 3, status: "ready" },
    });
    await evictDurableObject(stub);
    await expect(stub.status(first)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: 3, status: "ready" },
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
                              created_at integer NOT NULL,
                              CONSTRAINT "agents_current_revision_positive"
                                CHECK(current_revision > 0),
                              CONSTRAINT "agents_created_at_positive" CHECK(created_at > 0)
                            );
                            --> statement-breakpoint
                            INSERT INTO __new_agents
                              (agent_id, current_revision, created_at)
                              SELECT agent_id, current_revision, created_at FROM agents;
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

  it("recovers a populated v2 control plane through the tool-execution migration", async () => {
    const authority = await authorityFor("90135", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_WRITE_SCOPE,
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
      state.storage.sql.exec("DELETE FROM control_plane_migrations WHERE version = 3");
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
      status: { schemaVersion: 3, status: "ready" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      const rows = [
        ...state.storage.sql.exec<{
          budget_reservation: string;
          model_calls_consumed: number;
          run_id: string;
        }>(
          `SELECT run_id, budget_reservation, model_calls_consumed
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
          runId: row.run_id,
          toolGrants: runBudgetReservationSchema.parse(JSON.parse(row.budget_reservation))
            .toolGrants,
        })),
      ).toEqual(
        [
          { modelCallsConsumed: 0, runId: issued.permit.runId, toolGrants: [] },
          { modelCallsConsumed: 1, runId: redeemed.permit.runId, toolGrants: [] },
        ].toSorted((left, right) => left.runId.localeCompare(right.runId)),
      );
      expect([...state.storage.sql.exec("PRAGMA foreign_key_check")]).toEqual([]);
      expect([
        ...state.storage.sql.exec<{ version: number }>(
          "SELECT version FROM control_plane_migrations ORDER BY version",
        ),
      ]).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
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
        5,
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

  it("reserves, completes, replays, audits, and survives eviction without credentials", async () => {
    const authority = await authorityFor("112", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = connectionLinkInput("connection-link-112");
    const reservation = await stub.reserveConnectionLink(authority, input);

    expect(reservation).toMatchObject({ ok: true, state: "dispatch" });
    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection-link dispatch reservation.");
    }

    const completion = {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_owner_112",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_owner_112",
    };
    const created = await stub.completeConnectionLink(authority, completion);

    expect(created).toMatchObject({
      connectionLink: {
        connectionId: expect.stringMatching(/^connection_/),
        expiresAt: completion.expiresAt,
        url: completion.url,
      },
      created: true,
      ok: true,
    });
    await expect(stub.completeConnectionLink(authority, completion)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      created: false,
      ok: true,
    });
    await expect(stub.reserveConnectionLink(authority, input)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      ok: true,
      state: "replay",
    });

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      audit: state.storage.sql
        .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
        .toArray(),
      connections: state.storage.sql
        .exec(
          `SELECT connection_id, provider, provider_connection_id, auth_config_id, status
           FROM connections`,
        )
        .toArray(),
      requests: state.storage.sql
        .exec(
          `SELECT client_id, idempotency_key, request_digest, auth_config_id, status
           FROM connection_link_requests`,
        )
        .toArray(),
    }));
    const serialized = JSON.stringify(stored);

    expect(stored.audit).toEqual([
      {
        action: "connection.link_reserved",
        subject_id: reservation.reservationId,
      },
      {
        action: "connection.link_created",
        subject_id: created.ok ? created.connectionLink.connectionId : "",
      },
    ]);
    expect(stored.connections).toEqual([
      {
        auth_config_id: input.authConfigId,
        connection_id: created.ok ? created.connectionLink.connectionId : "",
        provider: "composio",
        provider_connection_id: completion.providerConnectionId,
        status: "initiated",
      },
    ]);
    expect(stored.requests).toMatchObject([
      {
        auth_config_id: input.authConfigId,
        client_id: authority.clientId,
        idempotency_key: input.idempotencyKey,
        request_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        status: "completed",
      },
    ]);
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("api_key");

    await evictDurableObject(stub);
    await expect(stub.reserveConnectionLink(authority, input)).resolves.toMatchObject({
      connectionLink: created.ok ? created.connectionLink : {},
      ok: true,
      state: "replay",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          "UPDATE connection_link_requests SET expires_at = 1 WHERE idempotency_key = ?",
          input.idempotencyKey,
        );
        state.storage.sql.exec(
          "UPDATE connection_authorization_returns SET expires_at = 1 WHERE reservation_id = ?",
          reservation.reservationId,
        );
      });
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               r.status,
               r.redirect_url,
               a.status AS authorization_status
             FROM connection_link_requests r
             JOIN connection_authorization_returns a
               ON a.reservation_id = r.reservation_id
             WHERE r.idempotency_key = ?`,
            input.idempotencyKey,
          )
          .one(),
      ),
    ).resolves.toEqual({
      authorization_status: "expired",
      redirect_url: null,
      status: "expired",
    });
    await expect(stub.completeConnectionLink(authority, completion)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_expired"),
    );
  });

  it("records an exact connection authorization return once without claiming activation", async () => {
    const authority = await authorityFor("126", [CONNECTIONS_READ_SCOPE, CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-126"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection authorization return reservation.");
    }

    const providerConnectionId = "ca_authorization_return_126";
    const completion = await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId,
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_126",
    });

    if (!completion.ok) {
      throw new Error("Expected connection authorization return completion.");
    }

    await expect(stub.listConnections(authority, {})).resolves.toMatchObject({
      connections: [{ authorizationOutcome: "pending", status: "initiated" }],
      ok: true,
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId,
      reservationId: reservation.reservationId,
      status: "success",
    };

    expect(
      recordConnectionAuthorizationReturnResultSchema.parse(
        await stub.recordConnectionAuthorizationReturn(input),
      ),
    ).toEqual({ ok: true, outcome: "returned", recorded: true });
    await evictDurableObject(stub);
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual({
      ok: true,
      outcome: "returned",
      recorded: false,
    });
    await expect(
      stub.recordConnectionAuthorizationReturn({ ...input, status: "failed" }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(stub.listConnections(authority, {})).resolves.toEqual({
      connections: [
        {
          authorizationOutcome: "returned",
          authConfigId: "ac_github_managed",
          connectionId: completion.connectionLink.connectionId,
          createdAt: expect.any(String),
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });

    const stored = await runInDurableObject(stub, (_instance, state) => ({
      audit: state.storage.sql
        .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
        .toArray(),
      authorizationReturns: state.storage.sql
        .exec(
          `SELECT reservation_id, token_digest, status, connection_id, completed_at
           FROM connection_authorization_returns`,
        )
        .toArray(),
    }));

    expect(stored.audit).toEqual([
      {
        action: "connection.link_reserved",
        subject_id: reservation.reservationId,
      },
      {
        action: "connection.link_created",
        subject_id: completion.connectionLink.connectionId,
      },
      {
        action: "connection.authorization_returned",
        subject_id: completion.connectionLink.connectionId,
      },
    ]);
    expect(stored.authorizationReturns).toEqual([
      {
        completed_at: expect.any(Number),
        connection_id: completion.connectionLink.connectionId,
        reservation_id: reservation.reservationId,
        status: "returned",
        token_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    ]);
    expect(JSON.stringify(stored)).not.toContain(reservation.authorizationToken);
  });

  it("denies malformed, cross-owner, substituted, and expired authorization returns", async () => {
    const authority = await authorityFor("127", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("128", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-127"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected denied authorization return reservation.");
    }

    await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_authorization_return_127",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_127",
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId: "ca_authorization_return_127",
      reservationId: reservation.reservationId,
      status: "success",
    };

    await expect(
      env.OWNER_CONTROL_PLANE.getByName(other.ownerKey).recordConnectionAuthorizationReturn(input),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({
        ...input,
        authorizationToken: "a".repeat(43),
      }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({
        ...input,
        providerConnectionId: "ca_substituted_127",
      }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await expect(
      stub.recordConnectionAuthorizationReturn({ ...input, credential: "must-not-reflect" }),
    ).resolves.toEqual(fixedConnectionAuthorizationReturnFailure());
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_authorization_returns SET expires_at = 1 WHERE reservation_id = ?",
        reservation.reservationId,
      );
    });
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual(
      fixedConnectionAuthorizationReturnFailure(),
    );
  });

  it("rolls back an authorization return when audit persistence fails", async () => {
    const authority = await authorityFor("130", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("authorization-return-rollback-130"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected an authorization-return rollback reservation.");
    }

    await stub.completeConnectionLink(authority, {
      authorizationToken: reservation.authorizationToken,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      providerConnectionId: "ca_authorization_return_rollback_130",
      reservationId: reservation.reservationId,
      url: "https://connect.composio.dev/link/ln_authorization_return_rollback_130",
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_authorization_return_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.authorization_returned'
        BEGIN
          SELECT RAISE(ABORT, 'forced authorization-return audit failure');
        END
      `);
    });
    const input = {
      authorizationToken: reservation.authorizationToken,
      providerConnectionId: "ca_authorization_return_rollback_130",
      reservationId: reservation.reservationId,
      status: "success",
    };

    await expect(
      runInDurableObject(stub, (instance) => instance.recordConnectionAuthorizationReturn(input)),
    ).rejects.toThrow("forced authorization-return audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        audit: state.storage.sql
          .exec("SELECT action FROM audit_events ORDER BY event_id")
          .toArray(),
        authorizationReturn: state.storage.sql
          .exec(
            `SELECT status, completed_at
             FROM connection_authorization_returns
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
      })),
    ).resolves.toEqual({
      audit: [{ action: "connection.link_reserved" }, { action: "connection.link_created" }],
      authorizationReturn: {
        completed_at: null,
        status: "pending",
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_connection_authorization_return_audit");
    });
    await expect(stub.recordConnectionAuthorizationReturn(input)).resolves.toEqual({
      ok: true,
      outcome: "returned",
      recorded: true,
    });
  });

  it("lists only bounded owner connection summaries across pagination and eviction", async () => {
    const authority = await authorityFor("122", [CONNECTIONS_READ_SCOPE]);
    const other = await authorityFor("123", [CONNECTIONS_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
        VALUES
          ('connection_00000000-0000-4000-8000-000000000001',
           'composio', 'ca_private_1', 'ac_github_managed', 'initiated', 1),
          ('connection_00000000-0000-4000-8000-000000000002',
           'composio', 'ca_private_2', 'ac_slack_managed', 'initiated', 2)
      `);
    });

    const firstPage = listConnectionsResultSchema.parse(
      await stub.listConnections(authority, { limit: 1 }),
    );

    expect(firstPage).toEqual({
      connections: [
        {
          authorizationOutcome: "untracked",
          authConfigId: "ac_github_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000001",
          createdAt: "1970-01-01T00:00:00.001Z",
          status: "initiated",
        },
      ],
      nextCursor: "connection_00000000-0000-4000-8000-000000000001",
      ok: true,
    });
    expect(JSON.stringify(firstPage)).not.toContain("ca_private");

    await evictDurableObject(stub);
    await expect(
      stub.listConnections(authority, {
        cursor: firstPage.ok ? (firstPage.nextCursor ?? undefined) : undefined,
        limit: 1,
      }),
    ).resolves.toEqual({
      connections: [
        {
          authorizationOutcome: "untracked",
          authConfigId: "ac_slack_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000002",
          createdAt: "1970-01-01T00:00:00.002Z",
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });
    await expect(
      env.OWNER_CONTROL_PLANE.getByName(other.ownerKey).listConnections(other, {}),
    ).resolves.toEqual({ connections: [], nextCursor: null, ok: true });
  });

  it("rejects unauthorized, cross-owner, and malformed connection listings", async () => {
    const authority = await authorityFor("124", [CONNECTIONS_READ_SCOPE]);
    const insufficient = await authorityFor("124", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("125", [CONNECTIONS_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.listConnections(insufficient, {})).resolves.toEqual(
      fixedConnectionReadFailure("insufficient_scope"),
    );
    await expect(stub.listConnections(other, {})).resolves.toEqual(
      fixedConnectionReadFailure("owner_mismatch"),
    );
    await expect(
      stub.listConnections(authority, { cursor: "connection_not-an-opaque-id" }),
    ).resolves.toEqual(fixedConnectionReadFailure("invalid_request"));
    await expect(
      stub.listConnections(authority, { credential: "must-not-reflect" }),
    ).resolves.toEqual(fixedConnectionReadFailure("invalid_request"));
  });

  it("rolls back a connection-link reservation when audit persistence fails", async () => {
    const authority = await authorityFor("120", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_reservation_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.link_reserved'
        BEGIN
          SELECT RAISE(ABORT, 'forced reservation audit failure');
        END
      `);
    });

    await expect(
      runInDurableObject(stub, (instance) =>
        instance.reserveConnectionLink(authority, connectionLinkInput("rollback-reservation-120")),
      ),
    ).rejects.toThrow("forced reservation audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM connection_link_requests) AS requests,
               (SELECT COUNT(*) FROM connection_authorization_returns) AS authorization_returns,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
          )
          .one(),
      ),
    ).resolves.toEqual({ audit_events: 0, authorization_returns: 0, requests: 0 });
  });

  it("rolls back a connection-link completion when audit persistence fails", async () => {
    const authority = await authorityFor("121", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("rollback-completion-121"),
    );

    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected connection-link dispatch reservation.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_connection_completion_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'connection.link_created'
        BEGIN
          SELECT RAISE(ABORT, 'forced completion audit failure');
        END
      `);
    });
    await expect(
      runInDurableObject(stub, (instance) =>
        instance.completeConnectionLink(authority, {
          authorizationToken: reservation.authorizationToken,
          expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
          providerConnectionId: "ca_rollback_121",
          reservationId: reservation.reservationId,
          url: "https://connect.composio.dev/link/ln_rollback_121",
        }),
      ),
    ).rejects.toThrow("forced completion audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) => ({
        audit: state.storage.sql
          .exec("SELECT action FROM audit_events ORDER BY event_id")
          .toArray(),
        authorizationReturn: state.storage.sql
          .exec(
            `SELECT status, connection_id, completed_at
             FROM connection_authorization_returns
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
        connections: state.storage.sql.exec("SELECT COUNT(*) AS count FROM connections").one(),
        request: state.storage.sql
          .exec(
            `SELECT status, connection_id, redirect_url, expires_at, completed_at
             FROM connection_link_requests
             WHERE reservation_id = ?`,
            reservation.reservationId,
          )
          .one(),
      })),
    ).resolves.toEqual({
      audit: [{ action: "connection.link_reserved" }],
      authorizationReturn: {
        completed_at: null,
        connection_id: null,
        status: "pending",
      },
      connections: { count: 0 },
      request: {
        completed_at: null,
        connection_id: null,
        expires_at: null,
        redirect_url: null,
        status: "pending",
      },
    });
  });

  it("serializes connection-link intent and scopes idempotency to the MCP client", async () => {
    const first = await authorityFor(
      "113",
      [CONNECTIONS_WRITE_SCOPE],
      "https://first-client.example/mcp.json",
    );
    const second = await authorityFor(
      "113",
      [CONNECTIONS_WRITE_SCOPE],
      "https://second-client.example/mcp.json",
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const [firstResult, concurrentResult] = await Promise.all([
      stub.reserveConnectionLink(first, connectionLinkInput("first-key")),
      stub.reserveConnectionLink(first, connectionLinkInput("concurrent-key")),
    ]);

    expect([firstResult, concurrentResult].filter((result) => result.ok)).toHaveLength(1);
    expect([firstResult, concurrentResult].filter((result) => !result.ok)).toEqual([
      fixedConnectionLinkFailure("connection_link_in_progress"),
    ]);
    await expect(
      stub.reserveConnectionLink(first, connectionLinkInput("first-key", "ac_linear_managed")),
    ).resolves.toEqual(fixedConnectionLinkFailure("idempotency_conflict"));
    await expect(
      stub.reserveConnectionLink(second, connectionLinkInput("first-key")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_in_progress"));
  });

  it("holds an unknown connection-link outcome until its bounded recovery window passes", async () => {
    const authority = await authorityFor("114", [CONNECTIONS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const firstInput = connectionLinkInput("unknown-114");
    const reservation = await stub.reserveConnectionLink(authority, firstInput);

    expect(reservation).toMatchObject({ ok: true, state: "dispatch" });
    await expect(stub.reserveConnectionLink(authority, firstInput)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_outcome_unknown"),
    );
    await expect(
      stub.reserveConnectionLink(authority, connectionLinkInput("blocked-114")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_in_progress"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_link_requests SET recover_after = 1 WHERE idempotency_key = ?",
        firstInput.idempotencyKey,
      );
    });

    await expect(
      stub.reserveConnectionLink(authority, connectionLinkInput("recovered-114")),
    ).resolves.toMatchObject({ ok: true, state: "dispatch" });
    await expect(stub.reserveConnectionLink(authority, firstInput)).resolves.toEqual(
      fixedConnectionLinkFailure("connection_link_outcome_unknown"),
    );
  });

  it("rejects malformed, unauthorized, cross-owner, and late connection completions safely", async () => {
    const authority = await authorityFor("115", [CONNECTIONS_WRITE_SCOPE]);
    const other = await authorityFor("116", [CONNECTIONS_WRITE_SCOPE]);
    const insufficient = await authorityFor("115", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(
      stub.reserveConnectionLink(insufficient, connectionLinkInput("denied-115")),
    ).resolves.toEqual(fixedConnectionLinkFailure("insufficient_scope"));
    await expect(
      stub.reserveConnectionLink(other, connectionLinkInput("cross-owner-115")),
    ).resolves.toEqual(fixedConnectionLinkFailure("owner_mismatch"));
    await expect(
      stub.reserveConnectionLink(authority, {
        ...connectionLinkInput("hostile-115"),
        credential: "must-not-reflect",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));

    const reservation = await stub.reserveConnectionLink(
      authority,
      connectionLinkInput("late-115"),
    );
    if (!reservation.ok || reservation.state !== "dispatch") {
      throw new Error("Expected late-completion reservation.");
    }
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: "a".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_wrong_capability_115",
        reservationId: reservation.reservationId,
        url: "https://connect.composio.dev/link/ln_wrong_capability_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: reservation.authorizationToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_substituted_115",
        reservationId: reservation.reservationId,
        url: "https://attacker.example/link/ln_substituted_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("invalid_request"));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE connection_link_requests SET recover_after = 1 WHERE reservation_id = ?",
        reservation.reservationId,
      );
    });
    await expect(
      stub.completeConnectionLink(authority, {
        authorizationToken: reservation.authorizationToken,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        providerConnectionId: "ca_late_115",
        reservationId: reservation.reservationId,
        url: "https://connect.composio.dev/link/ln_late_115",
      }),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_outcome_unknown"));
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT COUNT(*) AS count FROM connections").one(),
      ),
    ).resolves.toEqual({ count: 0 });
  });

  it("bounds owner-local connection and link-intent storage", async () => {
    const connectionAuthority = await authorityFor("117", [CONNECTIONS_WRITE_SCOPE]);
    const connectionStub = env.OWNER_CONTROL_PLANE.getByName(connectionAuthority.ownerKey);

    await runInDurableObject(connectionStub, (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 1000
        )
        INSERT INTO connections
          (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
        SELECT
          'connection_fixture_' || value,
          'composio',
          'ca_fixture_' || value,
          'ac_fixture',
          'initiated',
          value
        FROM sequence
      `);
    });
    await expect(
      connectionStub.reserveConnectionLink(
        connectionAuthority,
        connectionLinkInput("connection-cap-117"),
      ),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_limit_exceeded"));

    const requestAuthority = await authorityFor("118", [CONNECTIONS_WRITE_SCOPE]);
    const requestStub = env.OWNER_CONTROL_PLANE.getByName(requestAuthority.ownerKey);

    await runInDurableObject(requestStub, (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE sequence(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 5000
        )
        INSERT INTO connection_link_requests
          (client_id, idempotency_key, request_digest, auth_config_id, reservation_id,
           status, recover_after, created_at)
        SELECT
          'fixture-client',
          'fixture-key-' || value,
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'ac_fixture',
          'connection_link_fixture_' || value,
          'abandoned',
          1,
          value
        FROM sequence
      `);
    });
    await expect(
      requestStub.reserveConnectionLink(requestAuthority, connectionLinkInput("request-cap-118")),
    ).resolves.toEqual(fixedConnectionLinkFailure("connection_link_request_limit_exceeded"));
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

  it("creates an immutable initial Agent revision and lists only a bounded summary", async () => {
    const authority = await authorityFor("201", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("create-201");
    const created = await stub.createAgent(authority, input);

    expect(created).toMatchObject({
      created: true,
      ok: true,
      agent: {
        capabilityGrants: [],
        executionLimits: input.executionLimits,
        instructions: input.instructions,
        model: input.model,
        name: input.name,
        revision: 1,
      },
    });
    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }
    expect(agentSchema.parse(created.agent).id).toMatch(/^agent_/);

    await expect(stub.listAgents(authority, {})).resolves.toEqual({
      agents: [
        {
          capabilityGrants: [],
          createdAt: created.agent.createdAt,
          executionLimits: input.executionLimits,
          id: created.agent.id,
          model: input.model,
          name: input.name,
          revision: 1,
        },
      ],
      nextCursor: null,
      ok: true,
    });
    await expect(stub.getAgent(authority, { id: created.agent.id })).resolves.toEqual({
      agent: created.agent,
      ok: true,
    });
  });

  it("reads the current Agent definition durably without creating an audit side effect", async () => {
    const authority = await authorityFor("211", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-211"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await evictDurableObject(stub);
    const result = await stub.getAgent(authority, { id: created.agent.id });

    expect(getAgentResultSchema.parse(result)).toEqual({
      agent: created.agent,
      ok: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT action, subject_id FROM audit_events").toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "agent.created",
        subject_id: created.agent.id,
      },
    ]);
  });

  it("denies malformed, missing, insufficient-scope, and cross-owner Agent reads safely", async () => {
    const first = await authorityFor("212", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
    ]);
    const second = await authorityFor("213", [AGENTS_READ_SCOPE]);
    const legacyRead = await authorityFor("212", [OWNER_READ_SCOPE]);
    const firstStub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const secondStub = env.OWNER_CONTROL_PLANE.getByName(second.ownerKey);
    const created = await firstStub.createAgent(first, agentInput("create-212"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await expect(firstStub.getAgent(legacyRead, { id: created.agent.id })).resolves.toEqual(
      fixedAgentFailure("insufficient_scope"),
    );
    await expect(
      firstStub.listAgentRevisions(legacyRead, { id: created.agent.id }),
    ).resolves.toEqual(fixedAgentFailure("insufficient_scope"));
    await expect(
      firstStub.getAgentRevision(legacyRead, { id: created.agent.id, revision: 1 }),
    ).resolves.toEqual(fixedAgentFailure("insufficient_scope"));
    await expect(firstStub.getAgent(second, { id: created.agent.id })).resolves.toEqual(
      fixedAgentFailure("owner_mismatch"),
    );
    await expect(firstStub.listAgentRevisions(second, { id: created.agent.id })).resolves.toEqual(
      fixedAgentFailure("owner_mismatch"),
    );
    await expect(secondStub.getAgent(second, { id: created.agent.id })).resolves.toEqual(
      fixedAgentFailure("agent_not_found"),
    );
    await expect(
      secondStub.getAgentRevision(second, { id: created.agent.id, revision: 1 }),
    ).resolves.toEqual(fixedAgentFailure("agent_not_found"));
    await expect(
      firstStub.getAgentRevision(first, {
        id: created.agent.id,
        revision: MAXIMUM_REVISIONS_PER_AGENT + 1,
      }),
    ).resolves.toEqual(fixedAgentFailure("agent_not_found"));
    await expect(
      firstStub.getAgent(first, {
        id: "credential-like-value-that-must-not-be-reflected",
        unexpected: true,
      }),
    ).resolves.toEqual(fixedAgentFailure("invalid_request"));
    await expect(
      firstStub.listAgentRevisions(first, {
        cursor: "credential-like-value-that-must-not-be-reflected",
        id: created.agent.id,
      }),
    ).resolves.toEqual(fixedAgentFailure("invalid_request"));
  });

  it("replays exact creation retries and rejects conflicting reuse without duplicate audit", async () => {
    const authority = await authorityFor("202", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("create-202");
    const attempts = await Promise.all([
      stub.createAgent(authority, input),
      stub.createAgent(authority, input),
    ]);
    const conflict = await stub.createAgent(authority, {
      ...input,
      instructions: "Attempt to change an idempotent request.",
    });
    const successful = attempts.filter((attempt) => attempt.ok);

    expect(successful).toHaveLength(2);
    expect(
      successful
        .map((attempt) => attempt.created)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(new Set(successful.map((attempt) => attempt.agent.id)).size).toBe(1);
    expect(conflict).toEqual({
      error: {
        code: "idempotency_conflict",
        message: "Agent request denied.",
      },
      ok: false,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT action, subject_id FROM audit_events").toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "agent.created",
        subject_id: successful[0]?.agent.id,
      },
    ]);
  });

  it("scopes creation idempotency to the authenticated MCP client", async () => {
    const first = await authorityFor("207", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE], "first-client");
    const second = await authorityFor(
      "207",
      [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE],
      "second-client",
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const key = "shared-client-key";
    const firstCreation = await stub.createAgent(first, agentInput(key, "First client Agent"));
    const secondCreation = await stub.createAgent(second, agentInput(key, "Second client Agent"));

    expect(firstCreation).toMatchObject({ created: true, ok: true });
    expect(secondCreation).toMatchObject({ created: true, ok: true });
    if (!firstCreation.ok || !secondCreation.ok) {
      throw new Error("Expected both clients to create an Agent.");
    }
    expect(firstCreation.agent.id).not.toBe(secondCreation.agent.id);
    const listed = await stub.listAgents(first, {});

    expect(listed).toMatchObject({ ok: true });
    if (!listed.ok) {
      throw new Error("Expected both Agents to be listed.");
    }
    expect(
      listed.agents.map((agent) => agent.name).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["First client Agent", "Second client Agent"]);
  });

  it("creates immutable Agent revisions with exact replay and durable audit", async () => {
    const authority = await authorityFor("214", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-214"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const input = agentUpdate(created.agent, "update-214");
    const first = await stub.updateAgent(authority, input);
    const replay = await stub.updateAgent(authority, input);

    expect(first).toMatchObject({
      agent: {
        capabilityGrants: [],
        createdAt: created.agent.createdAt,
        executionLimits: input.executionLimits,
        id: created.agent.id,
        instructions: input.instructions,
        name: input.name,
        revision: 2,
      },
      ok: true,
      updated: true,
    });
    if (!first.ok) {
      throw new Error("Expected Agent update to succeed.");
    }
    expect(replay).toEqual({ ...first, updated: false });
    await evictDurableObject(stub);
    await expect(stub.getAgent(authority, { id: created.agent.id })).resolves.toEqual({
      agent: first.agent,
      ok: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               revision,
               capability_grants,
               name
             FROM agent_revisions
             WHERE agent_id = ?
             ORDER BY revision`,
            created.agent.id,
          )
          .toArray(),
      ),
    ).resolves.toEqual([
      { capability_grants: "[]", name: created.agent.name, revision: 1 },
      { capability_grants: "[]", name: input.name, revision: 2 },
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec("SELECT action, subject_id FROM audit_events ORDER BY event_id")
          .toArray(),
      ),
    ).resolves.toEqual([
      { action: "agent.created", subject_id: created.agent.id },
      { action: "agent.updated", subject_id: created.agent.id },
    ]);
  });

  it("paginates immutable Agent revisions newest first and reads exact history", async () => {
    const authority = await authorityFor("222", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-222"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const firstUpdateInput = agentUpdate(created.agent, "update-222-1", "Inbox coordinator");
    const firstUpdate = await stub.updateAgent(authority, firstUpdateInput);

    if (!firstUpdate.ok) {
      throw new Error("Expected first Agent update to succeed.");
    }

    const secondUpdateInput = agentUpdate(firstUpdate.agent, "update-222-2", "Inbox operator");
    const secondUpdate = await stub.updateAgent(authority, secondUpdateInput);

    if (!secondUpdate.ok) {
      throw new Error("Expected second Agent update to succeed.");
    }

    const firstPage = listAgentRevisionsResultSchema.parse(
      await stub.listAgentRevisions(authority, { id: created.agent.id, limit: 2 }),
    );

    expect(firstPage).toMatchObject({
      nextCursor: 2,
      ok: true,
      revisions: [
        { id: created.agent.id, name: "Inbox operator", revision: 3 },
        { id: created.agent.id, name: "Inbox coordinator", revision: 2 },
      ],
    });
    expect(JSON.stringify(firstPage)).not.toContain("instructions");
    const appendedUpdate = await stub.updateAgent(
      authority,
      agentUpdate(secondUpdate.agent, "update-222-3", "Inbox supervisor"),
    );

    expect(appendedUpdate).toMatchObject({
      agent: { name: "Inbox supervisor", revision: 4 },
      ok: true,
      updated: true,
    });
    const secondPage = listAgentRevisionsResultSchema.parse(
      await stub.listAgentRevisions(authority, {
        cursor: 2,
        id: created.agent.id,
        limit: 2,
      }),
    );

    expect(secondPage).toEqual({
      nextCursor: null,
      ok: true,
      revisions: [
        {
          capabilityGrants: [],
          createdAt: created.agent.createdAt,
          executionLimits: created.agent.executionLimits,
          id: created.agent.id,
          model: created.agent.model,
          name: created.agent.name,
          revisedAt: created.agent.createdAt,
          revision: 1,
        },
      ],
    });
    await evictDurableObject(stub);
    expect(
      getAgentRevisionResultSchema.parse(
        await stub.getAgentRevision(authority, { id: created.agent.id, revision: 1 }),
      ),
    ).toEqual({
      agent: {
        ...created.agent,
        revisedAt: created.agent.createdAt,
      },
      ok: true,
    });
    expect(
      getAgentRevisionResultSchema.parse(
        await stub.getAgentRevision(authority, { id: created.agent.id, revision: 2 }),
      ),
    ).toMatchObject({
      agent: {
        id: created.agent.id,
        instructions: firstUpdateInput.instructions,
        name: firstUpdateInput.name,
        revision: 2,
      },
      ok: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT action FROM audit_events ORDER BY event_id").toArray(),
      ),
    ).resolves.toEqual([
      { action: "agent.created" },
      { action: "agent.updated" },
      { action: "agent.updated" },
      { action: "agent.updated" },
    ]);
  });

  it("rejects conflicting retries, stale revisions, no-ops, and unauthorized updates", async () => {
    const authority = await authorityFor("215", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const legacyAuthority = await authorityFor("215", [OWNER_WRITE_SCOPE]);
    const otherOwner = await authorityFor("216", [AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const otherStub = env.OWNER_CONTROL_PLANE.getByName(otherOwner.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-215"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const update = agentUpdate(created.agent, "update-215");
    await expect(stub.updateAgent(authority, update)).resolves.toMatchObject({
      ok: true,
      updated: true,
    });
    await expect(
      stub.updateAgent(authority, { ...update, name: "Conflicting retry" }),
    ).resolves.toEqual(fixedAgentFailure("idempotency_conflict"));
    await expect(
      stub.updateAgent(authority, { ...update, idempotencyKey: "stale-215" }),
    ).resolves.toEqual(fixedAgentFailure("revision_conflict"));
    await expect(
      stub.updateAgent(authority, {
        ...update,
        expectedRevision: 2,
        idempotencyKey: "noop-215",
      }),
    ).resolves.toEqual(fixedAgentFailure("no_changes"));
    await expect(stub.updateAgent(legacyAuthority, update)).resolves.toEqual(
      fixedAgentFailure("insufficient_scope"),
    );
    await expect(stub.updateAgent(otherOwner, update)).resolves.toEqual(
      fixedAgentFailure("owner_mismatch"),
    );
    await expect(otherStub.updateAgent(otherOwner, update)).resolves.toEqual(
      fixedAgentFailure("agent_not_found"),
    );
    await expect(
      stub.updateAgent(authority, { ...update, unexpected: "credential-like-value" }),
    ).resolves.toEqual(fixedAgentFailure("invalid_request"));
    await expect(
      stub.updateAgent(authority, {
        ...update,
        id: "agent_00000000-0000-4000-8000-000000000000",
        idempotencyKey: "missing-215",
      }),
    ).resolves.toEqual(fixedAgentFailure("agent_not_found"));
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM agent_revisions) AS revisions,
               (SELECT COUNT(*) FROM agent_updates) AS updates,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
          )
          .one(),
      ),
    ).resolves.toEqual({ audit_events: 2, revisions: 2, updates: 1 });
  });

  it("scopes update idempotency to the authenticated MCP client", async () => {
    const first = await authorityFor(
      "217",
      [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE],
      "first-client",
    );
    const second = await authorityFor(
      "217",
      [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE],
      "second-client",
    );
    const stub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const created = await stub.createAgent(first, agentInput("create-217"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const key = "shared-update-key";
    const firstUpdate = await stub.updateAgent(
      first,
      agentUpdate(created.agent, key, "Revision 2"),
    );

    if (!firstUpdate.ok) {
      throw new Error("Expected first update to succeed.");
    }

    await expect(
      stub.updateAgent(second, agentUpdate(firstUpdate.agent, key, "Revision 3")),
    ).resolves.toMatchObject({
      agent: { name: "Revision 3", revision: 3 },
      ok: true,
      updated: true,
    });
    await expect(
      stub.updateAgent(first, agentUpdate(created.agent, key, "Revision 2")),
    ).resolves.toEqual({ ...firstUpdate, updated: false });
  });

  it("serializes concurrent Agent revisions with optimistic concurrency", async () => {
    const authority = await authorityFor("218", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-218"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const attempts = await Promise.all([
      stub.updateAgent(authority, agentUpdate(created.agent, "update-218-a", "Concurrent A")),
      stub.updateAgent(authority, agentUpdate(created.agent, "update-218-b", "Concurrent B")),
    ]);

    expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.ok)).toEqual([
      fixedAgentFailure("revision_conflict"),
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM agent_revisions) AS revisions,
               (SELECT COUNT(*) FROM agent_updates) AS updates,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
          )
          .one(),
      ),
    ).resolves.toEqual({ audit_events: 2, revisions: 2, updates: 1 });
  });

  it("bounds Agent revision storage while preserving exact retries at the ceiling", async () => {
    const authority = await authorityFor("220", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-220"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `WITH RECURSIVE revision_numbers(revision) AS (
             SELECT 2
             UNION ALL
             SELECT revision + 1
             FROM revision_numbers
             WHERE revision < ?
           )
           INSERT INTO agent_revisions
             (agent_id, revision, name, model, instructions, execution_limits,
              capability_grants, created_at)
           SELECT
             source.agent_id,
             revision_numbers.revision,
             source.name,
             source.model,
             source.instructions,
             source.execution_limits,
             source.capability_grants,
             source.created_at
           FROM agent_revisions source
           CROSS JOIN revision_numbers
           WHERE source.agent_id = ? AND source.revision = 1`,
          MAXIMUM_REVISIONS_PER_AGENT - 1,
          created.agent.id,
        );
        state.storage.sql.exec(
          "UPDATE agents SET current_revision = ? WHERE agent_id = ?",
          MAXIMUM_REVISIONS_PER_AGENT - 1,
          created.agent.id,
        );
      });
    });

    const finalInput = agentUpdate(
      { id: created.agent.id, revision: MAXIMUM_REVISIONS_PER_AGENT - 1 },
      "update-220-final",
      "Final allowed revision",
    );
    const finalUpdate = await stub.updateAgent(authority, finalInput);

    expect(finalUpdate).toMatchObject({
      agent: { revision: MAXIMUM_REVISIONS_PER_AGENT },
      ok: true,
      updated: true,
    });
    await expect(stub.updateAgent(authority, finalInput)).resolves.toEqual({
      ...finalUpdate,
      updated: false,
    });
    await expect(
      Promise.all([
        stub.updateAgent(
          authority,
          agentUpdate(
            { id: created.agent.id, revision: MAXIMUM_REVISIONS_PER_AGENT },
            "update-220-over-a",
            "Over ceiling A",
          ),
        ),
        stub.updateAgent(
          authority,
          agentUpdate(
            { id: created.agent.id, revision: MAXIMUM_REVISIONS_PER_AGENT },
            "update-220-over-b",
            "Over ceiling B",
          ),
        ),
      ]),
    ).resolves.toEqual([
      fixedAgentFailure("agent_revision_limit_exceeded"),
      fixedAgentFailure("agent_revision_limit_exceeded"),
    ]);
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT current_revision FROM agents WHERE agent_id = ?) AS current_revision,
               (SELECT COUNT(*) FROM agent_revisions) AS revisions,
               (SELECT COUNT(*) FROM agent_updates) AS updates,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
            created.agent.id,
          )
          .one(),
      ),
    ).resolves.toEqual({
      audit_events: 2,
      current_revision: MAXIMUM_REVISIONS_PER_AGENT,
      revisions: MAXIMUM_REVISIONS_PER_AGENT,
      updates: 1,
    });
  });

  it("rolls back the complete Agent revision when audit persistence fails", async () => {
    const authority = await authorityFor("221", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-221"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_agent_update_audit
        BEFORE INSERT ON audit_events
        WHEN NEW.action = 'agent.updated'
        BEGIN
          SELECT RAISE(ABORT, 'forced audit failure');
        END
      `);
    });
    const input = agentUpdate(created.agent, "update-221");

    await expect(
      runInDurableObject(stub, (instance) => instance.updateAgent(authority, input)),
    ).rejects.toThrow("forced audit failure");
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT current_revision FROM agents WHERE agent_id = ?) AS current_revision,
               (SELECT COUNT(*) FROM agent_revisions) AS revisions,
               (SELECT COUNT(*) FROM agent_updates) AS updates,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
            created.agent.id,
          )
          .one(),
      ),
    ).resolves.toEqual({ audit_events: 1, current_revision: 1, revisions: 1, updates: 0 });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_agent_update_audit");
    });
    await expect(stub.updateAgent(authority, input)).resolves.toMatchObject({
      agent: { revision: 2 },
      ok: true,
      updated: true,
    });
  });

  it("fails closed when an applied schema drifts after eviction", async () => {
    const authority = await authorityFor("219", [
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
      AGENTS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-219"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE agent_updates");
    });
    await evictDurableObject(stub);
    await expect(
      stub.updateAgent(authority, agentUpdate(created.agent, "update-219")),
    ).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("fails closed when a required index keeps its name but changes definition", async () => {
    const authority = await authorityFor("90135", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("index-drift-90135"));

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP INDEX agent_creations_agent_revision");
      state.storage.sql.exec(
        `CREATE UNIQUE INDEX agent_creations_agent_revision
         ON agent_creations (client_id, idempotency_key)`,
      );
    });
    await evictDurableObject(stub);

    await expect(stub.createAgent(authority, agentInput("index-drift-retry"))).resolves.toEqual({
      error: {
        code: "incompatible_schema",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("bounds persistent Agent state and serializes concurrent creation at the ceiling", async () => {
    const authority = await authorityFor("209", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const inputs = Array.from({ length: MAXIMUM_AGENTS_PER_OWNER - 1 }, (_, index) =>
      agentInput(`limit-${index}`, `Limit Agent ${index}`),
    );
    const initial = await Promise.all(inputs.map((input) => stub.createAgent(authority, input)));

    expect(initial.every((result) => result.ok && result.created)).toBe(true);
    const boundary = await Promise.all([
      stub.createAgent(authority, agentInput("limit-boundary-first", "Boundary Agent first")),
      stub.createAgent(authority, agentInput("limit-boundary-second", "Boundary Agent second")),
    ]);
    const created = boundary.filter((result) => result.ok);
    const denied = boundary.filter((result) => !result.ok);

    expect(created).toHaveLength(1);
    expect(denied).toEqual([
      {
        error: {
          code: "agent_limit_exceeded",
          message: "Agent request denied.",
        },
        ok: false,
      },
    ]);
    await expect(stub.createAgent(authority, inputs[0])).resolves.toMatchObject({
      created: false,
      ok: true,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               (SELECT COUNT(*) FROM agents) AS agents,
               (SELECT COUNT(*) FROM agent_revisions) AS revisions,
               (SELECT COUNT(*) FROM agent_creations) AS creations,
               (SELECT COUNT(*) FROM audit_events) AS audit_events`,
          )
          .one(),
      ),
    ).resolves.toEqual({
      agents: MAXIMUM_AGENTS_PER_OWNER,
      audit_events: MAXIMUM_AGENTS_PER_OWNER,
      creations: MAXIMUM_AGENTS_PER_OWNER,
      revisions: MAXIMUM_AGENTS_PER_OWNER,
    });
  });

  it("enforces read and write scopes at the Durable Object boundary", async () => {
    const readAuthority = await authorityFor("203");
    const writeAuthority = await authorityFor("203", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(readAuthority.ownerKey);

    await expect(stub.createAgent(readAuthority, agentInput("create-203"))).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
    await expect(stub.listAgents(writeAuthority, {})).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
    await expect(stub.status(writeAuthority)).resolves.toEqual({
      error: {
        code: "insufficient_scope",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  });

  it("rejects malformed creation without reflecting or persisting hostile input", async () => {
    const authority = await authorityFor("208", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const hostile = "credential-like-value-that-must-not-be-reflected";
    const denied = await stub.createAgent(authority, {
      ...agentInput("create-208"),
      instructions: hostile,
      unexpectedSecret: hostile,
    });

    expect(denied).toEqual({
      error: {
        code: "invalid_request",
        message: "Agent request denied.",
      },
      ok: false,
    });
    expect(JSON.stringify(denied)).not.toContain(hostile);
    await expect(stub.listAgents(authority, {})).resolves.toEqual({
      agents: [],
      nextCursor: null,
      ok: true,
    });
  });

  it("keeps Agent state owner-scoped and durable across eviction", async () => {
    const first = await authorityFor("204", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const second = await authorityFor("205", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const firstStub = env.OWNER_CONTROL_PLANE.getByName(first.ownerKey);
    const secondStub = env.OWNER_CONTROL_PLANE.getByName(second.ownerKey);
    const created = await firstStub.createAgent(first, agentInput("create-204"));

    expect(created).toMatchObject({ created: true, ok: true });
    await expect(secondStub.listAgents(second, {})).resolves.toMatchObject({
      agents: [],
      ok: true,
    });
    await evictDurableObject(firstStub);
    await expect(firstStub.listAgents(first, {})).resolves.toMatchObject({
      agents: [{ name: "Inbox triage", revision: 1 }],
      ok: true,
    });
    await expect(firstStub.listAgents(second, {})).resolves.toMatchObject({
      error: { code: "owner_mismatch" },
      ok: false,
    });
  });

  it("issues, rotates, verifies, redeems, and audits an opaque run admission durably", async () => {
    const authority = await authorityFor("230", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-230"));
    const prompt = "Summarize the private inbox without exposing its contents.";

    if (!created.ok) {
      throw new Error("Expected run-admission fixture Agent.");
    }

    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "admit-run-230",
      promptCharacters: prompt.length,
      promptDigest: await digestRunPrompt(prompt),
    };
    const first = await stub.createRunAdmission(authority, input);

    expect(first).toMatchObject({
      created: true,
      ok: true,
      permit: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
        budgetReservation: {
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + prompt.length,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: expect.stringMatching(/^budget_/),
        },
        clientId: authority.clientId,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        ownerKey: authority.ownerKey,
        promptDigest: input.promptDigest,
        runId: expect.stringMatching(/^run_/),
      },
      state: "issued",
    });
    if (!first.ok || first.state !== "issued") {
      throw new Error("Expected first run admission.");
    }
    expect(Date.parse(first.permit.expiresAt) - Date.now()).toBeGreaterThan(0);
    expect(Date.parse(first.permit.expiresAt) - Date.now()).toBeLessThanOrEqual(
      RUN_ADMISSION_LIFETIME_MS,
    );

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT
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
             redeemed_at
           FROM run_admissions`,
        )
        .one(),
    );

    expect(stored).toMatchObject({
      agent_id: created.agent.id,
      agent_revision: created.agent.revision,
      client_id: authority.clientId,
      idempotency_key: input.idempotencyKey,
      nonce_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      prompt_digest: input.promptDigest,
      request_digest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      run_id: first.permit.runId,
      status: "issued",
    });
    expect(JSON.stringify(stored)).not.toContain(first.permit.nonce);
    expect(JSON.stringify(stored)).not.toContain(prompt);

    const nearRetentionBoundary = Date.now() + 1_000;
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE run_admissions
         SET expires_at = ?, cleanup_at = ?
         WHERE run_id = ?`,
        nearRetentionBoundary,
        nearRetentionBoundary + 1,
        first.permit.runId,
      );
    });
    await evictDurableObject(stub);
    const replay = await stub.createRunAdmission(authority, input);

    expect(replay).toMatchObject({
      created: false,
      ok: true,
      permit: { runId: first.permit.runId },
      state: "issued",
    });
    if (!replay.ok || replay.state !== "issued") {
      throw new Error("Expected issued run-admission replay.");
    }
    expect(replay.permit.nonce).not.toBe(first.permit.nonce);
    expect(replay.permit.expiresAt).toBe(new Date(nearRetentionBoundary).toISOString());
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT
               cleanup_at,
               cleanup_at > expires_at AS retained_after_expiry,
               created_at,
               expires_at
             FROM run_admissions
             WHERE run_id = ?`,
            replay.permit.runId,
          )
          .one(),
      ),
    ).resolves.toMatchObject({
      cleanup_at: nearRetentionBoundary + 1,
      created_at: stored.created_at,
      expires_at: nearRetentionBoundary,
      retained_after_expiry: 1,
    });
    await expect(stub.verifyRunAdmission(first.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(stub.verifyRunAdmission(replay.permit)).resolves.toEqual({
      configuration: {
        agentId: created.agent.id,
        capabilityGrants: [],
        executionLimits: created.agent.executionLimits,
        instructions: created.agent.instructions,
        model: created.agent.model,
        ownerKey: authority.ownerKey,
        revision: created.agent.revision,
      },
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.confirmRunAdmission(replay.permit)).resolves.toEqual({
      confirmed: true,
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.confirmRunAdmission(replay.permit)).resolves.toEqual({
      confirmed: false,
      ok: true,
      runId: first.permit.runId,
    });
    const activeVerification = {
      agentId: replay.permit.agentId,
      agentRevision: replay.permit.agentRevision,
      budgetReservation: replay.permit.budgetReservation,
      clientId: replay.permit.clientId,
      idempotencyKey: replay.permit.idempotencyKey,
      ownerKey: replay.permit.ownerKey,
      promptDigest: replay.permit.promptDigest,
      runId: replay.permit.runId,
    };

    await expect(stub.verifyActiveRunAdmission(activeVerification)).resolves.toEqual({
      ok: true,
      runId: first.permit.runId,
    });
    await expect(stub.verifyActiveRunAdmission(activeVerification)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT model_call_consumed_at IS NOT NULL AS consumed FROM run_admissions WHERE run_id = ?",
            first.permit.runId,
          )
          .one(),
      ),
    ).resolves.toEqual({ consumed: 1 });
    await expect(stub.createRunAdmission(authority, input)).resolves.toEqual({
      admission: {
        agentId: created.agent.id,
        agentRevision: created.agent.revision,
        expiresAt: replay.permit.expiresAt,
        runId: first.permit.runId,
        status: "redeemed",
      },
      created: false,
      ok: true,
      state: "redeemed",
    });
    await expect(stub.verifyRunAdmission(replay.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec("SELECT action, client_id, subject_id FROM audit_events ORDER BY event_id")
          .toArray(),
      ),
    ).resolves.toEqual([
      {
        action: "agent.created",
        client_id: authority.clientId,
        subject_id: created.agent.id,
      },
      {
        action: "run.admitted",
        client_id: authority.clientId,
        subject_id: first.permit.runId,
      },
      {
        action: "run.admission_redeemed",
        client_id: authority.clientId,
        subject_id: first.permit.runId,
      },
    ]);
  });

  it("denies malformed, unauthorized, conflicting, cross-owner, stale, and expired admissions", async () => {
    const authority = await authorityFor("231", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const readOnly = await authorityFor("231", [OWNER_READ_SCOPE]);
    const other = await authorityFor("232", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const otherStub = env.OWNER_CONTROL_PLANE.getByName(other.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-231"));

    if (!created.ok) {
      throw new Error("Expected denied-admission fixture Agent.");
    }

    const promptDigest = await digestRunPrompt("Perform the exact admitted task.");
    const input = {
      agentId: created.agent.id,
      expectedRevision: created.agent.revision,
      idempotencyKey: "admit-run-231",
      promptCharacters: "Perform the exact admitted task.".length,
      promptDigest,
    };

    await expect(stub.createRunAdmission(readOnly, input)).resolves.toEqual(
      fixedRunAdmissionFailure("insufficient_scope"),
    );
    await expect(
      stub.createRunAdmission(authority, { ...input, unexpectedSecret: "must-not-reflect" }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_request"));
    await expect(
      stub.createRunAdmission(authority, { ...input, expectedRevision: 2 }),
    ).resolves.toEqual(fixedRunAdmissionFailure("revision_conflict"));

    const issued = await stub.createRunAdmission(authority, input);

    if (!issued.ok || issued.state !== "issued") {
      throw new Error("Expected denied-admission permit.");
    }

    await expect(
      stub.createRunAdmission(authority, {
        ...input,
        promptDigest: await digestRunPrompt("Conflicting task."),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("idempotency_conflict"));

    for (const permit of [
      { ...issued.permit, clientId: "https://other-client.example/mcp.json" },
      {
        ...issued.permit,
        budgetReservation: {
          ...issued.permit.budgetReservation,
          maxOutputTokens: issued.permit.budgetReservation.maxOutputTokens + 1,
        },
      },
      { ...issued.permit, nonce: "A".repeat(43) },
      { ...issued.permit, ownerKey: other.ownerKey },
      { ...issued.permit, promptDigest: "a".repeat(64) },
    ]) {
      await expect(stub.verifyRunAdmission(permit)).resolves.toEqual(
        fixedRunAdmissionFailure("invalid_admission"),
      );
    }
    await expect(
      otherStub.verifyRunAdmission({ ...issued.permit, ownerKey: other.ownerKey }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));

    const updated = await stub.updateAgent(
      authority,
      agentUpdate(created.agent, "update-run-agent-231"),
    );

    expect(updated).toMatchObject({ ok: true });
    await expect(stub.verifyRunAdmission(issued.permit)).resolves.toEqual(
      fixedRunAdmissionFailure("invalid_admission"),
    );

    const fresh = await stub.createRunAdmission(authority, {
      ...input,
      expectedRevision: 2,
      idempotencyKey: "expire-run-231",
    });

    if (!fresh.ok || fresh.state !== "issued") {
      throw new Error("Expected expiring run admission.");
    }
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE run_admissions SET expires_at = 1 WHERE run_id = ?",
        fresh.permit.runId,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(
      stub.confirmRunAdmission({
        ...fresh.permit,
        expiresAt: new Date(1).toISOString(),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("invalid_admission"));
    await expect(
      stub.createRunAdmission(authority, {
        ...input,
        expectedRevision: 2,
        idempotencyKey: "expire-run-231",
      }),
    ).resolves.toMatchObject({
      admission: { runId: fresh.permit.runId, status: "expired" },
      created: false,
      ok: true,
      state: "expired",
    });
  });

  it("bounds retained run admissions per owner", async () => {
    const authority = await authorityFor("233", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-233"));

    if (!created.ok) {
      throw new Error("Expected run-admission limit fixture Agent.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1
           FROM sequence
           WHERE value < ?
         )
         INSERT INTO run_admissions (
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
           redeemed_at
         )
         SELECT
           'fixture-client',
           'fixture-key-' || value,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_fixture_' || value,
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           9999999999999,
           1,
           1
         FROM sequence`,
        MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: created.agent.executionLimits.maxModelTokens,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: "budget_22222222-2222-4222-8222-222222222222",
        }),
      );
    });

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-run-limit-233",
        promptCharacters: "This run exceeds the retained-record limit.".length,
        promptDigest: await digestRunPrompt("This run exceeds the retained-record limit."),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("admission_limit_exceeded"));
  });

  it("atomically reserves from a finite rolling owner model-call budget", async () => {
    const authority = await authorityFor("234", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const created = await stub.createAgent(authority, agentInput("create-run-agent-234"));

    if (!created.ok) {
      throw new Error("Expected run-budget fixture Agent.");
    }

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `WITH RECURSIVE sequence(value) AS (
           SELECT 1
           UNION ALL
           SELECT value + 1
           FROM sequence
           WHERE value < ?
         )
         INSERT INTO run_admissions (
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
           model_call_consumed_at,
           model_calls_consumed
         )
         SELECT
           'fixture-client',
           'budget-key-' || value,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_budget_fixture_' || value,
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           ?,
           ?,
           1,
           1,
           1
         FROM sequence`,
        MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: 1,
          model: created.agent.model,
          maxOutputTokens: 1,
          maxToolCalls: 0,
          maxTurns: 1,
          reservationId: "budget_22222222-2222-4222-8222-222222222222",
        }),
        Date.now() + 24 * 60 * 60 * 1_000,
        Date.now(),
      );
    });

    const prompt = "This run exceeds the rolling owner model-call budget.";

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-run-budget-234",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("budget_exhausted"));
  });

  it("reserves the aggregate output allowance for every admitted model step", async () => {
    const authority = await authorityFor("235", [OWNER_WRITE_SCOPE, AGENTS_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = agentInput("create-run-agent-235");
    const created = await stub.createAgent(authority, {
      ...input,
      executionLimits: {
        ...input.executionLimits,
        maxModelTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
        maxTurns: 100,
      },
    });

    if (!created.ok) {
      throw new Error("Expected aggregate output-budget fixture Agent.");
    }

    const reservedModelCalls = Math.floor(
      MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW / MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
    );

    await runInDurableObject(stub, (_instance, state) => {
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
           redeemed_at
         ) VALUES (
           'fixture-client',
           'aggregate-output-budget',
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'run_aggregate_output_budget',
           ?,
           1,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           ?,
           'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
           'redeemed',
           1,
           ?,
           ?,
           1
         )`,
        created.agent.id,
        JSON.stringify({
          maxDurationSeconds: created.agent.executionLimits.maxDurationSeconds,
          maxInputCharacters: created.agent.instructions.length + 1,
          maxModelCalls: reservedModelCalls,
          model: created.agent.model,
          maxOutputTokens: MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
          maxToolCalls: 0,
          maxTurns: reservedModelCalls,
          reservationId: "budget_23522222-2222-4222-8222-222222222222",
          toolGrants: [],
        }),
        Date.now() + 24 * 60 * 60 * 1_000,
        Date.now(),
      );
    });

    const prompt = "This additional step exceeds the aggregate owner output budget.";

    await expect(
      stub.createRunAdmission(authority, {
        agentId: created.agent.id,
        expectedRevision: created.agent.revision,
        idempotencyKey: "over-output-budget-235",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      }),
    ).resolves.toEqual(fixedRunAdmissionFailure("budget_exhausted"));
  });

  it("paginates Agent summaries by stable opaque ID without overlap", async () => {
    const authority = await authorityFor("206", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    for (const index of [1, 2, 3]) {
      await expect(
        stub.createAgent(authority, agentInput(`create-206-${index}`, `Agent ${index}`)),
      ).resolves.toMatchObject({ created: true, ok: true });
    }

    const firstPage = await stub.listAgents(authority, { limit: 2 });
    expect(firstPage).toMatchObject({ agents: [{}, {}], ok: true });
    if (!firstPage.ok || firstPage.nextCursor === null) {
      throw new Error("Expected a second Agent page.");
    }
    const secondPage = await stub.listAgents(authority, {
      cursor: firstPage.nextCursor,
      limit: 2,
    });

    expect(secondPage).toMatchObject({ agents: [{}], nextCursor: null, ok: true });
    if (!secondPage.ok) {
      throw new Error("Expected second Agent page.");
    }
    const ids = [...firstPage.agents, ...secondPage.agents].map((agent) => agent.id);
    expect(new Set(ids).size).toBe(3);
  });
});
