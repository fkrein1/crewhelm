import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { agentSmokeReportSchema, runAgentSmoke } from "../src/agent-smoke.js";
import { parseDeploymentOrigin } from "../src/doctor.js";
import { toolListResponseSchema } from "../src/temporary-owner-session.js";

const origin = "https://crewhelm.example";
const clientId = "smoke-client";
const authorizationCode = "temporary-authorization-code";
const accessToken = "temporary-full-token";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const runId = "run_22222222-2222-4222-8222-222222222222";
const timestamp = "2026-07-29T12:00:00.000Z";
const lifecycleToolAnnotations = {
  crewhelm_batch_disable_agents: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_create_agent: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_get_agent: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_inspect_run: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_start_run: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_status: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
} as const;
const mcpRequestSchema = z.looseObject({
  id: z.number(),
  method: z.string(),
  params: z.unknown(),
});
const deploymentFingerprint = "a".repeat(64);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }

  return new URL(typeof input === "string" ? input : input.url);
}

function publicPayload(path: string): unknown {
  if (path === "/health") {
    return {
      deployment: { fingerprint: deploymentFingerprint, protocolVersion: 1 },
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

function fleetStatus(active: number) {
  return {
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
        agents: { active, total: 9 },
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
        runs: { active: 0 },
        skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
      },
    },
  };
}

interface SmokeHarnessOptions {
  created?: boolean;
  disableFails?: boolean;
  failFirstCreateBeforeCommit?: boolean;
  failFirstStartBeforeCommit?: boolean;
  inspectStatuses?: Array<"queued" | "running" | "completed" | "cancelled" | "failed">;
  loseFirstCreateResponse?: boolean;
  loseFirstStartResponse?: boolean;
  mismatchCreatedName?: boolean;
  mismatchGetId?: boolean;
  omitTool?: keyof typeof lifecycleToolAnnotations;
  revokeWithoutEffect?: boolean;
  secretOutput?: string;
  started?: boolean;
}

interface SmokeHarness {
  fetch: typeof globalThis.fetch;
  openedUrls: URL[];
  requests: Array<{ body: string; headers: Headers; method: string; url: URL }>;
  toolCalls: Array<{ arguments: unknown; name: string }>;
}

function smokeHarness(options: SmokeHarnessOptions = {}): SmokeHarness {
  const requests: SmokeHarness["requests"] = [];
  const toolCalls: SmokeHarness["toolCalls"] = [];
  const openedUrls: URL[] = [];
  const revokedTokens = new Set<string>();
  const inspectStatuses = [...(options.inspectStatuses ?? ["running", "completed"])];
  let activeAgents = 3;
  let agentStatus: "active" | "disabled" = "active";
  let createCalls = 0;
  let agentCreated = false;
  let startCalls = 0;
  let runCreated = false;
  let fixtureInstructions =
    "Return one short plain-text acknowledgment. Do not request or call any tools.";
  let fixtureName = "Crewhelm lifecycle smoke fixture";

  const agent = (overrides: { id?: string; name?: string } = {}) => ({
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
      maxDurationSeconds: 45,
      maxModelTokens: 512,
      maxToolCalls: 0,
      maxTurns: 1,
    },
    id: overrides.id ?? agentId,
    instructions: fixtureInstructions,
    model: "@cf/meta/llama-4-scout-17b-16e-instruct",
    name: overrides.name ?? fixtureName,
    revision: 1,
    status: agentStatus,
  });
  const run = (status: string) => ({
    agentId,
    agentRevision: 1,
    ...(status === "completed"
      ? {
          completedAt: timestamp,
          output: options.secretOutput ?? "Acknowledged.",
          outputTruncated: false,
        }
      : {}),
    createdAt: timestamp,
    runId,
    ...(status === "running" || status === "completed" ? { startedAt: timestamp } : {}),
    status,
    trigger: "manual",
  });

  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";

    requests.push({ body, headers, method, url });

    if (
      url.pathname === "/health" ||
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-authorization-server/api/auth"
    ) {
      return jsonResponse(publicPayload(url.pathname));
    }

    if (url.pathname === "/api/auth/oauth2/register") {
      return jsonResponse({ client_id: clientId, token_endpoint_auth_method: "none" }, 201);
    }

    if (url.pathname === "/api/auth/oauth2/token") {
      return jsonResponse({
        access_token: accessToken,
        expires_in: 900,
        scope: "crewhelm:full",
        token_type: "Bearer",
      });
    }

    if (url.pathname === "/api/auth/oauth2/revoke") {
      const token = new URLSearchParams(body).get("token");

      if (token && !options.revokeWithoutEffect) {
        revokedTokens.add(token);
      }

      return new Response(null, { status: 200 });
    }

    if (url.pathname !== "/mcp") {
      throw new Error(`Unexpected request path: ${url.pathname}`);
    }

    const bearer = headers.get("authorization")?.replace(/^Bearer /u, "");

    if (bearer && revokedTokens.has(bearer)) {
      return jsonResponse(
        { error: { code: "invalid_token", message: "MCP request denied." } },
        401,
      );
    }

    const request = mcpRequestSchema.parse(JSON.parse(body));

    if (request.method === "initialize") {
      return jsonResponse({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-11-25",
          serverInfo: { name: "crewhelm", version: "0.1.0" },
        },
      });
    }

    if (request.method === "tools/list") {
      return jsonResponse({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          tools: Object.entries(lifecycleToolAnnotations)
            .filter(([name]) => name !== options.omitTool)
            .map(([name, annotations]) => ({
              annotations,
              inputSchema: { additionalProperties: false, properties: {}, type: "object" },
              name,
            })),
        },
      });
    }

    const params = z
      .strictObject({ arguments: z.unknown(), name: z.string() })
      .parse(request.params);
    toolCalls.push(params);
    let payload: unknown;

    if (params.name === "crewhelm_status") {
      payload = fleetStatus(activeAgents);
    } else if (params.name === "crewhelm_create_agent") {
      const createArguments = z
        .looseObject({ instructions: z.string(), name: z.string() })
        .parse(params.arguments);
      fixtureInstructions = createArguments.instructions;
      fixtureName = createArguments.name;
      createCalls += 1;

      if (options.failFirstCreateBeforeCommit && createCalls === 1) {
        throw new Error("Injected pre-commit request failure.");
      }

      const created = options.created === false ? false : !agentCreated;

      if (created) {
        agentCreated = true;
        activeAgents += 1;
      }
      payload = {
        agent: agent(options.mismatchCreatedName ? { name: `${fixtureName} mismatch` } : {}),
        created,
        ok: true,
      };

      if (options.loseFirstCreateResponse && createCalls === 1) {
        throw new Error("Injected post-commit response loss.");
      }
    } else if (params.name === "crewhelm_start_run") {
      startCalls += 1;

      if (options.failFirstStartBeforeCommit && startCalls === 1) {
        throw new Error("Injected pre-commit run-start failure.");
      }

      const created = options.started === false ? false : !runCreated;

      if (created) {
        runCreated = true;
      }
      payload = { created, ok: true, run: run("queued") };

      if (options.loseFirstStartResponse && startCalls === 1) {
        throw new Error("Injected post-commit run-start response loss.");
      }
    } else if (params.name === "crewhelm_inspect_run") {
      const status = inspectStatuses.shift() ?? inspectStatuses.at(-1) ?? "running";
      payload = {
        diagnosis: null,
        ok: true,
        request: { prompt: "provider-prompt-secret" },
        retention: {
          availableUntil: timestamp,
          output: { limitCharacters: 65_536, retainedCharacters: 0, truncated: false },
        },
        run: run(status),
        timeline: [],
        timelinePage: {
          nextCursor: null,
          omittedEvents: 0,
          startSequence: 0,
          totalEvents: 0,
          truncated: false,
        },
        usage: null,
      };
    } else if (params.name === "crewhelm_batch_disable_agents") {
      if (options.disableFails) {
        payload = {
          error: { code: "invalid_authority", message: "Batch Agent disable request denied." },
          ok: false,
        };
      } else {
        agentStatus = "disabled";
        activeAgents -= 1;
        payload = {
          ok: true,
          receipts: [{ agentId, expectedRevision: 1, outcome: "disabled" }],
        };
      }
    } else if (params.name === "crewhelm_get_agent") {
      payload = {
        agent: agent(
          options.mismatchGetId ? { id: "agent_33333333-3333-4333-8333-333333333333" } : {},
        ),
        ok: true,
      };
    } else {
      throw new Error(`Unexpected tool call: ${params.name}`);
    }

    return jsonResponse({
      id: request.id,
      jsonrpc: "2.0",
      result: {
        content: [{ text: JSON.stringify(payload), type: "text" }],
        isError: false,
      },
    });
  });

  return { fetch, openedUrls, requests, toolCalls };
}

