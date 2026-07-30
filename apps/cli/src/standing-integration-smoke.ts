import { randomBytes } from "node:crypto";

import {
  agentInboxResultSchema,
  batchDisableAgentsResultSchema,
  changeAuthorityResultSchema,
  connectionSummarySchema,
  configureAgentConnectionResultSchema,
  controlPlaneStatusResultSchema,
  createAgentResultSchema,
  getAgentResultSchema,
  inspectIntegrationToolResultSchema,
  inspectRunResultSchema,
  listConnectionsResultSchema,
  listUnresolvedToolEffectsResultSchema,
  startRunResultSchema,
  type Agent,
  type ConnectionSummary,
  type InspectRunResult,
  type Run,
} from "@crewhelm/contracts";
import * as z from "zod";

import { diagnoseDeployment, doctorReportSchema, type DoctorOptions } from "./doctor.js";
import {
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseMcpToolResult,
  runTemporaryOwnerSession,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolCallResponseSchema,
  toolListResponseSchema,
  type TemporaryOwnerMcpSession,
  type TemporaryOwnerSessionDependencies,
} from "./temporary-owner-session.js";

const FULL_SCOPE = "crewhelm:full";
const GMAIL_INTEGRATION_SLUG = "gmail";
const GMAIL_DRAFT_TOOL = {
  slug: "GMAIL_CREATE_EMAIL_DRAFT",
  version: "20260721_00",
} as const;
const GMAIL_DRAFT_REQUIRED_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.readonly",
] as const;
const SAFE_DRAFT_RECIPIENT = "crewhelm-smoke@example.invalid";
const TOOL_CALLING_MODEL = "@cf/zai-org/glm-4.7-flash";
const MAXIMUM_CONNECTION_PAGES = 50;
const MAXIMUM_MCP_SCHEMA_BYTES = 64 * 1_024;
const POLL_INTERVAL_MS = 1_000;
const UNRECONCILED_EFFECT_MESSAGE =
  "The provider action was blocked before dispatch because an earlier unknown external effect requires reconciliation.";
