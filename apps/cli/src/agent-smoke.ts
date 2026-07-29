import { randomBytes } from "node:crypto";

import {
  batchDisableAgentsResultSchema,
  controlPlaneStatusResultSchema,
  createAgentResultSchema,
  getAgentResultSchema,
  inspectRunResultSchema,
  startRunResultSchema,
  type Agent,
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
const MAXIMUM_MCP_SCHEMA_BYTES = 64 * 1_024;
const POLL_INTERVAL_MS = 1_000;
const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"] as const;
type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
const AGENT_LIMITS = {
  maxDurationSeconds: 45,
  maxModelTokens: 512,
  maxToolCalls: 0,
  maxTurns: 1,
} as const;
const REQUIRED_TOOLS = {
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

const agentSmokeCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  endpoint: z.url(),
  message: z.string().max(512),
  name: z.enum([
    "oauth-full-control",
    "mcp-initialize",
    "mcp-tool-catalog",
    "agent-create",
    "run-terminal",
    "agent-disable",
    "oauth-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const agentSmokeReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  public: doctorReportSchema,
  agentId: z.string().optional(),
  runId: z.string().optional(),
  runStatus: z.enum(["cancelled", "completed", "failed"]).optional(),
  activeAgentsBefore: z.number().int().nonnegative().safe().optional(),
  activeAgentsAfter: z.number().int().nonnegative().safe().optional(),
  checks: z.tuple([
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
    agentSmokeCheckSchema,
  ]),
});

export type AgentSmokeReport = z.infer<typeof agentSmokeReportSchema>;
type AgentSmokeCheck = AgentSmokeReport["checks"][number];
type AgentSmokeCheckName = AgentSmokeCheck["name"];

export interface AgentSmokeOptions extends DoctorOptions {
  authorizationTimeoutMs?: number;
  runTimeoutMs: number;
}

export interface AgentSmokeDependencies extends TemporaryOwnerSessionDependencies {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const checkDefinitions = {
  agentCreate: {
    name: "agent-create",
    validMessage: "A zero-grant Agent was created with strict execution limits.",
  },
  agentDisable: {
    name: "agent-disable",
    validMessage: "The exact Agent revision was disabled and released active capacity.",
  },
  mcpInitialize: {
    name: "mcp-initialize",
    validMessage: "Authenticated MCP initialization succeeded.",
  },
  mcpToolCatalog: {
    name: "mcp-tool-catalog",
    validMessage: "The bounded MCP catalog exposes the exact lifecycle tools.",
  },
  oauthFullControl: {
    name: "oauth-full-control",
    validMessage: "Temporary Full control owner access was granted.",
  },
  oauthTokenRevocation: {
    name: "oauth-token-revocation",
    validMessage: "The temporary access token was revoked.",
  },
  runTerminal: {
    name: "run-terminal",
    validMessage: "The bounded no-tool Agent run completed successfully.",
  },
} as const satisfies Record<string, { name: AgentSmokeCheckName; validMessage: string }>;

function createCheck(
  name: AgentSmokeCheckName,
  endpoint: URL,
  code: AgentSmokeCheck["code"],
  message: string,
): AgentSmokeCheck {
  return agentSmokeCheckSchema.parse({
    code,
    endpoint: endpoint.href,
    message,
    name,
    status: code === "valid" ? "pass" : code === "not_run" ? "skip" : "fail",
  });
}

function skippedCheck(name: AgentSmokeCheckName, endpoint: URL): AgentSmokeCheck {
  return createCheck(name, endpoint, "not_run", "Check was not run.");
}

function failedCheck(name: AgentSmokeCheckName, endpoint: URL, error: unknown): AgentSmokeCheck {
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
    : createCheck(name, endpoint, "request_failed", "Agent lifecycle check failed.");
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
        "MCP tool catalog violated its lifecycle contract.",
      );
    }
  }
}

function randomFixtureSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString("base64url")}`;
}

function isTerminalRunStatus(status: string): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

function validateCreatedFixture(
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
      "Disposable Agent run did not match the exact requested fixture.",
    );
  }

  return result.run;
}

export async function runAgentSmoke(
  options: AgentSmokeOptions,
  dependencies: AgentSmokeDependencies,
): Promise<AgentSmokeReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const mcpEndpoint = new URL("/mcp", options.origin);
  const authorizeEndpoint = new URL("/api/auth/oauth2/authorize", options.origin);
  const revokeEndpoint = new URL("/api/auth/oauth2/revoke", options.origin);
  const checks: AgentSmokeReport["checks"] = [
    skippedCheck(checkDefinitions.oauthFullControl.name, authorizeEndpoint),
    skippedCheck(checkDefinitions.mcpInitialize.name, mcpEndpoint),
    skippedCheck(checkDefinitions.mcpToolCatalog.name, mcpEndpoint),
    skippedCheck(checkDefinitions.agentCreate.name, mcpEndpoint),
    skippedCheck(checkDefinitions.runTerminal.name, mcpEndpoint),
    skippedCheck(checkDefinitions.agentDisable.name, mcpEndpoint),
    skippedCheck(checkDefinitions.oauthTokenRevocation.name, revokeEndpoint),
  ];

  if (!publicReport.ok) {
    return agentSmokeReportSchema.parse({
      schemaVersion: 1,
      ok: false,
      public: publicReport,
      checks,
    });
  }

  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const suffix = randomFixtureSuffix();
  const fixture = {
    instructions: "Return one short plain-text acknowledgment. Do not request or call any tools.",
    name: `Crewhelm lifecycle smoke ${suffix}`,
  };
  const createInput = {
    executionLimits: AGENT_LIMITS,
    idempotencyKey: `smoke-create-${suffix}`,
    ...fixture,
  };
  let activeCheckIndex = 1;
  let agent: Agent | undefined;
  let agentId: string | undefined;
  let runId: string | undefined;
  let runStatus: "cancelled" | "completed" | "failed" | undefined;
  let activeAgentsBefore: number | undefined;
  let activeAgentsAfter: number | undefined;

  const cleanupAgent = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    activeCheckIndex = 5;

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

      checks[5] = createCheck(
        checkDefinitions.agentDisable.name,
        mcpEndpoint,
        "valid",
        checkDefinitions.agentDisable.validMessage,
      );
    } catch (error) {
      checks[5] = failedCheck(checkDefinitions.agentDisable.name, mcpEndpoint, error);
    }
  };

  const sessionResult = await runTemporaryOwnerSession(
    {
      ...(options.authorizationTimeoutMs === undefined
        ? {}
        : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
      clientName: "Crewhelm Agent lifecycle smoke",
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

        createdAgent = validateCreatedFixture(recovered, fixture);
      }

      if (created) {
        createdAgent = validateCreatedFixture(created, fixture, true);
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

        checks[3] = createCheck(
          checkDefinitions.agentCreate.name,
          mcpEndpoint,
          "valid",
          checkDefinitions.agentCreate.validMessage,
        );

        activeCheckIndex = 4;
        const startInput = {
          agentId: createdAgent.id,
          expectedRevision: createdAgent.revision,
          idempotencyKey: `smoke-run-${suffix}`,
          prompt: "Reply with a brief acknowledgment that this bounded smoke run completed.",
        };
        let startedRun: Run | undefined;
        let started: z.infer<typeof startRunResultSchema> | undefined;

        try {
          started = await callTool(
            session,
            "crewhelm_start_run",
            startInput,
            startRunResultSchema,
            "Agent run start returned an invalid payload.",
          );
        } catch {
          const recovered = await callTool(
            session,
            "crewhelm_start_run",
            startInput,
            startRunResultSchema,
            "Agent run start could not be reconciled after an ambiguous response.",
          );

          startedRun = validateStartedRun(recovered, createdAgent);
        }

        if (started) {
          startedRun = validateStartedRun(started, createdAgent, true);
        }

        if (!startedRun) {
          throw new TemporaryOwnerSessionError(
            "request_failed",
            "Disposable Agent run start did not complete.",
          );
        }

        runId = startedRun.runId;
        const deadline = now() + options.runTimeoutMs;

        for (;;) {
          const inspected = await callTool(
            session,
            "crewhelm_inspect_run",
            { runId: startedRun.runId },
            inspectRunResultSchema,
            "Agent run inspection returned an invalid payload.",
          );

          if (
            !inspected.ok ||
            inspected.run.runId !== startedRun.runId ||
            inspected.run.agentId !== createdAgent.id ||
            inspected.run.agentRevision !== createdAgent.revision
          ) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Agent run inspection did not match the disposable fixture.",
            );
          }

          if (isTerminalRunStatus(inspected.run.status)) {
            runStatus = inspected.run.status;

            if (inspected.run.status !== "completed") {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Disposable Agent run did not complete successfully.",
              );
            }

            checks[4] = createCheck(
              checkDefinitions.runTerminal.name,
              mcpEndpoint,
              "valid",
              checkDefinitions.runTerminal.validMessage,
            );
            break;
          }

          if (now() >= deadline) {
            throw new TemporaryOwnerSessionError(
              "timeout",
              "Disposable Agent run did not reach a terminal state in time.",
            );
          }

          await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        }
      } catch (error) {
        checks[activeCheckIndex] = failedCheck(checks[activeCheckIndex]!.name, mcpEndpoint, error);
      } finally {
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
    checks[6] = createCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      "valid",
      checkDefinitions.oauthTokenRevocation.validMessage,
    );
  } else if (sessionResult.revocation.status === "failed") {
    checks[6] = failedCheck(
      checkDefinitions.oauthTokenRevocation.name,
      revokeEndpoint,
      sessionResult.revocation.error,
    );
  }

  return agentSmokeReportSchema.parse({
    schemaVersion: 1,
    ok: publicReport.ok && checks.every((check) => check.status === "pass"),
    public: publicReport,
    ...(agentId === undefined ? {} : { agentId }),
    ...(runId === undefined ? {} : { runId }),
    ...(runStatus === undefined ? {} : { runStatus }),
    ...(activeAgentsBefore === undefined ? {} : { activeAgentsBefore }),
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    checks,
  });
}
