import {
  MAXIMUM_AGENTS_PER_OWNER,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  agentSchema,
  ownerAuthoritySchema,
  type CreateAgentInput,
  type OwnerAuthority,
  type OwnerScope,
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
    const authority = await authorityFor("201", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
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