const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"] as const;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
const AGENT_LIMITS = {
  maxDurationSeconds: 60,
  maxModelTokens: 1_024,
  maxToolCalls: 1,
  maxTurns: 3,
} as const;
const TOOL_LIMITS = {
  maxCallsPerRun: 1,
  maxConcurrency: 1,
  maxCostMicrousdPerCall: 50_000,
  maxDurationMs: 30_000,
  maxOutputBytes: 4_096,
} as const;
const REQUIRED_TOOLS = {
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
  crewhelm_list_unresolved_tool_effects: {
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
const gmailDraftInputSchema = z
  .looseObject({
    properties: z.strictObject({
      attachment: z.unknown(),
      bcc: z.looseObject({
        default: z.array(z.string()).length(0),
        items: z.looseObject({ type: z.literal("string") }),
        type: z.literal("array"),
      }),
      body: z.looseObject({ type: z.literal("string") }),
      cc: z.looseObject({
        default: z.array(z.string()).length(0),
        items: z.looseObject({ type: z.literal("string") }),
        type: z.literal("array"),
      }),
      extra_recipients: z.looseObject({
        default: z.array(z.string()).length(0),
        items: z.looseObject({ type: z.literal("string") }),
        type: z.literal("array"),
      }),
      is_html: z.looseObject({
        default: z.literal(false),
        type: z.literal("boolean"),
      }),
      recipient_email: z.looseObject({ type: z.literal("string") }),
      subject: z.looseObject({ type: z.literal("string") }),
      thread_id: z.looseObject({ type: z.literal("string") }),
      user_id: z.looseObject({
        default: z.literal("me"),
        type: z.literal("string"),
      }),
    }),
    required: z.array(z.string()).length(0).optional(),
    type: z.literal("object"),
  })
  .refine(
    (input) => input.required === undefined || input.required.length === 0,
    "Expected no required Gmail draft inputs.",
  );

const standingIntegrationSmokeCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  endpoint: z.url(),
  message: z.string().max(512),
  name: z.enum([
    "oauth-full-control",
    "mcp-initialize",
    "mcp-tool-catalog",
    "fleet-recovery",
    "connection-target",
    "integration-tool",
    "agent-create",
    "standing-grant",
    "run-single-dispatch",
    "inbox-outcome",
    "grant-revoke",
    "agent-disable",
    "oauth-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const standingIntegrationSmokeReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  public: doctorReportSchema,
  connectionId: z.string().optional(),
  connection: connectionSummarySchema.optional(),
  agentId: z.string().optional(),
  grantId: z.string().optional(),
  runId: z.string().optional(),
  runStatus: z.enum(["cancelled", "completed", "failed"]).optional(),
  toolCallId: z.string().optional(),
  fixtureSubject: z.string().max(160).optional(),
  retainedDraft: z.boolean().optional(),
  activeAgentsBefore: z.number().int().nonnegative().safe().optional(),
  activeAgentsAfter: z.number().int().nonnegative().safe().optional(),
  checks: z.tuple([
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
    standingIntegrationSmokeCheckSchema,
  ]),
});

export type StandingIntegrationSmokeReport = z.infer<typeof standingIntegrationSmokeReportSchema>;
type SmokeCheck = StandingIntegrationSmokeReport["checks"][number];
type SmokeCheckName = SmokeCheck["name"];

export interface StandingIntegrationSmokeOptions extends DoctorOptions {
  authorizationTimeoutMs?: number;
  connectionId: string;
  runTimeoutMs: number;
}

export interface StandingIntegrationSmokeDependencies extends TemporaryOwnerSessionDependencies {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const checkDefinitions = {
  agentCreate: {
    name: "agent-create",
    validMessage: "A disposable one-tool Agent was created with strict execution limits.",
  },
  agentDisable: {
    name: "agent-disable",
    validMessage: "The exact Agent revision was disabled and released active capacity.",
  },
  connectionTarget: {
    name: "connection-target",
    validMessage: "The exact active Gmail connection was found without exposing provider identity.",
  },
  fleetRecovery: {
    name: "fleet-recovery",
    validMessage: "The fleet has no unresolved provider effects blocking safe mutation.",
  },
  grantRevoke: {
    name: "grant-revoke",
    validMessage: "The exact standing capability grant was revoked.",
  },
  inboxOutcome: {
    name: "inbox-outcome",
    validMessage: "The completed run produced one correlated inbox outcome without approval.",
  },
  integrationTool: {
    name: "integration-tool",
    validMessage: "The exact allowlisted Gmail draft tool version matched its safe contract.",
  },
  mcpInitialize: {
    name: "mcp-initialize",
    validMessage: "Authenticated MCP initialization succeeded.",
  },
  mcpToolCatalog: {
    name: "mcp-tool-catalog",
    validMessage: "The bounded MCP catalog exposes the exact rehearsal tools.",
  },
  oauthFullControl: {
    name: "oauth-full-control",
    validMessage: "Temporary Full control owner access was granted.",
  },
  oauthTokenRevocation: {
    name: "oauth-token-revocation",
    validMessage: "The temporary access token was revoked.",
  },
  runSingleDispatch: {
    name: "run-single-dispatch",
    validMessage: "One standing action was authorized, dispatched once, and completed.",
  },
  standingGrant: {
    name: "standing-grant",
    validMessage: "One expiring, one-call standing Gmail draft grant was attached.",
  },
} as const satisfies Record<string, { name: SmokeCheckName; validMessage: string }>;

function createCheck(
  name: SmokeCheckName,
  endpoint: URL,
  code: SmokeCheck["code"],
  message: string,
): SmokeCheck {
  return standingIntegrationSmokeCheckSchema.parse({
    code,
    endpoint: endpoint.href,
    message,
    name,
    status: code === "valid" ? "pass" : code === "not_run" ? "skip" : "fail",
  });
}

function skippedCheck(name: SmokeCheckName, endpoint: URL): SmokeCheck {
  return createCheck(name, endpoint, "not_run", "Check was not run.");
}

function failedCheck(name: SmokeCheckName, endpoint: URL, error: unknown): SmokeCheck {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    temporaryOwnerSessionErrorCodeSchema.safeParse(error.code).success
    ? createCheck(
        name,
        endpoint,
        temporaryOwnerSessionErrorCodeSchema.parse(error.code),
        error.message,
      )
    : createCheck(name, endpoint, "request_failed", "Standing integration rehearsal check failed.");
}

async function callTool<T>(
  session: TemporaryOwnerMcpSession,
  name: keyof typeof REQUIRED_TOOLS,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: arguments_, name },
    toolCallResponseSchema,
  );
  return parseMcpToolResult(response, schema, invalidMessage);
}

async function readStatus(session: TemporaryOwnerMcpSession) {
  const result = await callTool(
    session,
    "crewhelm_status",
    {},
    controlPlaneStatusResultSchema,
    "Fleet status returned an invalid payload.",
  );

  if (!result.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", "Fleet status request was denied.");
  }

  return result.status;
}

function validateToolCatalog(toolList: z.infer<typeof toolListResponseSchema>): void {
  const names = toolList.result.tools.map((tool) => tool.name);
  const serializedSchemaBytes = new TextEncoder().encode(
    JSON.stringify(toolList.result.tools.map((tool) => tool.inputSchema)),
  ).byteLength;

  if (new Set(names).size !== names.length || serializedSchemaBytes > MAXIMUM_MCP_SCHEMA_BYTES) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "MCP tool catalog violated its bounded contract.",
    );
  }

  for (const [name, annotations] of Object.entries(REQUIRED_TOOLS)) {
    const tool = toolList.result.tools.find((candidate) => candidate.name === name);

    if (
      !tool ||
      tool.annotations.destructiveHint !== annotations.destructiveHint ||
      tool.annotations.idempotentHint !== annotations.idempotentHint ||
      tool.annotations.openWorldHint !== annotations.openWorldHint ||
      tool.annotations.readOnlyHint !== annotations.readOnlyHint
    ) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "MCP tool catalog violated its standing-integration contract.",
      );
    }
  }
}

