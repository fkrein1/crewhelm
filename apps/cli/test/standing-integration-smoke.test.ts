import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  runStandingIntegrationSmoke,
  standingIntegrationSmokeReportSchema,
} from "../src/standing-integration-smoke.js";
import { parseDeploymentOrigin } from "../src/doctor.js";

const origin = "https://crewhelm.example";
const clientId = "integration-smoke-client";
const authorizationCode = "temporary-authorization-code";
const accessToken = "temporary-full-token";
const connectionId = "connection_33333333-3333-4333-8333-333333333333";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const runId = "run_22222222-2222-4222-8222-222222222222";
const grantId = "grant_44444444-4444-4444-8444-444444444444";
const toolCallId = "tool_call_55555555-5555-4555-8555-555555555555";
const timestamp = "2026-07-29T12:00:00.000Z";
const toolAnnotations = {
  crewhelm_agent_inbox: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_batch_disable_agents: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_configure_agent_connection: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
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
  crewhelm_inspect_integration_tool: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  crewhelm_inspect_run: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_list_connections: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_revoke_authority: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
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
    return { service: "crewhelm", status: "ok" };
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
      schemaVersion: 14,
      status: "ready",
      usage: {
        agents: { active, total: 9 },
        connections: { active: 1, pending: 0, total: 1 },
        inbox: {
          actionRequired: 0,
          deferred: 0,
          exceptions: 0,
          outcomes: 1,
          total: 1,
        },
        runs: { active: 0 },
      },
    },
  };
}

interface HarnessOptions {
  connectionMissing?: boolean;
  failInspectAfterUnknown?: boolean;
  lostConfigureResponses?: number;
  loseFirstStartResponse?: boolean;
  mismatchFirstConfigureResponse?: boolean;
  terminalFailureAfterUnknown?: boolean;
  unknownEffect?: boolean;
  unknownEffectRunning?: boolean;
  unknownWithoutToolCallId?: boolean;
  unsafeToolContract?: "input" | "scopes";
}

interface Harness {
  fetch: typeof globalThis.fetch;
  openedUrls: URL[];
  toolCalls: Array<{ arguments: unknown; name: string }>;
}

