import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  runStandingIntegrationRehearsal,
  standingIntegrationRehearsalReportSchema,
} from "../../../src/rehearsal/public/standing-integration.js";
import { parseDeploymentOrigin } from "../../../src/doctor.js";
import { commandFixtureCall } from "../facade-fixtures.js";

const origin = "https://crewhelm.example";
const clientId = "integration-rehearsal-client";
const authorizationCode = "temporary-authorization-code";
const accessToken = "temporary-full-token";
const connectionId = "connection_33333333-3333-4333-8333-333333333333";
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const scheduleId = "schedule_66666666-6666-4666-8666-666666666666";
const runId = "run_22222222-2222-4222-8222-222222222222";
const grantId = "grant_44444444-4444-4444-8444-444444444444";
const toolCallId = "tool_call_55555555-5555-4555-8555-555555555555";
const timestamp = "2026-07-29T12:00:00.000Z";
const toolAnnotations = {
  crewhelm_change_agents: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_change_automations: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_change_connections: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
  },
  crewhelm_change_work: {
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  crewhelm_inspect_agents: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_inspect_automations: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_inspect_connections: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: true,
  },
  crewhelm_inspect_context: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_inspect_recovery: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_inspect_work: {
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: true,
  },
  crewhelm_recover: {
    destructiveHint: true,
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

function fleetStatus(active: number, unresolvedEffects = 0) {
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
        connections: { active: 1, pending: 0, total: 1 },
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
          outcomes: 1,
          total: 1,
        },
        runs: { active: 0 },
        skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
        recovery: { unresolvedEffects },
      },
    },
  };
}

function fleetConfiguration(minimumIntervalSeconds = 60) {
  return {
    configuration: {
      configuredAt: timestamp,
      data: {
        capacity: {
          maxAgents: 100,
          maxConcurrentRuns: 25,
          maxConnections: 100,
        },
        execution: {
          maxDurationSeconds: 300,
          maxModelTokens: 16_384,
          maxToolCalls: 8,
          maxTurns: 8,
        },
        integrations: {
          callsPerDay: 300,
          callsPerThirtyDays: 8_000,
          duplicateToolCallLimit: 2,
          maxCallsPerRun: 8,
          maxCallsPerToolPerRun: 2,
          maxConcurrencyPerGrant: 1,
        },
        retention: {
          inboxSeconds: 2_592_000,
          runSeconds: 86_400,
        },
        schedules: { minimumIntervalSeconds },
      },
      revision: 1,
    },
    ok: true,
  };
}

function inspectionMetadata(totalEvents: number) {
  return {
    diagnosis: null,
    retention: {
      availableUntil: timestamp,
      output: { limitCharacters: 65_536, retainedCharacters: 0, truncated: false },
    },
    timelinePage: {
      nextCursor: null,
      omittedEvents: 0,
      startSequence: 0,
      totalEvents,
      truncated: false,
    },
    usage: null,
  };
}

interface HarnessOptions {
  authorizationBlockedReason?: "unreconciled_effect";
  connectionMissing?: boolean;
  connectionIntegration?: "github";
  connectionStatus?: "active" | "initiated";
  failInspectAfterUnknown?: boolean;
  authorityCleanupLatencyMs?: number;
  lostConfigureResponses?: number;
  lostScheduleConfigureResponses?: number;
  loseFirstStartResponse?: boolean;
  mismatchFirstConfigureResponse?: boolean;
  terminalFailureAfterUnknown?: boolean;
  scheduleDeferred?: boolean;
  scheduleMinimumIntervalSeconds?: number;
  scheduleNeverDispatch?: boolean;
  schedulePauseTimeoutResponses?: number;
  pendingRunInspections?: number;
  unknownEffect?: boolean;
  unknownEffectRunning?: boolean;
  unknownWithoutToolCallId?: boolean;
  unsafeToolContract?: "input" | "scopes";
  unresolvedEffects?: number;
}

interface Harness {
  elapsedMilliseconds: () => number;
  fetch: typeof globalThis.fetch;
  openedUrls: URL[];
  scheduledDispatches: () => number;
  toolCalls: Array<{ arguments: unknown; name: string }>;
}