function fixtureSuffix(now: number): string {
  return `${now.toString(36)}-${randomBytes(6).toString("base64url")}`;
}

function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

async function validateConnectionTarget(
  session: TemporaryOwnerMcpSession,
  connectionId: string,
  maximumConnections: number,
): Promise<ConnectionSummary> {
  let cursor: string | undefined;
  const maximumPages = Math.min(
    MAXIMUM_CONNECTION_PAGES,
    Math.max(1, Math.ceil(maximumConnections / 25)),
  );

  for (let page = 0; page < maximumPages; page += 1) {
    const result = await callTool(
      session,
      "crewhelm_list_connections",
      {
        authorizationOutcome: "returned",
        integration: GMAIL_INTEGRATION_SLUG,
        limit: 20,
        ...(cursor === undefined ? {} : { cursor }),
      },
      listConnectionsResultSchema,
      "Connection listing returned an invalid payload.",
    );

    if (!result.ok) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "The exact Gmail connection could not be verified.",
      );
    }

    const connection = result.connections.find(
      (candidate) =>
        candidate.connectionId === connectionId &&
        candidate.authorizationOutcome === "returned" &&
        candidate.integrationSlug === GMAIL_INTEGRATION_SLUG &&
        (candidate.status === "initiated" || candidate.status === "active"),
    );

    if (connection !== undefined) {
      return connection;
    }

    if (result.nextCursor === null) {
      break;
    }

    cursor = result.nextCursor;
  }

  throw new TemporaryOwnerSessionError(
    "invalid_payload",
    "The requested connection is not the exact authorized Gmail account.",
  );
}

async function validateIntegrationTool(session: TemporaryOwnerMcpSession): Promise<void> {
  const result = await callTool(
    session,
    "crewhelm_inspect_integration_tool",
    GMAIL_DRAFT_TOOL,
    inspectIntegrationToolResultSchema,
    "Integration tool inspection returned an invalid payload.",
  );

  if (
    !result.ok ||
    result.tool.integration.slug !== GMAIL_INTEGRATION_SLUG ||
    result.tool.slug !== GMAIL_DRAFT_TOOL.slug ||
    result.tool.version !== GMAIL_DRAFT_TOOL.version ||
    result.tool.noAuth !== false ||
    JSON.stringify(result.tool.requiredScopes) !== JSON.stringify(GMAIL_DRAFT_REQUIRED_SCOPES) ||
    !result.tool.tags.includes("createHint") ||
    !result.tool.tags.includes("important") ||
    !gmailDraftInputSchema.safeParse(result.tool.inputParameters).success
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "The allowlisted Gmail draft tool no longer matches its safe contract.",
    );
  }
}

