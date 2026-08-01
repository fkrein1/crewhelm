import { describe, expect, it } from "vitest";
import * as z from "zod";

import { observedNetworkDenial, runSandboxSmoke } from "../src/sandbox-smoke.js";

const origin = "https://crewhelm-testing.example";
const fingerprint = "a".repeat(64);
const timestamp = "2026-08-01T12:00:00.000Z";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const otherAgentId = "agent_99999999-9999-4999-8999-999999999999";
const codeRunId = "run_22222222-2222-4222-8222-222222222222";
const networkRunId = "run_33333333-3333-4333-8333-333333333333";
const credential = {
  clientId: "sandbox-rehearsal-client",
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

function requestBodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unexpected request body type.");
}

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
        recovery: { unresolvedEffects: 0 },
        runs: { active: 0 },
        skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
        workflows: { active: 0, total: 0 },
      },
    },
  };
}

function agent(
  name = "Crewhelm Sandbox smoke fixture",
  instructions = "fixture instructions",
  currentStatus: "active" | "disabled" = "active",
) {
  return {
    capabilities: [
      {
        configuration: {
          fallbackModels: [],
          primaryModel: "@cf/zai-org/glm-4.7-flash",
        },
        id: "inference.workers-ai",
        schemaVersion: 2,
      },
      {
        configuration: {
          languages: ["python"],
          maxCodeBytes: 4_096,
          maxDurationMs: 10_000,
          maxOutputBytes: 16_384,
        },
        id: "tools.sandbox-code",
        schemaVersion: 1,
      },
    ],
    capabilityGrants: [],
    createdAt: timestamp,
    executionLimits: {
      maxDurationSeconds: 60,
      maxModelTokens: 1_024,
      maxToolCalls: 1,
      maxTurns: 2,
    },
    id: agentId,
    instructions,
    model: "@cf/zai-org/glm-4.7-flash",
    name,
    revision: 1,
    status: currentStatus,
  };
}

function run(runId: string, output?: string, runAgentId = agentId) {
  return {
    agentId: runAgentId,
    agentRevision: 1,
    ...(output === undefined ? {} : { completedAt: timestamp, output, outputTruncated: false }),
    createdAt: timestamp,
    runId,
    startedAt: timestamp,
    status: output === undefined ? "queued" : "completed",
    trigger: "manual",
  };
}

function inspection(runId: string, output: string, toolCallId: string) {
  return {
    briefs: [],
    diagnosis: null,
    ok: true,
    request: { prompt: "bounded sandbox prompt" },
    retention: {
      availableUntil: timestamp,
      output: { limitCharacters: 65_536, retainedCharacters: output.length, truncated: false },
    },
    run: run(runId, output),
    skills: [],
    timeline: [
      { event: "run.admitted", occurredAt: timestamp },
      { event: "tool.execution_reserved", occurredAt: timestamp, toolCallId },
      { event: "tool.execution_dispatched", occurredAt: timestamp, toolCallId },
      { event: "tool.execution_completed", occurredAt: timestamp, toolCallId },
      { event: "run.completed", occurredAt: timestamp },
    ],
    timelinePage: {
      nextCursor: null,
      omittedEvents: 0,
      startSequence: 0,
      totalEvents: 5,
      truncated: false,
    },
    usage: {
      ai: {
        calls: 1,
        costMicrousd: 0,
        inputTokens: 10,
        outputTokens: 10,
        settlement: "settled",
      },
      modelCalls: { limit: 2, used: 1 },
      toolCalls: { limit: 1, used: 1 },
    },
  };
}

function toolResult(id: number, payload: unknown): Response {
  return Response.json({
    id,
    jsonrpc: "2.0",
    result: { content: [{ text: JSON.stringify(payload), type: "text" }], isError: false },
  });
}

