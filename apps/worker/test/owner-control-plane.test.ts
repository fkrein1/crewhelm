import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_REVISIONS_PER_AGENT,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  agentSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsResultSchema,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type OwnerAuthority,
  type OwnerScope,
  type UpdateAgentInput,
} from "@crewhelm/contracts";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { deriveOwnerKey } from "../src/owner-identity.js";

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
        schemaVersion: 2,
        status: "ready",
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
      status: { schemaVersion: 2, status: "ready" },
    });
    await evictDurableObject(stub);
    await expect(stub.status(first)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: 2, status: "ready" },
    });
    await expect(stub.status(second)).resolves.toMatchObject({
      error: { code: "owner_mismatch" },
      ok: false,
    });
  });

  it("migrates a bound version 1 object atomically before serving requests", async () => {
    const authority = await authorityFor("109");
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: 2 },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("ALTER TABLE control_plane RENAME TO control_plane_v2");
        state.storage.sql.exec(`
          CREATE TABLE control_plane (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_key TEXT NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL CHECK (schema_version = 1)
          )
        `);
        state.storage.sql.exec(`
          INSERT INTO control_plane (singleton, owner_key, schema_version)
          SELECT singleton, owner_key, 1 FROM control_plane_v2
        `);
        state.storage.sql.exec("DROP TABLE control_plane_v2");
        state.storage.sql.exec("DROP TABLE agent_updates");
        state.storage.sql.exec("DROP TABLE agent_creations");
        state.storage.sql.exec("DROP TABLE agent_revisions");
        state.storage.sql.exec("DROP TABLE agents");
        state.storage.sql.exec("DROP TABLE audit_events");
      });
    });
    await evictDurableObject(stub);

    await expect(stub.status(authority)).resolves.toEqual({
      ok: true,
      status: {
        schemaVersion: 2,
        status: "ready",
      },
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT owner_key, schema_version FROM control_plane").toArray(),
      ),
    ).resolves.toEqual([{ owner_key: authority.ownerKey, schema_version: 2 }]);
  });

  it("fails closed instead of guessing how to migrate an unknown schema", async () => {
    const authority = await authorityFor("110", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    await expect(stub.status(authority)).resolves.toMatchObject({ ok: true });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        state.storage.sql.exec("ALTER TABLE control_plane RENAME TO control_plane_v2");
        state.storage.sql.exec(`
          CREATE TABLE control_plane (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_key TEXT NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL CHECK (schema_version = 3)
          )
        `);
        state.storage.sql.exec(`
          INSERT INTO control_plane (singleton, owner_key, schema_version)
          SELECT singleton, owner_key, 3 FROM control_plane_v2
        `);
        state.storage.sql.exec("DROP TABLE control_plane_v2");
      });
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

  it("reconstructs additive Agent update storage after eviction", async () => {
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
    ).resolves.toMatchObject({
      agent: { revision: 2 },
      ok: true,
      updated: true,
    });
    await expect(stub.status({ ...authority, scopes: [OWNER_READ_SCOPE] })).resolves.toMatchObject({
      ok: true,
      status: { schemaVersion: 2 },
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