function validateCreatedAgent(
  result: z.infer<typeof createAgentResultSchema>,
  fixture: { instructions: string; name: string },
  expectedCreated?: boolean,
): Agent {
  if (
    !result.ok ||
    (expectedCreated !== undefined && result.created !== expectedCreated) ||
    result.agent.capabilityGrants.length !== 0 ||
    result.agent.executionLimits.maxDurationSeconds !== AGENT_LIMITS.maxDurationSeconds ||
    result.agent.executionLimits.maxModelTokens !== AGENT_LIMITS.maxModelTokens ||
    result.agent.executionLimits.maxToolCalls !== AGENT_LIMITS.maxToolCalls ||
    result.agent.executionLimits.maxTurns !== AGENT_LIMITS.maxTurns ||
    result.agent.instructions !== fixture.instructions ||
    result.agent.model !== TOOL_CALLING_MODEL ||
    result.agent.name !== fixture.name ||
    result.agent.revision !== 1 ||
    result.agent.status !== "active"
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Disposable Agent did not match the exact requested fixture.",
    );
  }

  return result.agent;
}

function validateConfiguredAgent(
  result: z.infer<typeof configureAgentConnectionResultSchema>,
  previousAgent: Agent,
  expectedConfigured?: boolean,
): Agent {
  if (
    !result.ok ||
    (expectedConfigured !== undefined && result.configured !== expectedConfigured) ||
    result.agent.id !== previousAgent.id ||
    result.agent.revision !== previousAgent.revision + 1 ||
    result.agent.status !== "active" ||
    result.agent.capabilityGrants.length !== 1
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Standing Gmail grant did not match the exact requested fixture.",
    );
  }

  return result.agent;
}

function validateStartedRun(
  result: z.infer<typeof startRunResultSchema>,
  agent: Agent,
  expectedCreated?: boolean,
): Run {
  if (
    !result.ok ||
    (expectedCreated !== undefined && result.created !== expectedCreated) ||
    result.run.agentId !== agent.id ||
    result.run.agentRevision !== agent.revision ||
    result.run.trigger !== "manual"
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Standing integration run did not match the exact requested fixture.",
    );
  }

  return result.run;
}

function validateSingleDispatch(inspected: Extract<InspectRunResult, { ok: true }>): string {
  const timeline = inspected.timeline;
  const unreconciledEffect = timeline.find(
    (event) =>
      event.event === "tool.authorization_blocked" && event.reason === "unreconciled_effect",
  );

  if (unreconciledEffect) {
    throw new TemporaryOwnerSessionError("invalid_payload", UNRECONCILED_EFFECT_MESSAGE);
  }

  const deniedEvents = new Set([
    "tool.approval_required",
    "tool.authorization_approval_required",
    "tool.authorization_blocked",
    "tool.execution_failed",
    "tool.execution_unknown",
  ]);
  const eventNames = timeline.map((event) => event.event);
  const dispatched = timeline.filter((event) => event.event === "tool.execution_dispatched");
  const completed = timeline.filter((event) => event.event === "tool.execution_completed");
  const allowed = timeline.filter((event) => event.event === "tool.authorization_allowed");
  const reserved = timeline.filter((event) => event.event === "tool.execution_reserved");
  const toolCallId = dispatched[0]?.toolCallId;

  if (
    eventNames.some((event) => deniedEvents.has(event)) ||
    dispatched.length !== 1 ||
    completed.length !== 1 ||
    allowed.length !== 1 ||
    reserved.length !== 1 ||
    toolCallId === undefined ||
    completed[0]?.toolCallId !== toolCallId ||
    allowed[0]?.toolCallId !== toolCallId ||
    reserved[0]?.toolCallId !== toolCallId ||
    eventNames.filter((event) => event === "run.completed").length !== 1
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "The standing action did not produce one allowed, single-dispatch completion.",
    );
  }

  return toolCallId;
}

