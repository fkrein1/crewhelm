import { describe, expect, it } from "vitest";
import * as z from "zod";

import { runWorkflowSmoke } from "../src/workflow-smoke.js";

const origin = "https://crewhelm-testing.example";
const fingerprint = "a".repeat(64);
const timestamp = "2026-07-31T12:00:00.000Z";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const workflowId = "workflow_22222222-2222-4222-8222-222222222222";
const credential = {
  clientId: "rehearsal-client",
  origin,
  refreshToken: "old-refresh-token",
  schemaVersion: 1 as const,
  scope: "crewhelm:full" as const,
};
const mcpRequestSchema = z.looseObject({
  id: z.number(),
  method: z.string(),
  params: z.looseObject({
    arguments: z.record(z.string(), z.unknown()).optional(),
    name: z.string().optional(),
  }),
});

function publicPayload(path: string): unknown {
  if (path === "/health") {
    return {
      deployment: { fingerprint, protocolVersion: 1 },
      service: "crewhelm",
      status: "ok",
    };
  }
  if (path === "/.well-known/oauth-protected-resource") {
    return {
      authorization_servers: [`${origin}/api/auth`],
      bearer_methods_supported: ["header"],
      resource: `${origin}/mcp`,
      scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    };
  }
  return {
    authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: `${origin}/api/auth`,
    jwks_uri: `${origin}/api/auth/jwks`,
    registration_endpoint: `${origin}/api/auth/oauth2/register`,
    response_modes_supported: ["query"],
    response_types_supported: ["code"],
    revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
    scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    token_endpoint: `${origin}/api/auth/oauth2/token`,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function status(activeAgents: number) {
  return {
    guidance: [],
    ok: true,
    status: {
      capacity: {
        maxAgents: 100,
        maxConcurrentRuns: 25,
        maxConnections: 100,
        retention: { inboxSeconds: 2_592_000, runSeconds: 86_400 },
      },
      configurationRevision: 1,
      schemaVersion: 15,
      status: "ready",
      usage: {
        agents: { active: activeAgents, total: 9 },
        connections: { active: 0, pending: 0, total: 0 },
        diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
        inbox: {
          actionRequired: 0,
          attention: { needsAction: 0, oldestNeedsActionAt: null, warnings: 0 },
          deferred: 0,
          exceptions: 0,
          outcomes: 0,
          total: 0,
        },
        runs: { active: 0 },
        skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
        workflows: { active: 0, total: 1 },
      },
    },
  };
}

function agent(name = "Crewhelm Workflow smoke fixture", instructions = "fixture instructions") {
  return {
    capabilities: [
      {
        configuration: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" },
        id: "inference.workers-ai",
        schemaVersion: 1,
      },
    ],
    capabilityGrants: [],
    createdAt: timestamp,
    executionLimits: {
      maxDurationSeconds: 90,
      maxModelTokens: 1_024,
      maxToolCalls: 0,
      maxTurns: 2,
    },
    id: agentId,
    instructions,
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name,
    revision: 1,
    status: "active",
  };
}

function workflowSummary(
  workflowState: "queued" | "running" | "completed" | "cancelled",
  revision: number,
) {
  const completed = workflowState === "completed";
  const terminal = completed || workflowState === "cancelled";
  return {
    agentId,
    agentRevision: 1,
    budget: {
      maxDurationSeconds: 90,
      maxModelTokens: 2_048,
      maxToolCalls: 0,
      maxTurns: 4,
    },
    completedAt: terminal ? timestamp : null,
    completedStages: completed ? 2 : 0,
    createdAt: timestamp,
    currentRunId: null,
    currentStage: terminal
      ? null
      : {
          completedAt: null,
          index: 0,
          name: "Observe",
          runId: null,
          startedAt: workflowState === "running" ? timestamp : null,
          status: workflowState === "queued" ? "pending" : workflowState,
        },
    failure: null,
    revision,
    stageCount: 2,
    status: workflowState,
    updatedAt: timestamp,
    workflowId,
  };
}

function inspectedWorkflow(workflowState: "running" | "completed" | "cancelled", revision: number) {
  const summary = workflowSummary(workflowState, revision);
  return {
    ...summary,
    deliverable: null,
    objective: "Produce one concise two-step rehearsal acknowledgment.",
    session: null,
    stages: [
      {
        completedAt: workflowState === "completed" ? timestamp : null,
        index: 0,
        name: "Observe",
        runId: null,
        startedAt: timestamp,
        status:
          workflowState === "completed"
            ? "completed"
            : workflowState === "cancelled"
              ? "cancelled"
              : "running",
      },
      {
        completedAt: workflowState === "completed" ? timestamp : null,
        index: 1,
        name: "Conclude",
        runId: null,
        startedAt: workflowState === "completed" ? timestamp : null,
        status:
          workflowState === "completed"
            ? "completed"
            : workflowState === "cancelled"
              ? "cancelled"
              : "pending",
      },
    ],
  };
}

function toolResult(id: number, payload: unknown, isError = false): Response {
  return Response.json({
    id,
    jsonrpc: "2.0",
    result: { content: [{ text: JSON.stringify(payload), type: "text" }], isError },
  });
}

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unexpected request body type.");
}

describe("Workflow feature rehearsal", () => {
  it("proves replay, denial, compact discovery, completion, deletion, and cleanup", async () => {
    const revoked = new Set<string>();
    const persisted: unknown[] = [];
    let activeAgents = 3;
    let agentCreates = 0;
    let workflowStarts = 0;
    let workflowInspects = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      if (init?.method !== "POST") return Response.json(publicPayload(url.pathname));

      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "secret-bearer-value",
          expires_in: 900,
          refresh_token: "rotated-refresh-token",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(requestBodyText(init.body)).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname !== "/mcp") throw new Error(`Unexpected request: ${url.pathname}`);
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (revoked.has(token)) return new Response(null, { status: 401 });

      const request = mcpRequestSchema.parse(JSON.parse(requestBodyText(init.body)));
      if (request.method === "initialize") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "crewhelm", version: "test" },
          },
        });
      }
      if (request.method === "tools/list") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              "crewhelm_agent_workflows",
              "crewhelm_batch_disable_agents",
              "crewhelm_briefs",
              "crewhelm_create_agent",
              "crewhelm_get_agent",
              "crewhelm_list_agents",
              "crewhelm_status",
              ...Array.from({ length: 27 }, (_, index) => `crewhelm_fixture_${index}`),
            ].map((name) => ({
              annotations: {
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
                readOnlyHint: false,
              },
              inputSchema: {},
              name,
            })),
          },
        });
      }

      const name = request.params.name;
      const toolArguments = request.params.arguments ?? {};
      if (name === "crewhelm_status") return toolResult(request.id, status(activeAgents));
      if (name === "crewhelm_create_agent") {
        agentCreates += 1;
        if (agentCreates === 1) {
          activeAgents += 1;
          return new Response("Injected lost Agent create response.", { status: 503 });
        }
        return toolResult(request.id, {
          agent: agent(String(toolArguments.name), String(toolArguments.instructions)),
          created: false,
          ok: true,
        });
      }
      if (name === "crewhelm_batch_disable_agents") {
        activeAgents -= 1;
        return toolResult(request.id, {
          ok: true,
          receipts: [{ agentId, expectedRevision: 1, outcome: "disabled" }],
        });
      }
      if (name !== "crewhelm_agent_workflows") throw new Error(`Unexpected tool: ${name}`);

      if (toolArguments.action === "start") {
        if (toolArguments.expectedRevision === 2) {
          return toolResult(
            request.id,
            {
              error: { code: "revision_conflict", message: "Agent workflow request denied." },
              ok: false,
            },
            true,
          );
        }
        workflowStarts += 1;
        if (workflowStarts === 1) {
          return new Response("Injected lost Workflow start response.", { status: 503 });
        }
        return toolResult(request.id, {
          created: false,
          ok: true,
          workflow: workflowSummary("queued", 1),
        });
      }
      if (toolArguments.action === "list") {
        return toolResult(request.id, {
          nextCursor: null,
          ok: true,
          workflows: [workflowSummary("running", 2)],
        });
      }
      if (toolArguments.action === "inspect") {
        workflowInspects += 1;
        return toolResult(request.id, {
          ok: true,
          workflow:
            workflowInspects === 1
              ? inspectedWorkflow("running", 2)
              : inspectedWorkflow("completed", 4),
        });
      }
      if (toolArguments.action === "delete") {
        return toolResult(request.id, { deleted: true, ok: true, workflowId });
      }
      throw new Error(`Unexpected Workflow action: ${String(toolArguments.action)}`);
    };

    const report = await runWorkflowSmoke(
      {
        credential,
        origin: new URL(origin),
        persistCredential: async (rotated) => {
          persisted.push(rotated);
        },
        runTimeoutMs: 10_000,
        timeoutMs: 5_000,
      },
      {
        expectedDeploymentFingerprint: fingerprint,
        fetch,
        now: () => 1,
        wait: async () => undefined,
      },
    );

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      workflowId,
      workflowStatus: "completed",
    });
    expect(persisted).toEqual([{ ...credential, refreshToken: "rotated-refresh-token" }]);
    expect(JSON.stringify(report)).not.toContain("refresh-token");
    expect(JSON.stringify(report)).not.toContain("secret-bearer-value");
  });

  it("re-inspects and retries cleanup when cancellation loses a revision race", async () => {
    const revoked = new Set<string>();
    let activeAgents = 3;
    let cancelCalls = 0;
    let cancellationAccepted = false;
    let cleanupInspects = 0;
    let startCalls = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      if (init?.method !== "POST") return Response.json(publicPayload(url.pathname));
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "cleanup-access",
          expires_in: 900,
          refresh_token: "cleanup-refresh",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(requestBodyText(init.body)).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      const bearer = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (revoked.has(bearer)) return new Response(null, { status: 401 });
      const request = mcpRequestSchema.parse(JSON.parse(requestBodyText(init.body)));
      if (request.method === "initialize") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "crewhelm", version: "test" },
          },
        });
      }
      if (request.method === "tools/list") {
        return Response.json({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            tools: [
              "crewhelm_agent_workflows",
              "crewhelm_batch_disable_agents",
              "crewhelm_create_agent",
              "crewhelm_get_agent",
              "crewhelm_list_agents",
              "crewhelm_status",
            ].map((name) => ({
              annotations: {
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
                readOnlyHint: false,
              },
              inputSchema: {},
              name,
            })),
          },
        });
      }

      const name = request.params.name;
      const toolArguments = request.params.arguments ?? {};
      if (name === "crewhelm_status") return toolResult(request.id, status(activeAgents));
      if (name === "crewhelm_create_agent") {
        activeAgents += 1;
        return toolResult(request.id, {
          agent: agent(String(toolArguments.name), String(toolArguments.instructions)),
          created: true,
          ok: true,
        });
      }
      if (name === "crewhelm_batch_disable_agents") {
        activeAgents -= 1;
        return toolResult(request.id, {
          ok: true,
          receipts: [{ agentId, expectedRevision: 1, outcome: "disabled" }],
        });
      }
      if (toolArguments.action === "start") {
        if (toolArguments.expectedRevision === 2) {
          return toolResult(
            request.id,
            {
              error: { code: "revision_conflict", message: "Agent workflow request denied." },
              ok: false,
            },
            true,
          );
        }
        startCalls += 1;
        return toolResult(request.id, {
          created: startCalls === 1,
          ok: true,
          workflow: workflowSummary("queued", 1),
        });
      }
      if (toolArguments.action === "list") {
        return new Response("Injected discovery failure.", { status: 503 });
      }
      if (toolArguments.action === "inspect") {
        cleanupInspects += 1;
        return toolResult(request.id, {
          ok: true,
          workflow: cancellationAccepted
            ? inspectedWorkflow("cancelled", 4)
            : inspectedWorkflow("running", cleanupInspects === 1 ? 2 : 3),
        });
      }
      if (toolArguments.action === "cancel") {
        cancelCalls += 1;
        if (cancelCalls === 1) {
          return toolResult(
            request.id,
            {
              error: { code: "revision_conflict", message: "Agent workflow request denied." },
              ok: false,
            },
            true,
          );
        }
        cancellationAccepted = true;
        return new Response("Injected lost cancellation response.", { status: 503 });
      }
      if (toolArguments.action === "delete") {
        return toolResult(request.id, { deleted: true, ok: true, workflowId });
      }
      throw new Error(`Unexpected request: ${name ?? String(toolArguments.action)}`);
    };

    const report = await runWorkflowSmoke(
      {
        credential,
        origin: new URL(origin),
        persistCredential: async () => undefined,
        runTimeoutMs: 10_000,
        timeoutMs: 5_000,
      },
      {
        expectedDeploymentFingerprint: fingerprint,
        fetch,
        now: () => 1,
        wait: async () => undefined,
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[6]).toMatchObject({ status: "fail" });
    expect(report.checks[8]).toMatchObject({ status: "pass" });
    expect(report.checks[9]).toMatchObject({ status: "pass" });
    expect(report.checks[10]).toMatchObject({ status: "pass" });
    expect(cancelCalls).toBe(2);
    expect(report.activeAgentsAfter).toBe(report.activeAgentsBefore);
  });
});