function smokeHarness(options: HarnessOptions = {}): Harness {
  const openedUrls: URL[] = [];
  const toolCalls: Harness["toolCalls"] = [];
  const revokedTokens = new Set<string>();
  let activeAgents = 3;
  let agentStatus: "active" | "disabled" = "active";
  let agentRevision = 1;
  let configuredGrantIds: string[] = [];
  let configureCalls = 0;
  let configured = false;
  let fixtureInstructions = "standing integration smoke instructions";
  let fixtureName = "standing integration smoke fixture";
  let inspectCalls = 0;
  let runStarted = false;
  let startCalls = 0;

  const agent = () => ({
    capabilityGrants: configuredGrantIds,
    createdAt: timestamp,
    executionLimits: {
      maxDurationSeconds: 60,
      maxModelTokens: 1_024,
      maxToolCalls: 1,
      maxTurns: 3,
    },
    id: agentId,
    instructions: fixtureInstructions,
    model: "@cf/zai-org/glm-4.7-flash",
    name: fixtureName,
    revision: agentRevision,
    status: agentStatus,
  });
  const run = (status: "queued" | "running" | "completed" | "failed") => ({
    agentId,
    agentRevision: 2,
    ...(status === "running" || status === "completed" || status === "failed"
      ? {
          startedAt: timestamp,
          ...(status === "completed" || status === "failed"
            ? {
                completedAt: timestamp,
                output: "provider-output-secret",
                outputTruncated: false,
              }
            : {}),
        }
      : {}),
    createdAt: timestamp,
    runId,
    status,
    trigger: "manual",
  });
  const successfulTimeline = [
    { event: "run.admitted", occurredAt: timestamp },
    { event: "run.started", occurredAt: timestamp },
    { event: "tool.authorization_allowed", occurredAt: timestamp, toolCallId },
    { event: "tool.execution_reserved", occurredAt: timestamp, toolCallId },
    { event: "tool.execution_dispatched", occurredAt: timestamp, toolCallId },
    { event: "tool.execution_completed", occurredAt: timestamp, toolCallId },
    { event: "run.completed", occurredAt: timestamp },
  ];
  const unknownTimeline = [
    { event: "run.admitted", occurredAt: timestamp },
    { event: "run.started", occurredAt: timestamp },
    { event: "tool.authorization_allowed", occurredAt: timestamp, toolCallId },
    { event: "tool.execution_reserved", occurredAt: timestamp, toolCallId },
    { event: "tool.execution_dispatched", occurredAt: timestamp, toolCallId },
    {
      event: "tool.execution_unknown",
      occurredAt: timestamp,
      ...(options.unknownWithoutToolCallId ? {} : { toolCallId }),
    },
    { event: "run.failed", occurredAt: timestamp },
  ];

  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";

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

      if (token) {
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
          tools: Object.entries(toolAnnotations).map(([name, annotations]) => ({
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
    } else if (params.name === "crewhelm_list_connections") {
      payload = {
        connections: options.connectionMissing
          ? []
          : [
              {
                authorizationOutcome: "returned",
                authConfigId: "ac_gmail",
                connectionId,
                createdAt: timestamp,
                status: "active",
              },
            ],
        nextCursor: null,
        ok: true,
      };
    } else if (params.name === "crewhelm_inspect_integration_tool") {
      payload = {
        ok: true,
        tool: {
          description: "Create a draft.",
          integration: { name: "Gmail", slug: "gmail" },
          inputParameters: {
            properties: {
              attachment: {},
              bcc: { default: [], items: { type: "string" }, type: "array" },
              body: { type: "string" },
              cc: { default: [], items: { type: "string" }, type: "array" },
              extra_recipients: {
                default: [],
                items: { type: "string" },
                type: "array",
              },
              is_html: { default: false, type: "boolean" },
              recipient_email: { type: "string" },
              subject: { type: "string" },
              thread_id: { type: "string" },
              user_id: { default: "me", type: "string" },
            },
            ...(options.unsafeToolContract === "input"
              ? { required: ["recipient_email", "cc"] }
              : {}),
            type: "object",
          },
          name: "Create email draft",
          noAuth: false,
          outputParameters: {},
          requiredScopes:
            options.unsafeToolContract === "scopes"
              ? ["https://www.googleapis.com/auth/gmail.compose"]
              : [
                  "https://mail.google.com/",
                  "https://www.googleapis.com/auth/gmail.compose",
                  "https://www.googleapis.com/auth/gmail.modify",
                  "https://www.googleapis.com/auth/gmail.readonly",
                  "https://www.googleapis.com/auth/contacts",
                  "https://www.googleapis.com/auth/contacts.readonly",
                ],
          slug: "GMAIL_CREATE_EMAIL_DRAFT",
          tags: ["createHint", "important"],
          version: "20260721_00",
        },
      };
    } else if (params.name === "crewhelm_create_agent") {
      const createArguments = z
        .looseObject({ instructions: z.string(), name: z.string() })
        .parse(params.arguments);
      fixtureInstructions = createArguments.instructions;
      fixtureName = createArguments.name;
      activeAgents += 1;
      payload = { agent: agent(), created: true, ok: true };
    } else if (params.name === "crewhelm_configure_agent_connection") {
      configureCalls += 1;
      const configuredNow = !configured;

      if (configuredNow) {
        configured = true;
        agentRevision = 2;
        configuredGrantIds = [grantId];
      }

      payload = {
        agent:
          options.mismatchFirstConfigureResponse && configureCalls === 1
            ? { ...agent(), capabilityGrants: [], revision: 1 }
            : agent(),
        configured: configuredNow,
        ok: true,
      };

      if (configureCalls <= (options.lostConfigureResponses ?? 0)) {
        throw new Error("Injected post-commit configuration response loss.");
      }
    } else if (params.name === "crewhelm_start_run") {
      startCalls += 1;
      const created = !runStarted;
      runStarted = true;
      payload = { created, ok: true, run: run("queued") };

      if (options.loseFirstStartResponse && startCalls === 1) {
        throw new Error("Injected post-commit run-start response loss.");
      }
    } else if (params.name === "crewhelm_inspect_run") {
      inspectCalls += 1;

      if (options.failInspectAfterUnknown && inspectCalls > 1) {
        throw new Error("Injected run inspection failure after unknown provider effect.");
      }

      payload =
        options.terminalFailureAfterUnknown && inspectCalls > 1
          ? {
              ok: true,
              request: { prompt: "provider-prompt-secret" },
              run: run("failed"),
              timeline: [{ event: "run.failed", occurredAt: timestamp }],
            }
          : options.unknownEffect || options.unknownEffectRunning
            ? {
                ok: true,
                request: { prompt: "provider-prompt-secret" },
                run: run(options.unknownEffectRunning ? "running" : "failed"),
                timeline: options.unknownEffectRunning
                  ? unknownTimeline.slice(0, -1)
                  : unknownTimeline,
              }
            : {
                ok: true,
                request: { prompt: "provider-prompt-secret" },
                run: run("completed"),
                timeline: successfulTimeline,
              };
    } else if (params.name === "crewhelm_agent_inbox") {
      payload = {
        action: "list",
        items: [
          {
            acknowledgedAt: null,
            agentId,
            agentName: fixtureName,
            approvalCount: 0,
            configuration: { agentRevision: 2, fleetRevision: 1, scheduleRevision: null },
            itemId: `inbox_${runId}`,
            kind: "outcome",
            nextAction: "review_output",
            occurredAt: timestamp,
            policy: null,
            requestPreview: "provider-request-secret",
            resultPreview: "provider-result-secret",
            runId,
            runStatus: "completed",
            summary: "provider-summary-secret",
            version: timestamp,
          },
        ],
        nextCursor: null,
        ok: true,
      };
    } else if (params.name === "crewhelm_revoke_authority") {
      payload = {
        changed: true,
        ok: true,
        state: { grantId, status: "revoked", target: "capability" },
      };
    } else if (params.name === "crewhelm_batch_disable_agents") {
      agentStatus = "disabled";
      activeAgents -= 1;
      payload = {
        ok: true,
        receipts: [{ agentId, expectedRevision: 2, outcome: "disabled" }],
      };
    } else if (params.name === "crewhelm_get_agent") {
      payload = { agent: agent(), ok: true };
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

  return { fetch, openedUrls, toolCalls };
}

function approveAuthorization(openedUrls: URL[]): (url: URL) => Promise<void> {
  return async (url) => {
    openedUrls.push(url);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

    callback.searchParams.set("code", authorizationCode);
    callback.searchParams.set("iss", `${origin}/api/auth`);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    expect((await globalThis.fetch(callback)).status).toBe(200);
  };
}

async function runSmoke(
  harness: Harness,
  overrides: { now?: () => number; wait?: (milliseconds: number) => Promise<void> } = {},
) {
  return runStandingIntegrationSmoke(
    {
      connectionId,
      origin: parseDeploymentOrigin(origin),
      runTimeoutMs: 3_000,
      timeoutMs: 1_000,
    },
    {
      fetch: harness.fetch,
      now: overrides.now ?? (() => Date.parse(timestamp)),
      openUrl: approveAuthorization(harness.openedUrls),
      wait: overrides.wait ?? (async () => {}),
    },
  );
}

describe("standing integration action smoke", () => {
  it("uses one standing Gmail draft dispatch, verifies inbox evidence, and cleans up", async () => {
    const harness = smokeHarness();
    const report = await runSmoke(harness);
    const serialized = JSON.stringify(report);

    expect(standingIntegrationSmokeReportSchema.parse(report)).toEqual(report);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      connectionId,
      grantId,
      retainedDraft: true,
      runId,
      runStatus: "completed",
      toolCallId,
    });
    expect(
      harness.toolCalls.find((call) => call.name === "crewhelm_create_agent")?.arguments,
    ).toMatchObject({
      executionLimits: {
        maxDurationSeconds: 60,
        maxModelTokens: 1_024,
        maxToolCalls: 1,
        maxTurns: 3,
      },
      model: "@cf/zai-org/glm-4.7-flash",
    });
    expect(
      harness.toolCalls.find((call) => call.name === "crewhelm_configure_agent_connection")
        ?.arguments,
    ).toMatchObject({
      agentId,
      connectionId,
      expectedRevision: 1,
      limits: { maxCallsPerRun: 1, maxConcurrency: 1 },
      tools: [
        {
          authorization: "standing",
          slug: "GMAIL_CREATE_EMAIL_DRAFT",
          version: "20260721_00",
        },
      ],
    });
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(1);
    expect(serialized).not.toContain("provider-prompt-secret");
    expect(serialized).not.toContain("provider-output-secret");
    expect(serialized).not.toContain("provider-request-secret");
    expect(serialized).not.toContain("provider-result-secret");
    expect(serialized).not.toContain("provider-summary-secret");
    expect(serialized).not.toContain(accessToken);
  });

  it("fails before mutation when the exact active Gmail connection is absent", async () => {
    const harness = smokeHarness({ connectionMissing: true });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
    expect(report.checks[11]).toMatchObject({ code: "valid", status: "pass" });
  });

  it.each(["input", "scopes"] as const)(
    "fails before mutation when the pinned Gmail %s contract drifts",
    async (unsafeToolContract) => {
      const harness = smokeHarness({ unsafeToolContract });
      const report = await runSmoke(harness);

      expect(report.ok).toBe(false);
      expect(report.checks[4]).toMatchObject({ code: "invalid_payload", status: "fail" });
      expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
      expect(report.checks[11]).toMatchObject({ code: "valid", status: "pass" });
    },
  );

  it("reconciles lost configuration and run-start responses with the same idempotency keys", async () => {
    const harness = smokeHarness({
      lostConfigureResponses: 1,
      loseFirstStartResponse: true,
    });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(true);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_connection"),
    ).toHaveLength(2);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(2);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      grantId,
      runId,
      runStatus: "completed",
    });
  });

  it("recovers the exact grant after both configuration responses are lost", async () => {
    const harness = smokeHarness({ lostConfigureResponses: 2 });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(true);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_connection"),
    ).toHaveLength(2);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_get_agent")).toHaveLength(2);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      grantId,
      runStatus: "completed",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("replays and captures cleanup state after a committed inconsistent configuration response", async () => {
    const harness = smokeHarness({ mismatchFirstConfigureResponse: true });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(true);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_connection"),
    ).toHaveLength(2);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      grantId,
      runStatus: "completed",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("surfaces an unknown provider effect without reconciling it and still revokes authority", async () => {
    const harness = smokeHarness({ unknownEffect: true });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.runStatus).toBe("failed");
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.retainedDraft).toBeUndefined();
    expect(report.checks[7]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
    expect(
      harness.toolCalls.some((call) => call.name === "crewhelm_reconcile_tool_execution"),
    ).toBe(false);
  });

  it("preserves the manual verification warning when an unknown effect later times out", async () => {
    const harness = smokeHarness({ unknownEffectRunning: true });
    let time = Date.parse(timestamp);
    const report = await runSmoke(harness, {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[7]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves the manual verification warning when inspection fails after an unknown effect", async () => {
    const harness = smokeHarness({
      failInspectAfterUnknown: true,
      unknownEffectRunning: true,
    });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[7]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves the warning for a contract-valid unknown event without a tool-call ID", async () => {
    const harness = smokeHarness({
      unknownEffectRunning: true,
      unknownWithoutToolCallId: true,
    });
    let time = Date.parse(timestamp);
    const report = await runSmoke(harness, {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBeUndefined();
    expect(report.checks[7]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves a prior unknown effect when a later terminal read omits the event", async () => {
    const harness = smokeHarness({
      terminalFailureAfterUnknown: true,
      unknownEffectRunning: true,
    });
    const report = await runSmoke(harness);

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[7]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[9]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[10]).toMatchObject({ code: "valid", status: "pass" });
  });
});