function rehearsalHarness(options: HarnessOptions = {}): Harness {
  const openedUrls: URL[] = [];
  const toolCalls: Harness["toolCalls"] = [];
  const revokedTokens = new Set<string>();
  let activeAgents = 3;
  let agentStatus: "active" | "disabled" = "active";
  let agentRevision = 1;
  let configuredGrantIds: string[] = [];
  let configureCalls = 0;
  let configured = false;
  let fixtureInstructions = "standing integration rehearsal instructions";
  let fixtureName = "standing integration rehearsal fixture";
  let inspectCalls = 0;
  let runStarted = false;
  let scheduleConfiguration: { intervalSeconds: number; prompt: string } | null = null;
  let scheduleConfigureCalls = 0;
  let scheduleDispatches = 0;
  let scheduleElapsedMilliseconds = 0;
  let schedulePauseCalls = 0;
  let elapsedMilliseconds = 0;
  let scheduleLastRunId: string | null = null;
  let scheduleRevision = 0;
  let scheduleStatus: "active" | "paused" = "paused";
  let startCalls = 0;

  const agent = () => ({
    capabilities: [
      {
        configuration: { model: "@cf/zai-org/glm-4.7-flash" },
        id: "inference.workers-ai",
        schemaVersion: 1,
      },
    ],
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
    trigger: scheduleRevision > 0 ? "schedule" : "manual",
  });
  const schedule = () => ({
    agentId,
    agentRevision: 2,
    configuration: scheduleConfiguration,
    createdAt: timestamp,
    id: scheduleId,
    lastAttempt:
      scheduleLastRunId === null
        ? options.scheduleDeferred
          ? {
              occurredAt: timestamp,
              outcome: "deferred",
              reason: "active_run",
              retryAt: timestamp,
              runId: null,
            }
          : null
        : {
            occurredAt: timestamp,
            outcome: "dispatched",
            reason: null,
            retryAt: null,
            runId: scheduleLastRunId,
          },
    lastDispatchedAt: scheduleLastRunId === null ? null : timestamp,
    lastRunId: scheduleLastRunId,
    name: "Standing integration rehearsal",
    nextRunAt: scheduleStatus === "active" ? timestamp : null,
    revision: scheduleRevision,
    status: scheduleStatus,
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
  const advanceTime = (milliseconds: number): void => {
    elapsedMilliseconds += milliseconds;

    if (scheduleStatus === "active" && configured) {
      scheduleElapsedMilliseconds += milliseconds;
      scheduleDispatches += Math.floor(scheduleElapsedMilliseconds / (60 * 1_000));
      scheduleElapsedMilliseconds %= 60 * 1_000;
    }
  };

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

    const params = commandFixtureCall(
      z.strictObject({ arguments: z.unknown(), name: z.string() }).parse(request.params),
    );
    toolCalls.push(params);
    let payload: unknown;

    if (params.name === "crewhelm_status") {
      payload = fleetStatus(activeAgents, options.unresolvedEffects);
    } else if (params.name === "crewhelm_get_config") {
      z.strictObject({ target: z.strictObject({ kind: z.literal("fleet") }) }).parse(
        params.arguments,
      );
      payload = fleetConfiguration(options.scheduleMinimumIntervalSeconds);
    } else if (params.name === "crewhelm_list_unresolved_tool_effects") {
      payload = {
        effects:
          (options.unresolvedEffects ?? 0) > 0
            ? [
                {
                  agentId,
                  agentRevision: 2,
                  authorization: "standing",
                  connectionId,
                  dispatchedAt: timestamp,
                  effect: "write",
                  integrationSlug: "gmail",
                  legacyWildcard: false,
                  recordedAt: timestamp,
                  runId,
                  toolCallId,
                  toolkitVersion: "20260721_00",
                  toolSlug: "GMAIL_CREATE_EMAIL_DRAFT",
                },
              ]
            : [],
        nextCursor: null,
        ok: true,
        total: options.unresolvedEffects ?? 0,
      };
    } else if (params.name === "crewhelm_list_connections") {
      z.strictObject({
        authorizationOutcome: z.literal("returned"),
        cursor: z.string().optional(),
        integration: z.literal("gmail"),
        limit: z.literal(20),
      }).parse(params.arguments);
      payload = {
        connections:
          options.connectionMissing || options.connectionIntegration === "github"
            ? []
            : [
                {
                  accountLabel: "esteiraliving@gmail.com",
                  authorizationOutcome: "returned",
                  authConfigId: "ac_gmail",
                  connectionId,
                  createdAt: timestamp,
                  integrationSlug: options.connectionIntegration === "github" ? "github" : "gmail",
                  providerConnectionId: "ca_gmail",
                  status: options.connectionStatus ?? "initiated",
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
    } else if (params.name === "crewhelm_configure_agent_schedule") {
      scheduleConfigureCalls += 1;
      const scheduleArguments = z
        .looseObject({
          schedule: z
            .strictObject({ intervalSeconds: z.literal(60), prompt: z.string() })
            .nullable(),
        })
        .parse(params.arguments);

      if (scheduleArguments.schedule === null) {
        schedulePauseCalls += 1;
      }

      if (
        scheduleArguments.schedule === null &&
        schedulePauseCalls <= (options.schedulePauseTimeoutResponses ?? 0)
      ) {
        advanceTime(5_000);
        throw new DOMException("Injected schedule pause timeout.", "TimeoutError");
      }

      if (scheduleArguments.schedule === null && agentStatus === "disabled") {
        payload = {
          error: {
            code: "agent_unavailable",
            message: "Agent schedule request denied.",
          },
          ok: false,
        };
      } else {
        const configuredNow =
          scheduleArguments.schedule === null
            ? scheduleStatus !== "paused" || scheduleRevision === 1
            : scheduleRevision === 0;

        if (configuredNow) {
          scheduleRevision += 1;
          scheduleStatus = scheduleArguments.schedule === null ? "paused" : "active";
          scheduleConfiguration = scheduleArguments.schedule;
        }

        payload = { configured: configuredNow, ok: true, schedule: schedule() };
      }

      if (scheduleConfigureCalls <= (options.lostScheduleConfigureResponses ?? 0)) {
        throw new Error("Injected post-commit schedule configuration response loss.");
      }
    } else if (params.name === "crewhelm_get_agent_schedule") {
      if (
        scheduleStatus === "active" &&
        !options.scheduleNeverDispatch &&
        !options.scheduleDeferred
      ) {
        if (scheduleLastRunId === null) {
          scheduleDispatches += 1;
          scheduleElapsedMilliseconds = 0;
          scheduleLastRunId = runId;
          runStarted = true;
        }
      }

      payload = { ok: true, schedule: schedule() };
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
              ...inspectionMetadata(1),
              ok: true,
              request: { prompt: "provider-prompt-secret" },
              run: run("failed"),
              timeline: [{ event: "run.failed", occurredAt: timestamp }],
            }
          : options.authorizationBlockedReason
            ? {
                ...inspectionMetadata(4),
                ok: true,
                request: { prompt: "provider-prompt-secret" },
                run: run("failed"),
                timeline: [
                  { event: "run.admitted", occurredAt: timestamp },
                  { event: "run.started", occurredAt: timestamp },
                  {
                    event: "tool.authorization_blocked",
                    occurredAt: timestamp,
                    reason: options.authorizationBlockedReason,
                    toolCallId,
                  },
                  { event: "run.completed", occurredAt: timestamp },
                ],
              }
            : options.unknownEffect || options.unknownEffectRunning
              ? {
                  ...inspectionMetadata(options.unknownEffectRunning ? 6 : 7),
                  ok: true,
                  request: { prompt: "provider-prompt-secret" },
                  run: run(options.unknownEffectRunning ? "running" : "failed"),
                  timeline: options.unknownEffectRunning
                    ? unknownTimeline.slice(0, -1)
                    : unknownTimeline,
                }
              : inspectCalls <= (options.pendingRunInspections ?? 0)
                ? {
                    ...inspectionMetadata(2),
                    ok: true,
                    request: { prompt: "provider-prompt-secret" },
                    run: run("running"),
                    timeline: successfulTimeline.slice(0, 2),
                  }
                : {
                    ...inspectionMetadata(7),
                    ok: true,
                    request: { prompt: "provider-prompt-secret" },
                    run: run("completed"),
                    timeline: successfulTimeline,
                  };
    } else if (params.name === "crewhelm_agent_inbox") {
      payload = {
        action: "list",
        generatedAt: timestamp,
        items: [
          {
            acknowledgedAt: null,
            agentId,
            agentName: fixtureName,
            approvalCount: 0,
            configuration: {
              agentRevision: 2,
              fleetRevision: 1,
              scheduleId: scheduleLastRunId === null ? null : scheduleId,
              scheduleRevision: scheduleLastRunId === null ? null : 1,
              eventTrigger: null,
            },
            itemId: `inbox_${runId}`,
            kind: "outcome",
            needsAction: false,
            nextAction: "review_output",
            occurredAt: timestamp,
            policy: null,
            requestPreview: "provider-request-secret",
            resultPreview: "provider-result-secret",
            runId,
            runStatus: "completed",
            severity: "info",
            summary: "provider-summary-secret",
            version: timestamp,
          },
        ],
        nextCursor: null,
        ok: true,
        pollAfterSeconds: 30,
      };
    } else if (params.name === "crewhelm_revoke_authority") {
      advanceTime(options.authorityCleanupLatencyMs ?? 0);
      configured = false;
      payload = {
        changed: true,
        ok: true,
        state: { grantId, status: "revoked", target: "capability" },
      };
    } else if (params.name === "crewhelm_batch_disable_agents") {
      advanceTime(options.authorityCleanupLatencyMs ?? 0);
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

  return {
    elapsedMilliseconds: () => elapsedMilliseconds,
    fetch,
    openedUrls,
    scheduledDispatches: () => scheduleDispatches,
    toolCalls,
  };
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

async function runRehearsal(
  harness: Harness,
  overrides: {
    now?: () => number;
    trigger?: "manual" | "schedule";
    wait?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  return runStandingIntegrationRehearsal(
    {
      connectionId,
      origin: parseDeploymentOrigin(origin),
      runTimeoutMs: 3_000,
      timeoutMs: 1_000,
      trigger: overrides.trigger ?? "manual",
    },
    {
      expectedDeploymentFingerprint: deploymentFingerprint,
      fetch: harness.fetch,
      now: overrides.now ?? (() => Date.parse(timestamp)),
      openUrl: approveAuthorization(harness.openedUrls),
      wait: overrides.wait ?? (async () => {}),
    },
  );
}

describe("standing integration action rehearsal", () => {
  it("uses one standing Gmail draft dispatch, verifies inbox evidence, and cleans up", async () => {
    const harness = rehearsalHarness();
    const report = await runRehearsal(harness);
    const serialized = JSON.stringify(report);

    expect(standingIntegrationRehearsalReportSchema.parse(report)).toEqual(report);
    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      agentId,
      connection: {
        accountLabel: "esteiraliving@gmail.com",
        integrationSlug: "gmail",
        providerConnectionId: "ca_gmail",
      },
      connectionId,
      grantId,
      retainedDraft: true,
      runId,
      runStatus: "completed",
      toolCallId,
      trigger: "manual",
    });
    expect(
      harness.toolCalls.find((call) => call.name === "crewhelm_create_agent")?.arguments,
    ).toMatchObject({
      capabilities: [
        {
          configuration: {
            fallbackModels: [],
            primaryModel: "@cf/zai-org/glm-4.7-flash",
          },
          id: "inference.workers-ai",
          schemaVersion: 2,
        },
      ],
      executionLimits: {
        maxDurationSeconds: 60,
        maxModelTokens: 1_024,
        maxToolCalls: 1,
        maxTurns: 3,
      },
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
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_schedule"),
    ).toHaveLength(0);
    expect(serialized).not.toContain("provider-prompt-secret");
    expect(serialized).not.toContain("provider-output-secret");
    expect(serialized).not.toContain("provider-request-secret");
    expect(serialized).not.toContain("provider-result-secret");
    expect(serialized).not.toContain("provider-summary-secret");
    expect(serialized).not.toContain(accessToken);
  });

  it("waits for one scheduled dispatch, pauses it, verifies inbox evidence, and cleans up", async () => {
    const harness = rehearsalHarness();
    const report = await runRehearsal(harness, { trigger: "schedule" });

    expect(report.ok).toBe(true);
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report).toMatchObject({
      activeAgentsAfter: 3,
      activeAgentsBefore: 3,
      retainedDraft: true,
      runId,
      runStatus: "completed",
      schedulePaused: true,
      scheduleRevision: 1,
      toolCallId,
      trigger: "schedule",
    });
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(0);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_get_agent_schedule"),
    ).toHaveLength(1);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_schedule"),
    ).toHaveLength(2);
    expect(
      harness.toolCalls.find(
        (call) =>
          call.name === "crewhelm_configure_agent_schedule" &&
          z.looseObject({ schedule: z.unknown() }).parse(call.arguments).schedule !== null,
      )?.arguments,
    ).toMatchObject({
      agentId,
      expectedAgentRevision: 2,
      expectedScheduleRevision: null,
      schedule: {
        intervalSeconds: 60,
      },
    });
    expect(report.checks[8]).toMatchObject({ code: "valid", name: "trigger-ready" });
    expect(report.checks[11]).toMatchObject({ code: "valid", name: "trigger-cleanup" });
  });

  it("replays a committed schedule configuration without creating another scheduled run", async () => {
    const harness = rehearsalHarness({ lostScheduleConfigureResponses: 1 });
    const report = await runRehearsal(harness, { trigger: "schedule" });

    expect(report.ok).toBe(true);
    expect(
      harness.toolCalls.filter((call) => call.name === "crewhelm_configure_agent_schedule"),
    ).toHaveLength(3);
    expect(harness.toolCalls.filter((call) => call.name === "crewhelm_start_run")).toHaveLength(0);
    expect(report).toMatchObject({
      runId,
      schedulePaused: true,
      scheduleRevision: 1,
      trigger: "schedule",
    });
  });

  it("aborts inspection and preserves a pause failure before another schedule tick", async () => {
    const harness = rehearsalHarness({
      authorityCleanupLatencyMs: 5_000,
      pendingRunInspections: 1,
      schedulePauseTimeoutResponses: 1,
    });
    const report = await runRehearsal(harness, {
      trigger: "schedule",
    });

    expect(report.ok).toBe(false);
    expect(report.runId).toBe(runId);
    expect(report.runStatus).toBeUndefined();
    expect(report.retainedDraft).toBeUndefined();
    expect(report.schedulePaused).toBeUndefined();
    expect(report.checks[11]).toMatchObject({
      code: "invalid_payload",
      message:
        "Scheduled trigger pause could not be verified after its first dispatch; authority cleanup started immediately.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
    expect(harness.elapsedMilliseconds()).toBe(15_000);
    expect(harness.scheduledDispatches()).toBe(1);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_inspect_run")).toBe(false);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_agent_inbox")).toBe(false);
    const firstPauseIndex = harness.toolCalls.findIndex(
      (call) =>
        call.name === "crewhelm_configure_agent_schedule" &&
        z.looseObject({ schedule: z.null() }).safeParse(call.arguments).success,
    );
    expect(firstPauseIndex).toBeGreaterThan(-1);
    expect(harness.toolCalls[firstPauseIndex + 1]?.name).toBe("crewhelm_revoke_authority");
  });

  it("times out a missing scheduled dispatch and still pauses, revokes, and disables", async () => {
    const harness = rehearsalHarness({ scheduleNeverDispatch: true });
    let time = Date.parse(timestamp);
    const report = await runRehearsal(harness, {
      now: () => time,
      trigger: "schedule",
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.runId).toBeUndefined();
    expect(report.retainedDraft).toBeUndefined();
    expect(report.schedulePaused).toBe(true);
    expect(report.checks[8]).toMatchObject({
      code: "timeout",
      message: "The scheduled trigger did not dispatch in time.",
      status: "fail",
    });
    expect(report.checks[11]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("surfaces a deferred scheduled trigger and still removes its authority", async () => {
    const harness = rehearsalHarness({ scheduleDeferred: true });
    const report = await runRehearsal(harness, { trigger: "schedule" });

    expect(report.ok).toBe(false);
    expect(report.runId).toBeUndefined();
    expect(report.schedulePaused).toBe(true);
    expect(report.checks[8]).toMatchObject({
      code: "invalid_payload",
      message: "Scheduled trigger was deferred by Crewhelm policy.",
      status: "fail",
    });
    expect(report.checks[11]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("fails before mutation when the exact active Gmail connection is absent", async () => {
    const harness = rehearsalHarness({ connectionMissing: true });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("fails before mutation when the exact connection belongs to another integration", async () => {
    const harness = rehearsalHarness({ connectionIntegration: "github" });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({ code: "invalid_payload", status: "fail" });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("fails before mutation when the fleet has an unresolved provider effect", async () => {
    const harness = rehearsalHarness({ unresolvedEffects: 1 });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({
      code: "invalid_payload",
      message:
        "Fleet has 1 unresolved provider effect; inspect and explicitly reconcile before rehearsal.",
      status: "fail",
    });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_list_connections")).toBe(false);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("fails before mutation when fleet policy requires a longer schedule interval", async () => {
    const harness = rehearsalHarness({ scheduleMinimumIntervalSeconds: 120 });
    const report = await runRehearsal(harness, { trigger: "schedule" });

    expect(report.ok).toBe(false);
    expect(report.checks[3]).toMatchObject({
      code: "invalid_payload",
      message:
        "Scheduled rehearsal requires a fleet minimum interval of 60 seconds or less; this fleet requires 120 seconds.",
      status: "fail",
    });
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_list_connections")).toBe(false);
    expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
    expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
  });

  it.each(["input", "scopes"] as const)(
    "fails before mutation when the pinned Gmail %s contract drifts",
    async (unsafeToolContract) => {
      const harness = rehearsalHarness({ unsafeToolContract });
      const report = await runRehearsal(harness);

      expect(report.ok).toBe(false);
      expect(report.checks[5]).toMatchObject({ code: "invalid_payload", status: "fail" });
      expect(harness.toolCalls.some((call) => call.name === "crewhelm_create_agent")).toBe(false);
      expect(report.checks[14]).toMatchObject({ code: "valid", status: "pass" });
    },
  );

  it("reconciles lost configuration and run-start responses with the same idempotency keys", async () => {
    const harness = rehearsalHarness({
      lostConfigureResponses: 1,
      loseFirstStartResponse: true,
    });
    const report = await runRehearsal(harness);

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
    const harness = rehearsalHarness({ lostConfigureResponses: 2 });
    const report = await runRehearsal(harness);

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
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("replays and captures cleanup state after a committed inconsistent configuration response", async () => {
    const harness = rehearsalHarness({ mismatchFirstConfigureResponse: true });
    const report = await runRehearsal(harness);

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
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("surfaces an unknown provider effect without reconciling it and still revokes authority", async () => {
    const harness = rehearsalHarness({ unknownEffect: true });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.runStatus).toBe("failed");
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.retainedDraft).toBeUndefined();
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
    expect(
      harness.toolCalls.some((call) => call.name === "crewhelm_reconcile_tool_execution"),
    ).toBe(false);
  });

  it("reports an unreconciled effect as a pre-dispatch block and still revokes authority", async () => {
    const harness = rehearsalHarness({ authorizationBlockedReason: "unreconciled_effect" });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.runStatus).toBe("failed");
    expect(report.toolCallId).toBeUndefined();
    expect(report.retainedDraft).toBeUndefined();
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message:
        "The provider action was blocked before dispatch because an earlier unknown external effect requires reconciliation.",
      status: "fail",
    });
    expect(report.checks[10]).toMatchObject({ code: "not_run", status: "skip" });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves the manual verification warning when an unknown effect later times out", async () => {
    const harness = rehearsalHarness({ unknownEffectRunning: true });
    let time = Date.parse(timestamp);
    const report = await runRehearsal(harness, {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves the manual verification warning when inspection fails after an unknown effect", async () => {
    const harness = rehearsalHarness({
      failInspectAfterUnknown: true,
      unknownEffectRunning: true,
    });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves the warning for a contract-valid unknown event without a tool-call ID", async () => {
    const harness = rehearsalHarness({
      unknownEffectRunning: true,
      unknownWithoutToolCallId: true,
    });
    let time = Date.parse(timestamp);
    const report = await runRehearsal(harness, {
      now: () => time,
      wait: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBeUndefined();
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });

  it("preserves a prior unknown effect when a later terminal read omits the event", async () => {
    const harness = rehearsalHarness({
      terminalFailureAfterUnknown: true,
      unknownEffectRunning: true,
    });
    const report = await runRehearsal(harness);

    expect(report.ok).toBe(false);
    expect(report.toolCallId).toBe(toolCallId);
    expect(report.checks[9]).toMatchObject({
      code: "invalid_payload",
      message: "Provider effect is unknown; verify the draft account before reconciliation.",
      status: "fail",
    });
    expect(report.checks[12]).toMatchObject({ code: "valid", status: "pass" });
    expect(report.checks[13]).toMatchObject({ code: "valid", status: "pass" });
  });
});