describe("Sandbox feature rehearsal", () => {
  it("recovers lost responses and still cleans exact fixtures after a failed check", async () => {
    const revoked = new Set<string>();
    const persisted: unknown[] = [];
    let activeAgents = 3;
    let agentStatus: "active" | "disabled" = "active";
    let createdInstructions = "fixture instructions";
    let createdName = "Crewhelm Sandbox smoke fixture";
    let cancelCalls = 0;
    let createCalls = 0;
    let disableCalls = 0;
    let networkPrompt = "";
    let runListCalls = 0;
    let runStartCalls = 0;
    const startedRuns = new Map<string, string>();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      if (init?.method !== "POST") return Response.json(publicPayload(url.pathname));
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "secret-access-token",
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
              "crewhelm_batch_disable_agents",
              "crewhelm_cancel_run",
              "crewhelm_create_agent",
              "crewhelm_get_config",
              "crewhelm_get_agent",
              "crewhelm_inspect_run",
              "crewhelm_list_agent_runs",
              "crewhelm_list_agents",
              "crewhelm_start_run",
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
      if (name === "crewhelm_get_config") {
        return toolResult(request.id, {
          capabilities: [
            {
              availability: { missingPrerequisites: [], state: "available" },
              configurationFields: [],
              description: "Bounded code.",
              id: "tools.sandbox-code",
              prerequisites: [],
              schemaVersion: 1,
              title: "Sandbox code",
              trust: {
                configuration: "untrusted-until-validated",
                runtimeContribution: "module-validated",
              },
            },
          ],
          ok: true,
        });
      }
      if (name === "crewhelm_status") return toolResult(request.id, status(activeAgents));
      if (name === "crewhelm_get_agent") {
        return toolResult(request.id, {
          agent: agent(createdName, createdInstructions, agentStatus),
          ok: true,
        });
      }
      if (name === "crewhelm_create_agent") {
        createCalls += 1;
        createdName = String(request.params.arguments?.name);
        createdInstructions = String(request.params.arguments?.instructions);
        if (createCalls === 1) {
          activeAgents += 1;
          return new Response("Injected lost Agent create response.", { status: 503 });
        }
        return toolResult(request.id, {
          agent: agent(createdName, createdInstructions),
          created: false,
          ok: true,
        });
      }
      if (name === "crewhelm_start_run") {
        runStartCalls += 1;
        const idempotencyKey = String(request.params.arguments?.idempotencyKey);
        const isNetwork = idempotencyKey.includes("network");
        if (isNetwork) networkPrompt = String(request.params.arguments?.prompt);
        const currentRunId = isNetwork ? networkRunId : codeRunId;
        const previous = startedRuns.get(idempotencyKey);
        if (previous === undefined) {
          startedRuns.set(idempotencyKey, currentRunId);
          return new Response("Injected lost Run start response.", { status: 503 });
        }
        return toolResult(request.id, { created: false, ok: true, run: run(previous) });
      }
      if (name === "crewhelm_inspect_run") {
        const runId = String(request.params.arguments?.runId);
        return toolResult(
          request.id,
          runId === codeRunId
            ? inspection(
                codeRunId,
                "SANDBOX_MATH 97406784",
                "tool_call_44444444-4444-4444-8444-444444444444",
              )
            : inspection(
                networkRunId,
                "NETWORK_BLOCKED PermissionError",
                "tool_call_55555555-5555-4555-8555-555555555555",
              ),
        );
      }
      if (name === "crewhelm_list_agent_runs") {
        runListCalls += 1;
        return toolResult(request.id, {
          nextCursor: null,
          ok: true,
          runs:
            runListCalls === 1
              ? [run(codeRunId)]
              : [
                  run(networkRunId),
                  run(codeRunId),
                  run("run_88888888-8888-4888-8888-888888888888", undefined, otherAgentId),
                ],
        });
      }
      if (name === "crewhelm_cancel_run") {
        cancelCalls += 1;
        return toolResult(request.id, {
          cancelled: true,
          ok: true,
          runId: String(request.params.arguments?.runId),
        });
      }
      if (name === "crewhelm_batch_disable_agents") {
        disableCalls += 1;
        if (agentStatus === "active") {
          activeAgents -= 1;
          agentStatus = "disabled";
        }
        return new Response("Injected lost Agent disable response.", { status: 503 });
      }
      throw new Error(`Unexpected tool call: ${name}`);
    };

    const report = await runSandboxSmoke(
      {
        credential,
        origin: new URL(origin),
        persistCredential: async (rotated) => {
          persisted.push(rotated);
        },
        runTimeoutMs: 60_000,
        timeoutMs: 5_000,
      },
      { expectedDeploymentFingerprint: fingerprint, fetch, wait: async () => undefined },
    );

    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      checks: [
        ...Array.from({ length: 7 }, () => ({ status: "pass" })),
        { name: "compact-discovery", status: "fail" },
        { name: "agent-disable", status: "fail" },
        { name: "access-token-revocation", status: "pass" },
      ],
      codeRunId,
      networkRunId,
      ok: false,
    });
    expect(persisted).toHaveLength(1);
    expect(createCalls).toBe(2);
    expect(runStartCalls).toBe(4);
    expect(disableCalls).toBe(1);
    expect(cancelCalls).toBe(0);
    expect(agentStatus).toBe("disabled");
    expect(networkPrompt).toContain("s.connect(('1.1.1.1', 443))");
    expect(networkPrompt).toContain("NETWORK_UNEXPECTED_CONNECTED");
    expect(networkPrompt).not.toContain("urllib");
    expect(revoked).toContain("secret-access-token");
    expect(revoked).not.toContain("rotated-refresh-token");
  });

  it("rejects reachable or TLS-layer outcomes as observed network denial", () => {
    expect(observedNetworkDenial("NETWORK_BLOCKED PermissionError")).toBe(true);
    expect(observedNetworkDenial("NETWORK_BLOCKED TimeoutError")).toBe(true);
    expect(observedNetworkDenial("NETWORK_UNEXPECTED_CONNECTED")).toBe(false);
    expect(observedNetworkDenial("NETWORK_BLOCKED HTTPError")).toBe(false);
    expect(observedNetworkDenial("NETWORK_BLOCKED SSLError")).toBe(false);
  });
});
