import {
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  executeRemoteMcpToolResultSchema,
  createRemoteMcpConnectionResultSchema,
  deleteRemoteMcpConnectionResultSchema,
  inspectRemoteMcpConnectionResultSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
  remoteMcpToolCapabilityGrantSchema,
} from "@crewhelm/contracts";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { agentInput, authorityFor } from "../testkit.js";

const encoder = new TextEncoder();
const catalog = [
  {
    annotations: { readOnlyHint: true },
    description: "Read one project.",
    inputSchema: {
      additionalProperties: false,
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      type: "object" as const,
    },
    name: "projects.read",
  },
];

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function connectionInput(
  idempotencyKey: string,
  authentication: { authKind: "public" } | { authKind: "bearer"; bearerToken: string },
) {
  const serialized = JSON.stringify(catalog);

  return {
    ...authentication,
    catalog,
    catalogBytes: encoder.encode(serialized).byteLength,
    endpoint: "https://mcp.example.com/rpc",
    idempotencyKey,
    name: "Project MCP",
    server: { name: "project-server", version: "1.2.3" },
    snapshotDigest: await digest(serialized),
  };
}

function requestBody(init: RequestInit | undefined): { id?: number; method?: string } {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON-RPC request object.");
  }
  const id = Reflect.get(parsed, "id");
  const method = Reflect.get(parsed, "method");
  return {
    ...(typeof id === "number" ? { id } : {}),
    ...(typeof method === "string" ? { method } : {}),
  };
}

function remoteMcpFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const body = requestBody(init);

    if (body.method === "initialize") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "project-server", version: "1.2.3" },
        },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          content: [
            { text: `authorized:${authorization === "Bearer execution-secret"}`, type: "text" },
          ],
        },
      });
    }
    throw new Error(`Unexpected remote MCP request: ${String(body.method)}`);
  });
}