export async function runStandingIntegrationSmoke(
  options: StandingIntegrationSmokeOptions,
  dependencies: StandingIntegrationSmokeDependencies,
): Promise<StandingIntegrationSmokeReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const mcpEndpoint = new URL("/mcp", options.origin);
  const authorizeEndpoint = new URL("/api/auth/oauth2/authorize", options.origin);
  const revokeEndpoint = new URL("/api/auth/oauth2/revoke", options.origin);
  const checks: StandingIntegrationSmokeReport["checks"] = [
    skippedCheck(checkDefinitions.oauthFullControl.name, authorizeEndpoint),
    skippedCheck(checkDefinitions.mcpInitialize.name, mcpEndpoint),
    skippedCheck(checkDefinitions.mcpToolCatalog.name, mcpEndpoint),
    skippedCheck(checkDefinitions.fleetRecovery.name, mcpEndpoint),
    skippedCheck(checkDefinitions.connectionTarget.name, mcpEndpoint),
    skippedCheck(checkDefinitions.integrationTool.name, mcpEndpoint),
    skippedCheck(checkDefinitions.agentCreate.name, mcpEndpoint),
    skippedCheck(checkDefinitions.standingGrant.name, mcpEndpoint),
    skippedCheck(checkDefinitions.runSingleDispatch.name, mcpEndpoint),
    skippedCheck(checkDefinitions.inboxOutcome.name, mcpEndpoint),
    skippedCheck(checkDefinitions.grantRevoke.name, mcpEndpoint),
    skippedCheck(checkDefinitions.agentDisable.name, mcpEndpoint),
    skippedCheck(checkDefinitions.oauthTokenRevocation.name, revokeEndpoint),
  ];

  if (!publicReport.ok) {
    return standingIntegrationSmokeReportSchema.parse({
      schemaVersion: 1,
      ok: false,
      public: publicReport,
      connectionId: options.connectionId,
      checks,
    });
  }

  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const suffix = fixtureSuffix(startedAt);
  const fixtureSubject = `Crewhelm standing authority smoke ${suffix}`;
  const fixture = {
    instructions: `Execute exactly one Gmail draft creation when explicitly asked. Address it only to ${SAFE_DRAFT_RECIPIENT}. Never send, update, list, read, or delete email. Return only a short confirmation without provider data.`,
    name: `Crewhelm standing integration smoke ${suffix}`,
  };
  const createInput = {
    executionLimits: AGENT_LIMITS,
    idempotencyKey: `smoke-integration-create-${suffix}`,
    model: TOOL_CALLING_MODEL,
    ...fixture,
  };
  let activeCheckIndex = 1;
  let agent: Agent | undefined;
  let connection: ConnectionSummary | undefined;
  let agentId: string | undefined;
  let grantId: string | undefined;
  let runId: string | undefined;
  let runStatus: TerminalRunStatus | undefined;
  let toolCallId: string | undefined;
  let retainedDraft: boolean | undefined;
  let unknownProviderEffect = false;
  let activeAgentsBefore: number | undefined;
  let activeAgentsAfter: number | undefined;

  const cleanupGrant = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    activeCheckIndex = 10;

    if (!grantId) {
      return;
    }

    try {
      const revoked = await callTool(
        session,
        "crewhelm_revoke_authority",
        { grantId, target: "capability" },
        changeAuthorityResultSchema,
        "Standing grant revocation returned an invalid payload.",
      );

      if (
        !revoked.ok ||
        revoked.state.target !== "capability" ||
        revoked.state.grantId !== grantId ||
        revoked.state.status !== "revoked"
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Standing grant revocation could not be verified.",
        );
      }

      checks[10] = createCheck(
        checkDefinitions.grantRevoke.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.grantRevoke.validMessage,
      );
    } catch (error) {
      checks[10] = failedCheck(checkDefinitions.grantRevoke.name, mcpEndpoint, error);
    }
  };

  const cleanupAgent = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    activeCheckIndex = 11;

    if (!agent) {
      return;
    }

    try {
      const disabled = await callTool(
        session,
        "crewhelm_batch_disable_agents",
        {
          agents: [{ agentId: agent.id, expectedRevision: agent.revision }],
        },
        batchDisableAgentsResultSchema,
        "Agent disablement returned an invalid payload.",
      );
      const receipt = disabled.ok ? disabled.receipts[0] : undefined;

      if (
        !disabled.ok ||
        disabled.receipts.length !== 1 ||
        receipt?.agentId !== agent.id ||
        receipt.expectedRevision !== agent.revision ||
        (receipt.outcome !== "disabled" && receipt.outcome !== "already_disabled")
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Disposable Agent disablement could not be verified.",
        );
      }

      const exactAgent = await callTool(
        session,
        "crewhelm_get_agent",
        { id: agent.id },
        getAgentResultSchema,
        "Disabled Agent read returned an invalid payload.",
      );
      const afterDisable = await readStatus(session);
      activeAgentsAfter = afterDisable.usage.agents.active;

      if (
        !exactAgent.ok ||
        exactAgent.agent.id !== agent.id ||
        exactAgent.agent.status !== "disabled" ||
        exactAgent.agent.revision !== agent.revision ||
        activeAgentsAfter !== activeAgentsBefore
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Disposable Agent cleanup did not release active capacity.",
        );
      }

      checks[11] = createCheck(
        checkDefinitions.agentDisable.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.agentDisable.validMessage,
      );
    } catch (error) {
      checks[11] = failedCheck(checkDefinitions.agentDisable.name, mcpEndpoint, error);
    }
  };

  const sessionResult = await runTemporaryOwnerSession(
    {
      ...(options.authorizationTimeoutMs === undefined
        ? {}
        : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
      clientName: "Crewhelm standing integration smoke",
      origin: options.origin,
      scope: FULL_SCOPE,
      timeoutMs: options.timeoutMs,
    },
    dependencies,
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-cli", version: "0.0.0" },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      checks[1] = createCheck(
        checkDefinitions.mcpInitialize.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.mcpInitialize.validMessage,
      );

      activeCheckIndex = 2;
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      validateToolCatalog(catalog);
      checks[2] = createCheck(
        checkDefinitions.mcpToolCatalog.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.mcpToolCatalog.validMessage,
      );

      activeCheckIndex = 3;
      const baseline = await readStatus(session);
      activeAgentsBefore = baseline.usage.agents.active;
      const recovery = await callTool(
        session,
        "crewhelm_list_unresolved_tool_effects",
        { limit: 1 },
        listUnresolvedToolEffectsResultSchema,
        "Fleet recovery read returned an invalid payload.",
      );

      if (!recovery.ok) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Fleet recovery state could not be verified.",
        );
      }

      if (recovery.total > 0) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          `Fleet has ${recovery.total} unresolved provider effect${recovery.total === 1 ? "" : "s"}; inspect and explicitly reconcile before rehearsal.`,
        );
      }

      checks[3] = createCheck(
        checkDefinitions.fleetRecovery.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.fleetRecovery.validMessage,
      );

      activeCheckIndex = 4;
      connection = await validateConnectionTarget(
        session,
        options.connectionId,
        baseline.capacity.maxConnections,
      );
      checks[4] = createCheck(
        checkDefinitions.connectionTarget.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.connectionTarget.validMessage,
      );

      activeCheckIndex = 5;
      await validateIntegrationTool(session);
      checks[5] = createCheck(
        checkDefinitions.integrationTool.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.integrationTool.validMessage,
      );

      activeCheckIndex = 6;
      let createdAgent: Agent | undefined;
      let created: z.infer<typeof createAgentResultSchema> | undefined;

      try {
        created = await callTool(
          session,
          "crewhelm_create_agent",
          createInput,
          createAgentResultSchema,
          "Agent creation returned an invalid payload.",
        );
      } catch {
        const recovered = await callTool(
          session,
          "crewhelm_create_agent",
          createInput,
          createAgentResultSchema,
          "Agent creation could not be reconciled after an ambiguous response.",
        );
        createdAgent = validateCreatedAgent(recovered, fixture);
      }

      if (created) {
        createdAgent = validateCreatedAgent(created, fixture, true);
      }

      if (!createdAgent) {
        throw new TemporaryOwnerSessionError(
          "request_failed",
          "Disposable Agent creation did not complete.",
        );
      }

      agent = createdAgent;
      agentId = createdAgent.id;

      try {
        const afterCreate = await readStatus(session);

        if (afterCreate.usage.agents.active !== activeAgentsBefore + 1) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Disposable Agent active capacity could not be verified.",
          );
        }

        checks[6] = createCheck(
          checkDefinitions.agentCreate.name,
          mcpEndpoint,
          "valid",
          checkDefinitions.agentCreate.validMessage,
        );

        activeCheckIndex = 7;
        const configureInput = {
          agentId: createdAgent.id,
          connectionId: options.connectionId,
          expectedRevision: createdAgent.revision,
          expiresAt: new Date(now() + 10 * 60 * 1_000).toISOString(),
          idempotencyKey: `smoke-integration-grant-${suffix}`,
          limits: TOOL_LIMITS,
          tools: [{ authorization: "standing", ...GMAIL_DRAFT_TOOL }],
        };
        let configuredAgent: Agent | undefined;
        let configured: z.infer<typeof configureAgentConnectionResultSchema> | undefined;

        try {
          configured = await callTool(
            session,
            "crewhelm_configure_agent_connection",
            configureInput,
            configureAgentConnectionResultSchema,
            "Standing grant configuration returned an invalid payload.",
          );
          configuredAgent = validateConfiguredAgent(configured, createdAgent, true);
        } catch {
          try {
            const recovered = await callTool(
              session,
              "crewhelm_configure_agent_connection",
              configureInput,
              configureAgentConnectionResultSchema,
              "Standing grant configuration could not be reconciled after an ambiguous response.",
            );
            configuredAgent = validateConfiguredAgent(recovered, createdAgent);
          } catch {
            const exactAgent = await callTool(
              session,
              "crewhelm_get_agent",
              { id: createdAgent.id },
              getAgentResultSchema,
              "Standing grant state could not be recovered after ambiguous responses.",
            );

            if (!exactAgent.ok || exactAgent.agent.id !== createdAgent.id) {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Standing grant state could not be recovered after ambiguous responses.",
              );
            }

            configuredAgent = validateConfiguredAgent(
              { agent: exactAgent.agent, configured: false, ok: true },
              createdAgent,
            );
          }
        }

        if (!configuredAgent) {
          throw new TemporaryOwnerSessionError(
            "request_failed",
            "Standing grant configuration did not complete.",
          );
        }

        agent = configuredAgent;
        grantId = configuredAgent.capabilityGrants[0];
        checks[7] = createCheck(
          checkDefinitions.standingGrant.name,
          mcpEndpoint,
          "valid",
          checkDefinitions.standingGrant.validMessage,
        );

        activeCheckIndex = 8;
        const startInput = {
          agentId: configuredAgent.id,
          expectedRevision: configuredAgent.revision,
          idempotencyKey: `smoke-integration-run-${suffix}`,
          prompt: `Create exactly one Gmail draft addressed only to "${SAFE_DRAFT_RECIPIENT}" with subject "${fixtureSubject}" and body "This draft was created by an explicitly authorized Crewhelm standing-authority rehearsal." Do not add Cc, Bcc, extra recipients, attachments, HTML, or a thread ID. Do not perform any other action.`,
        };
        let startedRun: Run | undefined;
        let started: z.infer<typeof startRunResultSchema> | undefined;

        try {
          started = await callTool(
            session,
            "crewhelm_start_run",
            startInput,
            startRunResultSchema,
            "Standing integration run start returned an invalid payload.",
          );
        } catch {
          const recovered = await callTool(
            session,
            "crewhelm_start_run",
            startInput,
            startRunResultSchema,
            "Standing integration run start could not be reconciled after an ambiguous response.",
          );
          startedRun = validateStartedRun(recovered, configuredAgent);
        }

        if (started) {
          startedRun = validateStartedRun(started, configuredAgent, true);
        }

        if (!startedRun) {
          throw new TemporaryOwnerSessionError(
            "request_failed",
            "Standing integration run start did not complete.",
          );
        }

        runId = startedRun.runId;
        const deadline = now() + options.runTimeoutMs;

        for (;;) {
          let inspected: z.infer<typeof inspectRunResultSchema>;

          try {
            inspected = await callTool(
              session,
              "crewhelm_inspect_run",
              { runId: startedRun.runId, timelineLimit: 50 },
              inspectRunResultSchema,
              "Standing integration run inspection returned an invalid payload.",
            );
          } catch (error) {
            if (unknownProviderEffect) {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Provider effect is unknown; verify the draft account before reconciliation.",
              );
            }

            throw error;
          }

          if (
            !inspected.ok ||
            inspected.run.runId !== startedRun.runId ||
            inspected.run.agentId !== configuredAgent.id ||
            inspected.run.agentRevision !== configuredAgent.revision
          ) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Run inspection did not match the standing integration fixture.",
            );
          }

          const timeline = inspected.timeline;
          const unknown = timeline.find((event) => event.event === "tool.execution_unknown");
          const unreconciledEffect = timeline.some(
            (event) =>
              event.event === "tool.authorization_blocked" &&
              event.reason === "unreconciled_effect",
          );

          if (unknown) {
            unknownProviderEffect = true;

            if (unknown.toolCallId) {
              toolCallId = unknown.toolCallId;
            }
          }

          if (isTerminalRunStatus(inspected.run.status)) {
            runStatus = inspected.run.status;

            if (inspected.run.status !== "completed") {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                unreconciledEffect
                  ? UNRECONCILED_EFFECT_MESSAGE
                  : unknownProviderEffect
                    ? "Provider effect is unknown; verify the draft account before reconciliation."
                    : "Standing integration run did not complete successfully.",
              );
            }

            toolCallId = validateSingleDispatch(inspected);
            retainedDraft = true;
            checks[8] = createCheck(
              checkDefinitions.runSingleDispatch.name,
              mcpEndpoint,
              "valid",
              checkDefinitions.runSingleDispatch.validMessage,
            );
            break;
          }

          if (now() >= deadline) {
            throw new TemporaryOwnerSessionError(
              unknownProviderEffect ? "invalid_payload" : "timeout",
              unknownProviderEffect
                ? "Provider effect is unknown; verify the draft account before reconciliation."
                : "Standing integration run did not reach a terminal state in time.",
            );
          }

          await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        }

        activeCheckIndex = 9;

        for (;;) {
          const inbox = await callTool(
            session,
            "crewhelm_agent_inbox",
            {
              action: "list",
              agentId: configuredAgent.id,
              includeAcknowledged: true,
              kinds: ["outcome"],
              limit: 20,
              occurredAfter: new Date(startedAt).toISOString(),
            },
            agentInboxResultSchema,
            "Agent inbox returned an invalid payload.",
          );

          if (!inbox.ok || inbox.action !== "list") {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Agent inbox outcome could not be verified.",
            );
          }

          const item = inbox.items.find((candidate) => candidate.runId === startedRun.runId);

          if (item) {
            if (
              item.agentId !== configuredAgent.id ||
              item.kind !== "outcome" ||
              item.runStatus !== "completed" ||
              item.approvalCount !== 0
            ) {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Agent inbox outcome did not match the standing integration run.",
              );
            }

            checks[9] = createCheck(
              checkDefinitions.inboxOutcome.name,
              mcpEndpoint,
              "valid",
              checkDefinitions.inboxOutcome.validMessage,
            );
            break;
          }

          if (now() >= deadline) {
            throw new TemporaryOwnerSessionError(
              "timeout",
              "The correlated Agent inbox outcome did not arrive in time.",
            );
          }

          await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        }
      } catch (error) {
        checks[activeCheckIndex] = failedCheck(checks[activeCheckIndex]!.name, mcpEndpoint, error);
      } finally {
        await cleanupGrant(session);
        await cleanupAgent(session);
      }
    },
  );

  checks[0] = sessionResult.authorization.ok
    ? createCheck(
        checkDefinitions.oauthFullControl.name,
        authorizeEndpoint,
        "valid",
        checkDefinitions.oauthFullControl.validMessage,
      )
    : failedCheck(
        checkDefinitions.oauthFullControl.name,
        authorizeEndpoint,
        sessionResult.authorization.error,
      );

  if (sessionResult.operation.status === "failed") {
    checks[activeCheckIndex] = failedCheck(
      checks[activeCheckIndex]!.name,
      mcpEndpoint,
      sessionResult.operation.error,
    );
  }

  if (sessionResult.revocation.status === "revoked") {
    checks[12] = createCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      "valid",
      checkDefinitions.oauthTokenRevocation.validMessage,
    );
  } else if (sessionResult.revocation.status === "failed") {
    checks[12] = failedCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      sessionResult.revocation.error,
    );
  }

  return standingIntegrationSmokeReportSchema.parse({
    schemaVersion: 1,
    ok: publicReport.ok && checks.every((check) => check.status === "pass"),
    public: publicReport,
    connectionId: options.connectionId,
    ...(connection === undefined ? {} : { connection }),
    fixtureSubject,
    ...(agentId === undefined ? {} : { agentId }),
    ...(grantId === undefined ? {} : { grantId }),
    ...(runId === undefined ? {} : { runId }),
    ...(runStatus === undefined ? {} : { runStatus }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(retainedDraft === undefined ? {} : { retainedDraft }),
    ...(activeAgentsBefore === undefined ? {} : { activeAgentsBefore }),
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    checks,
  });
}
