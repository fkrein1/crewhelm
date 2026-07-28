import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  runBudgetReservationSchema,
} from "@crewhelm/contracts";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vitest";

import {
  applyControlPlaneMigration,
  applyControlPlaneMigrationSql,
  runControlPlaneMigrationTransaction,
} from "./migrations.js";
import { controlPlaneSchema } from "./schema.js";
import { deriveOwnerKey } from "./identity.js";
import { digestRunPrompt } from "./runs/module.js";
import migration1 from "../../control-plane-migrations/0001_windy_bushwacker.sql";
import migration2 from "../../control-plane-migrations/0002_cool_rictor.sql";

import { agentInput, authorityFor, fixedRunAdmissionFailure } from "./testkit.js";

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