describe("OwnerControlPlane remote MCP Connections", () => {
  it("creates, inspects, replays, deletes, and audits a public Connection", async () => {
    const authority = await authorityFor("remote-mcp-public", [
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = await connectionInput("remote-mcp-public-create", { authKind: "public" });
    const created = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(authority, input),
    );

    expect(created).toMatchObject({ created: true, ok: true });
    if (!created.ok) throw new Error("Expected remote MCP Connection creation.");

    expect(
      lookupRemoteMcpConnectionCreationResultSchema.parse(
        await stub.lookupRemoteMcpConnectionCreation(authority, {
          authKind: input.authKind,
          endpoint: input.endpoint,
          idempotencyKey: input.idempotencyKey,
          name: input.name,
        }),
      ),
    ).toEqual({ connection: created.connection, ok: true });
    await expect(
      stub.lookupRemoteMcpConnectionCreation(authority, {
        authKind: input.authKind,
        endpoint: input.endpoint,
        idempotencyKey: input.idempotencyKey,
        name: "Different MCP",
      }),
    ).resolves.toMatchObject({ error: { code: "idempotency_conflict" }, ok: false });
    await expect(
      stub.lookupRemoteMcpConnectionCreation(authority, {
        authKind: input.authKind,
        endpoint: input.endpoint,
        idempotencyKey: "remote-mcp-public-fresh",
        name: input.name,
      }),
    ).resolves.toEqual({ connection: null, ok: true });

    await expect(stub.createRemoteMcpConnection(authority, input)).resolves.toMatchObject({
      connection: { connectionId: created.connection.connectionId },
      created: false,
      ok: true,
    });
    expect(
      inspectRemoteMcpConnectionResultSchema.parse(
        await stub.inspectRemoteMcpConnection(authority, {
          connectionId: created.connection.connectionId,
        }),
      ),
    ).toEqual({ connection: created.connection, ok: true });

    const deletion = {
      connectionId: created.connection.connectionId,
      idempotencyKey: "remote-mcp-public-delete",
      snapshotDigest: created.connection.snapshotDigest,
    };
    expect(
      deleteRemoteMcpConnectionResultSchema.parse(
        await stub.deleteRemoteMcpConnection(authority, deletion),
      ),
    ).toEqual({ deleted: true, ok: true });
    await expect(stub.deleteRemoteMcpConnection(authority, deletion)).resolves.toEqual({
      deleted: false,
      ok: true,
    });
    await expect(
      stub.inspectRemoteMcpConnection(authority, {
        connectionId: created.connection.connectionId,
      }),
    ).resolves.toMatchObject({ connection: { status: "revoked" }, ok: true });

    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql.exec("SELECT action FROM audit_events ORDER BY event_id").toArray(),
      ),
    ).resolves.toEqual([
      { action: "connection.remote_mcp_created" },
      { action: "connection.remote_mcp_deleted" },
    ]);
  });

  it("encrypts bearer material and clears it on revocation", async () => {
    const authority = await authorityFor("remote-mcp-bearer", [
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const bearerToken = "bearer-secret-that-must-never-be-stored-in-plaintext";
    const input = await connectionInput("remote-mcp-bearer-create", {
      authKind: "bearer",
      bearerToken,
    });
    const created = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(authority, input),
    );

    if (!created.ok) throw new Error("Expected bearer remote MCP Connection creation.");

    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT credential_ciphertext, credential_nonce
           FROM remote_mcp_connections WHERE connection_id = ?`,
          created.connection.connectionId,
        )
        .one(),
    );

    expect(stored.credential_ciphertext).toEqual(expect.any(String));
    expect(stored.credential_nonce).toEqual(expect.any(String));
    expect(JSON.stringify(stored)).not.toContain(bearerToken);

    await expect(
      stub.changeAuthority(authority, {
        connectionId: created.connection.connectionId,
        target: "connection",
      }),
    ).resolves.toMatchObject({ changed: true, ok: true });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT credential_ciphertext, credential_nonce
             FROM remote_mcp_connections WHERE connection_id = ?`,
            created.connection.connectionId,
          )
          .one(),
      ),
    ).resolves.toEqual({ credential_ciphertext: null, credential_nonce: null });

    await stub.deleteRemoteMcpConnection(authority, {
      connectionId: created.connection.connectionId,
      idempotencyKey: "remote-mcp-bearer-delete",
      snapshotDigest: created.connection.snapshotDigest,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT credential_ciphertext, credential_nonce
             FROM remote_mcp_connections WHERE connection_id = ?`,
            created.connection.connectionId,
          )
          .one(),
      ),
    ).resolves.toEqual({ credential_ciphertext: null, credential_nonce: null });
  });

  it("denies invalid authority, stale deletion, and noncanonical endpoints", async () => {
    const writer = await authorityFor("remote-mcp-denials", [CONNECTIONS_WRITE_SCOPE]);
    const reader = await authorityFor("remote-mcp-denials", [CONNECTIONS_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(writer.ownerKey);
    const input = await connectionInput("remote-mcp-denials-create", { authKind: "public" });

    await expect(stub.createRemoteMcpConnection(reader, input)).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });
    await expect(
      stub.createRemoteMcpConnection(writer, {
        ...input,
        endpoint: "https://mcp.example.com:443/rpc",
        idempotencyKey: "remote-mcp-noncanonical",
      }),
    ).resolves.toMatchObject({ error: { code: "invalid_request" }, ok: false });

    const created = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(writer, input),
    );
    if (!created.ok) throw new Error("Expected remote MCP Connection creation.");

    await expect(
      stub.deleteRemoteMcpConnection(writer, {
        connectionId: created.connection.connectionId,
        idempotencyKey: "remote-mcp-stale-delete",
        snapshotDigest: "0".repeat(64),
      }),
    ).resolves.toMatchObject({ error: { code: "revision_conflict" }, ok: false });
  });

  it("attaches the entire frozen catalog to an Agent without per-tool selection", async () => {
    const authority = await authorityFor("remote-mcp-attachment", [
      AGENTS_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const createdAgent = await stub.createAgent(
      authority,
      agentInput("remote-mcp-attachment-agent", "Remote MCP Agent"),
    );
    if (!createdAgent.ok)
      throw new Error(`Expected Agent creation: ${JSON.stringify(createdAgent)}`);
    const connection = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(
        authority,
        await connectionInput("remote-mcp-attachment-connection", { authKind: "public" }),
      ),
    );
    if (!connection.ok) throw new Error("Expected remote MCP Connection creation.");

    await expect(
      stub.resolveConnectionForAttachment(authority, {
        agentId: createdAgent.agent.id,
        connectionId: connection.connection.connectionId,
        expectedRevision: createdAgent.agent.revision,
      }),
    ).resolves.toMatchObject({ error: { code: "connection_not_found" }, ok: false });

    const configured = await stub.configureAgentRemoteMcpConnection(authority, {
      agentId: createdAgent.agent.id,
      authorization: "approval_required",
      connectionId: connection.connection.connectionId,
      expectedRevision: createdAgent.agent.revision,
      expiresAt: null,
      idempotencyKey: "remote-mcp-attachment-configure",
      limits: {
        maxCallsPerRun: 4,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 0,
        maxDurationMs: 10_000,
        maxOutputBytes: 32_000,
      },
      snapshotDigest: connection.connection.snapshotDigest,
    });

    expect(configured).toMatchObject({
      agent: { capabilityGrants: [expect.stringMatching(/^grant_/)], revision: 2 },
      configured: true,
      ok: true,
    });
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT grant FROM capability_grants").one(),
    );
    if (typeof stored.grant !== "string") throw new Error("Expected a serialized grant.");
    expect(remoteMcpToolCapabilityGrantSchema.parse(JSON.parse(stored.grant))).toMatchObject({
      authorization: "approval_required",
      capabilityId: "remote_mcp.tool.execute",
      connectionId: connection.connection.connectionId,
      effect: "write",
      snapshotDigest: connection.connection.snapshotDigest,
      toolName: "projects.read",
    });

    await stub.deleteRemoteMcpConnection(authority, {
      connectionId: connection.connection.connectionId,
      idempotencyKey: "remote-mcp-attachment-delete",
      snapshotDigest: connection.connection.snapshotDigest,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT revoked_at, status FROM capability_grants WHERE connection_id = ?",
            connection.connection.connectionId,
          )
          .one(),
      ),
    ).resolves.toEqual({ revoked_at: expect.any(Number), status: "revoked" });
  });

  it("dispatches an admitted bearer tool through the owner ledger without exposing its credential", async () => {
    const authority = await authorityFor("remote-mcp-execution", [
      AGENTS_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
      CONNECTIONS_READ_SCOPE,
      CONNECTIONS_WRITE_SCOPE,
      OWNER_WRITE_SCOPE,
      RUNS_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const agent = await stub.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 2_000,
        maxToolCalls: 4,
        maxTurns: 4,
      },
      idempotencyKey: "remote-mcp-execution-agent",
      instructions: "Use the attached remote MCP tool.",
      name: "Remote MCP execution Agent",
    });
    if (!agent.ok) throw new Error("Expected Agent creation.");
    const connection = createRemoteMcpConnectionResultSchema.parse(
      await stub.createRemoteMcpConnection(
        authority,
        await connectionInput("remote-mcp-execution-connection", {
          authKind: "bearer",
          bearerToken: "execution-secret",
        }),
      ),
    );
    if (!connection.ok) throw new Error("Expected remote MCP Connection creation.");
    const configured = await stub.configureAgentRemoteMcpConnection(authority, {
      agentId: agent.agent.id,
      authorization: "standing",
      connectionId: connection.connection.connectionId,
      expectedRevision: agent.agent.revision,
      expiresAt: null,
      idempotencyKey: "remote-mcp-execution-attachment",
      limits: {
        maxCallsPerRun: 4,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 0,
        maxDurationMs: 10_000,
        maxOutputBytes: 32_000,
      },
      snapshotDigest: connection.connection.snapshotDigest,
    });
    if (!configured.ok) throw new Error("Expected remote MCP Agent attachment.");

    const prompt = "Read project alpha.";
    const admission = await stub.createRunAdmission(authority, {
      agentId: configured.agent.id,
      expectedRevision: configured.agent.revision,
      idempotencyKey: "remote-mcp-execution-run",
      promptCharacters: prompt.length,
      promptDigest: await digest(prompt),
    });
    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected remote MCP Run admission.");
    }
    await stub.confirmRunAdmission(admission.permit);
    const grant = admission.permit.budgetReservation.toolGrants[0];
    if (grant?.capabilityId !== "remote_mcp.tool.execute") {
      throw new Error("Expected admitted remote MCP grant.");
    }
    const action = {
      agentId: grant.agentId,
      agentRevision: grant.agentRevision,
      capabilityId: grant.capabilityId,
      connectionId: grant.connectionId,
      effect: grant.effect,
      estimatedCostMicrousd: 0 as const,
      grantId: grant.grantId,
      inputDigest: await digest(JSON.stringify({ projectId: "alpha" })),
      ownerKey: grant.ownerKey,
      runId: admission.permit.runId,
      snapshotDigest: grant.snapshotDigest,
      targetDigests: grant.targetDigests,
      toolCallId: `tool_call_${crypto.randomUUID()}`,
      toolName: grant.toolName,
    };
    const reference = {
      agentId: admission.permit.agentId,
      agentRevision: admission.permit.agentRevision,
      budgetReservation: admission.permit.budgetReservation,
      clientId: admission.permit.clientId,
      idempotencyKey: admission.permit.idempotencyKey,
      ownerKey: admission.permit.ownerKey,
      promptDigest: admission.permit.promptDigest,
      runId: admission.permit.runId,
    };
    const reserved = await stub.reserveToolExecution({ ...reference, action });
    if (!reserved.ok || reserved.state !== "allowed") {
      throw new Error("Expected remote MCP tool reservation.");
    }

    await expect(
      stub.executeRemoteMcpTool({
        arguments: { projectId: "different-project" },
        permit: reserved.permit,
      }),
    ).resolves.toEqual({
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });

    const fetchMock = remoteMcpFetch();
    const executed = executeRemoteMcpToolResultSchema.parse(
      await stub.executeRemoteMcpTool({
        arguments: { projectId: "alpha" },
        permit: reserved.permit,
      }),
    );
    fetchMock.mockRestore();

    expect(executed).toMatchObject({ ok: true });
    if (!executed.ok) throw new Error("Expected remote MCP execution.");
    expect(JSON.parse(executed.outputJson)).toMatchObject({
      content: [{ text: "authorized:true", type: "text" }],
    });
    await expect(
      stub.completeToolExecution({
        outcome: {
          outputBytes: encoder.encode(executed.outputJson).byteLength,
          status: "completed",
        },
        permit: reserved.permit,
      }),
    ).resolves.toEqual({ completed: true, ok: true });
    expect(JSON.stringify(executed)).not.toContain("execution-secret");
  });
});