function approveAuthorization(openedUrls: URL[]): (url: URL) => Promise<void> {
  return async (url) => {
    openedUrls.push(url);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

    callback.searchParams.set("code", authorizationCode);
    callback.searchParams.set("iss", `${origin}/api/auth`);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    expect((await globalThis.fetch(callback, { redirect: "manual" })).status).toBe(303);
  };
}

async function runSmoke(
  harness: SmokeHarness,
  overrides: { now?: () => number; wait?: (milliseconds: number) => Promise<void> } = {},
) {
  return runAgentSmoke(
    {
      origin: parseDeploymentOrigin(origin),
      runTimeoutMs: 3_000,
      timeoutMs: 1_000,
    },
    {
      expectedDeploymentFingerprint: deploymentFingerprint,
      fetch: harness.fetch,
      openUrl: approveAuthorization(harness.openedUrls),
      ...overrides,
    },
  );
}

describe("disposable Agent lifecycle smoke", () => {
  it("accepts the complete bounded Worker tool catalog", () => {
    const tool = {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      name: "bounded_tool",
    };
    const response = (count: number) => ({
      id: 1,
      jsonrpc: "2.0",
      result: {
        tools: Array.from({ length: count }, (_, index) => ({
          ...tool,
          name: `${tool.name}_${index}`,
        })),
      },
    });

    expect(toolListResponseSchema.safeParse(response(32)).success).toBe(true);
    expect(toolListResponseSchema.safeParse(response(33)).success).toBe(false);
  });

  it("waits for browser-edge propagation before opening authorization", async () => {
    const harness = smokeHarness();
    const events: string[] = [];
    const approve = approveAuthorization(harness.openedUrls);

    const report = await runAgentSmoke(
      {
        authorizationDelayMs: 15_000,
        origin: parseDeploymentOrigin(origin),
        runTimeoutMs: 3_000,
        timeoutMs: 1_000,
      },
      {
        expectedDeploymentFingerprint: deploymentFingerprint,
        fetch: harness.fetch,
        openUrl: async (url) => {
          events.push("open");
          await approve(url);
        },
        wait: async (milliseconds) => {
          events.push(`wait:${milliseconds}`);
        },
      },
    );

    expect(report.ok).toBe(true);
    expect(events.slice(0, 2)).toEqual(["wait:15000", "open"]);
  });

  it("uses Full control for one zero-grant bounded run, cleans up, and revokes access", async () => {
    const harness = smokeHarness();
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(agentSmokeReportSchema.parse(report)).toEqual(report);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      runId,
      runStatus: "completed",
    });

    const registration = harness.requests.find(
      (request) => request.url.pathname === "/api/auth/oauth2/register",
    );
    expect(JSON.parse(registration?.body ?? "")).toMatchObject({
      client_name: "Crewhelm Agent lifecycle smoke",
      scope: "crewhelm:full",
    });
    expect(harness.openedUrls[0]?.searchParams.get("scope")).toBe("crewhelm:full");

    const create = harness.toolCalls.find((call) => call.name === "crewhelm_create_agent");
    expect(create?.arguments).toMatchObject({
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 512,
        maxToolCalls: 0,
        maxTurns: 1,
      },
    });
    expect(create?.arguments).not.toHaveProperty("model");
    expect(harness.toolCalls.map((call) => call.name)).toEqual([
      "crewhelm_status",
      "crewhelm_create_agent",
      "crewhelm_status",
      "crewhelm_start_run",
      "crewhelm_inspect_run",
      "crewhelm_inspect_run",
      "crewhelm_batch_disable_agents",
      "crewhelm_get_agent",
      "crewhelm_status",
    ]);

    const revoke = harness.requests.find(
      (request) => request.url.pathname === "/api/auth/oauth2/revoke",
    );
    expect(new URLSearchParams(revoke?.body)).toEqual(
      new URLSearchParams({
        client_id: clientId,
        token: accessToken,
        token_type_hint: "access_token",
      }),
    );
  });

  it("refuses to mutate when the lifecycle catalog is incomplete and still revokes access", async () => {
    const harness = smokeHarness({ omitTool: "crewhelm_batch_disable_agents" });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[2]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(report.checks.slice(3, 6).every((check) => check.status === "skip")).toBe(true);
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
    expect(harness.toolCalls).toEqual([]);
  });

  it("treats a replayed create as unsafe and does not run or disable an existing Agent", async () => {
    const harness = smokeHarness({ created: false });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_start_run")).toBe(false);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_batch_disable_agents")).toBe(
      false,
    );
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("reconciles a post-commit create response loss and disables the recovered fixture", async () => {
    const harness = smokeHarness({ loseFirstCreateResponse: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(true);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_create_agent")).toHaveLength(
      2,
    );
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_batch_disable_agents")).toBe(
      true,
    );
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      runStatus: "completed",
    });
  });

  it("adopts and disables the exact fixture when the retry performs the first commit", async () => {
    const harness = smokeHarness({ failFirstCreateBeforeCommit: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(true);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_create_agent")).toHaveLength(
      2,
    );
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_batch_disable_agents")).toBe(
      true,
    );
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      runStatus: "completed",
    });
  });

  it("reconciles a post-commit run-start response loss and inspects the recovered run", async () => {
    const harness = smokeHarness({ loseFirstStartResponse: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(true);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(2);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_inspect_run")).toBe(true);
    expect(report).toMatchObject({ agentId, runId, runStatus: "completed" });
  });

  it("captures the exact run when the retry performs the first start commit", async () => {
    const harness = smokeHarness({ failFirstStartBeforeCommit: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(true);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(2);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_inspect_run")).toBe(true);
    expect(report).toMatchObject({ agentId, runId, runStatus: "completed" });
  });

  it("does not adopt an unexplained replayed run on the ordinary start path", async () => {
    const harness = smokeHarness({ started: false });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_inspect_run")).toBe(false);
    expect(report.checks[5]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("refuses to run or disable a create response that does not match the exact fixture", async () => {
    const harness = smokeHarness({ mismatchCreatedName: true });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_start_run")).toBe(false);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_batch_disable_agents")).toBe(
      false,
    );
  });

  it("rejects a mismatched exact-Agent cleanup read", async () => {
    const harness = smokeHarness({ mismatchGetId: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[5]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("cleans up after a run timeout and does not expose prompt or model output", async () => {
    const outputSecret = "provider-model-output-secret";
    const harness = smokeHarness({
      inspectStatuses: ["running", "running"],
      secretOutput: outputSecret,
    });
    let time = 0;
    const report = await runSmoke(harness, {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });
    const serialized = JSON.stringify(report);

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "timeout", status: "fail" });
    expect(report.checks[5]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
    expect(serialized).not.toContain("provider-prompt-secret");
    expect(serialized).not.toContain(outputSecret);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(authorizationCode);
  });

  it("cleans up a terminally failed run while preserving only its bounded status", async () => {
    const harness = smokeHarness({ inspectStatuses: ["failed"] });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.runStatus).toBe("failed");
    expect(report.checks[4]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(report.checks[5]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[6]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("does not issue a token or mutate when the owner declines Full control", async () => {
    const harness = smokeHarness();
    const report = await runAgentSmoke(
      {
        origin: parseDeploymentOrigin(origin),
        runTimeoutMs: 3_000,
        timeoutMs: 1_000,
      },
      {
        expectedDeploymentFingerprint: deploymentFingerprint,
        fetch: harness.fetch,
        openUrl: async (url) => {
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("iss", `${origin}/api/auth`);
          callback.searchParams.set("state", url.searchParams.get("state") ?? "");
          await globalThis.fetch(callback, { redirect: "manual" });
        },
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      code: "authorization_denied",
      status: "fail",
    });
    expect(report.checks.slice(1).every((check) => check.status === "skip")).toBe(true);
    expect(harness.toolCalls).toEqual([]);
    expect(
      harness.requests.some((request) => request.url.pathname === "/api/auth/oauth2/token"),
    ).toBe(false);
  });

  it("reports cleanup and revocation failures independently", async () => {
    const harness = smokeHarness({ disableFails: true, revokeWithoutEffect: true });
    const report = await runSmoke(harness, { wait: async () => {} });

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[5]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(report.checks[6]).toMatchObject({ code: "http_status", status: "fail" });
  });
});
