import { randomBytes } from "node:crypto";

import {
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  batchDisableAgentsResultSchema,
  createAgentResultSchema,
  getAgentResultSchema,
  listAgentsResultSchema,
  manageAgentWorkflowsResultSchema,
  type Agent,
  type AgentWorkflowSummary,
} from "@crewhelm/contracts";
import * as z from "zod";

import { diagnoseDeployment, doctorReportSchema, type DoctorOptions } from "./doctor.js";
import { mcpControlPlaneStatusResultSchema } from "./mcp-result-schemas.js";
import {
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseMcpToolResult,
  runRefreshableOwnerSession,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolCallResponseSchema,
  toolListResponseSchema,
  type RefreshableOwnerCredential,
  type TemporaryOwnerMcpSession,
} from "./temporary-owner-session.js";
import { CREWHELM_CLI_VERSION } from "./version.js";

const POLL_INTERVAL_MS = 5_000;
const TERMINAL_WORKFLOW_STATUSES = ["cancelled", "completed", "failed"] as const;
type TerminalWorkflowStatus = (typeof TERMINAL_WORKFLOW_STATUSES)[number];
const REQUIRED_TOOLS = [
  "crewhelm_agent_workflows",
  "crewhelm_batch_disable_agents",
  "crewhelm_create_agent",
  "crewhelm_get_agent",
  "crewhelm_list_agents",
  "crewhelm_status",
] as const;
const AGENT_LIMITS = {
  maxDurationSeconds: 90,
  maxModelTokens: 1_024,
  maxToolCalls: 0,
  maxTurns: 2,
} as const;
const SMOKE_MODEL = "@cf/zai-org/glm-4.7-flash" as const;

const workflowSmokeCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  message: z.string().max(512),
  name: z.enum([
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "agent-create",
    "workflow-start-replay",
    "stale-revision-denial",
    "compact-discovery",
    "workflow-terminal",
    "workflow-delete",
    "agent-disable",
    "access-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const workflowSmokeReportSchema = z.strictObject({
  activeAgentsAfter: z.number().int().nonnegative().optional(),
  activeAgentsBefore: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  checks: z.array(workflowSmokeCheckSchema).length(11),
  ok: z.boolean(),
  public: doctorReportSchema,
  schemaVersion: z.literal(1),
  workflowId: z.string().optional(),
  workflowStatus: z.enum(TERMINAL_WORKFLOW_STATUSES).optional(),
});

export type WorkflowSmokeReport = z.infer<typeof workflowSmokeReportSchema>;

export interface WorkflowSmokeOptions extends DoctorOptions {
  credential: RefreshableOwnerCredential;
  persistCredential: (credential: RefreshableOwnerCredential) => Promise<void>;
  runTimeoutMs: number;
}

export interface WorkflowSmokeDependencies {
  expectedDeploymentFingerprint?: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface WorkflowSmokeRecoveryOptions extends DoctorOptions {
  agentId: string;
  credential: RefreshableOwnerCredential;
  persistCredential: (credential: RefreshableOwnerCredential) => Promise<void>;
  runTimeoutMs: number;
  workflowId: string;
}

const workflowSmokeRecoveryReportSchema = z.strictObject({
  activeAgentsAfter: z.number().int().nonnegative().optional(),
  agentDisabled: z.boolean(),
  authorization: z.union([
    z.strictObject({ ok: z.literal(true) }),
    z.strictObject({
      error: z.strictObject({
        code: temporaryOwnerSessionErrorCodeSchema,
        message: z.string().max(512),
      }),
      ok: z.literal(false),
    }),
  ]),
  lastWorkflowStatus: z
    .enum(["cancelling", "cancelled", "completed", "failed", "pending", "running"])
    .optional(),
  ok: z.boolean(),
  operation: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("completed") }),
    z.strictObject({
      error: z.strictObject({
        code: temporaryOwnerSessionErrorCodeSchema,
        message: z.string().max(512),
      }),
      status: z.literal("failed"),
    }),
    z.strictObject({ status: z.literal("not_run") }),
  ]),
  public: doctorReportSchema,
  revocation: z.union([
    z.strictObject({ ok: z.literal(true), status: z.literal("revoked") }),
    z.strictObject({
      error: z.strictObject({
        code: temporaryOwnerSessionErrorCodeSchema,
        message: z.string().max(512),
      }),
      ok: z.literal(false),
      status: z.literal("failed"),
    }),
    z.strictObject({ status: z.literal("not_issued") }),
  ]),
  schemaVersion: z.literal(1),
  workflowDeleted: z.boolean(),
});

export type WorkflowSmokeRecoveryReport = z.infer<typeof workflowSmokeRecoveryReportSchema>;

type CheckName = WorkflowSmokeReport["checks"][number]["name"];

function check(
  name: CheckName,
  code: WorkflowSmokeReport["checks"][number]["code"],
  message: string,
) {
  return workflowSmokeCheckSchema.parse({
    code,
    message,
    name,
    status: code === "valid" ? "pass" : code === "not_run" ? "skip" : "fail",
  });
}

function skipped(name: CheckName) {
  return check(name, "not_run", "Check was not run.");
}

function failure(name: CheckName, error: unknown) {
  if (error instanceof TemporaryOwnerSessionError) {
    return check(name, error.code, error.message);
  }
  return check(name, "request_failed", "Workflow rehearsal check failed.");
}

async function callTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
  allowDeniedResult = false,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: arguments_, name },
    toolCallResponseSchema,
  );
  if (!allowDeniedResult) {
    return parseMcpToolResult(response, schema, invalidMessage);
  }

  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new TemporaryOwnerSessionError("invalid_payload", invalidMessage);
  }
  return parsed.data;
}

async function readStatus(session: TemporaryOwnerMcpSession) {
  const result = await callTool(
    session,
    "crewhelm_status",
    {},
    mcpControlPlaneStatusResultSchema,
    "Fleet status returned an invalid payload.",
  );

  if (!result.ok) {
    throw new TemporaryOwnerSessionError("invalid_payload", "Fleet status request was denied.");
  }
  return result.status;
}

function fixtureSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString("base64url")}`;
}

function workflowDeletionIdempotencyKey(workflowId: string): string {
  return `smoke-delete-${workflowId.slice("workflow_".length)}`;
}

function isTerminalWorkflowStatus(
  status: AgentWorkflowSummary["status"],
): status is TerminalWorkflowStatus {
  return (TERMINAL_WORKFLOW_STATUSES as readonly string[]).includes(status);
}

function exactWorkflow(
  result: z.infer<typeof manageAgentWorkflowsResultSchema>,
  workflowId?: string,
): AgentWorkflowSummary {
  if (
    !("workflow" in result) ||
    !result.ok ||
    (workflowId && result.workflow.workflowId !== workflowId)
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Workflow response did not match the disposable fixture.",
    );
  }
  return result.workflow;
}

export async function runWorkflowSmoke(
  options: WorkflowSmokeOptions,
  dependencies: WorkflowSmokeDependencies,
): Promise<WorkflowSmokeReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const names: CheckName[] = [
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "agent-create",
    "workflow-start-replay",
    "stale-revision-denial",
    "compact-discovery",
    "workflow-terminal",
    "workflow-delete",
    "agent-disable",
    "access-token-revocation",
  ];
  const checks = names.map(skipped);

  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return workflowSmokeReportSchema.parse({
      checks,
      ok: false,
      public: publicReport,
      schemaVersion: 1,
    });
  }

  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const suffix = fixtureSuffix();
  let activeAgentsBefore: number | undefined;
  let activeAgentsAfter: number | undefined;
  let agent: Agent | undefined;
  let workflow: AgentWorkflowSummary | undefined;
  let workflowStatus: "cancelled" | "completed" | "failed" | undefined;
  let activeCheck = 1;

  const cleanup = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    if (!workflow && agent) {
      try {
        const listed = await callTool(
          session,
          "crewhelm_agent_workflows",
          { action: "list", agentId: agent.id, limit: 2 },
          manageAgentWorkflowsResultSchema,
          "Workflow cleanup discovery returned an invalid payload.",
        );
        if (listed.ok && "workflows" in listed && listed.workflows.length === 1) {
          workflow = listed.workflows[0];
        }
      } catch {
        // The exact Agent cleanup below still releases capacity when no Workflow can be recovered.
      }
    }

    if (workflow) {
      activeCheck = 8;
      try {
        let current = workflow;

        const cleanupDeadline = now() + Math.min(options.runTimeoutMs, 60_000);

        while (!isTerminalWorkflowStatus(current.status)) {
          if (now() >= cleanupDeadline) {
            throw new TemporaryOwnerSessionError(
              "timeout",
              "Workflow cleanup did not reach a terminal state in time.",
            );
          }
          const inspected = await callTool(
            session,
            "crewhelm_agent_workflows",
            { action: "inspect", workflowId: current.workflowId },
            manageAgentWorkflowsResultSchema,
            "Workflow cleanup inspection returned an invalid payload.",
          );
          current = exactWorkflow(inspected, current.workflowId);
          if (isTerminalWorkflowStatus(current.status)) break;

          let cancelled: z.infer<typeof manageAgentWorkflowsResultSchema>;
          try {
            cancelled = await callTool(
              session,
              "crewhelm_agent_workflows",
              {
                action: "cancel",
                expectedRevision: current.revision,
                workflowId: current.workflowId,
              },
              manageAgentWorkflowsResultSchema,
              "Workflow cleanup cancellation returned an invalid payload.",
              true,
            );
          } catch {
            // Cancellation may have committed before a lost response. Re-inspect exact state.
            continue;
          }
          if (!cancelled.ok) {
            if (cancelled.error.code === "revision_conflict") continue;
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Workflow cleanup cancellation was denied.",
            );
          }
          current = exactWorkflow(cancelled, current.workflowId);
          if (!isTerminalWorkflowStatus(current.status)) {
            await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, cleanupDeadline - now())));
          }
        }

        if (isTerminalWorkflowStatus(current.status)) {
          const deleted = await callTool(
            session,
            "crewhelm_agent_workflows",
            {
              action: "delete",
              expectedRevision: current.revision,
              idempotencyKey: workflowDeletionIdempotencyKey(current.workflowId),
              workflowId: current.workflowId,
            },
            manageAgentWorkflowsResultSchema,
            "Workflow deletion returned an invalid payload.",
          );

          if (!deleted.ok || !("deleted" in deleted) || !deleted.deleted) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Workflow deletion was not verified.",
            );
          }
          checks[8] = check(
            "workflow-delete",
            "valid",
            "Terminal Workflow and its Session were deleted.",
          );
        }
      } catch (error) {
        checks[8] = failure("workflow-delete", error);
      }
    }

    activeCheck = 9;
    if (!agent) return;
    try {
      const disabled = await callTool(
        session,
        "crewhelm_batch_disable_agents",
        { agents: [{ agentId: agent.id, expectedRevision: agent.revision }] },
        batchDisableAgentsResultSchema,
        "Agent disablement returned an invalid payload.",
      );
      if (!disabled.ok || disabled.receipts.length !== 1) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Agent cleanup was not verified.");
      }
      activeAgentsAfter = (await readStatus(session)).usage.agents.active;
      if (activeAgentsAfter !== activeAgentsBefore) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Agent cleanup did not restore capacity.",
        );
      }
      checks[9] = check(
        "agent-disable",
        "valid",
        "Disposable Agent was disabled and capacity restored.",
      );
    } catch (error) {
      checks[9] = failure("agent-disable", error);
    }
  };

  const sessionResult = await runRefreshableOwnerSession(options, dependencies, async (session) => {
    await session.call(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "crewhelm-feature-rehearsal", version: CREWHELM_CLI_VERSION },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      initializeResponseSchema,
    );
    checks[1] = check("mcp-initialize", "valid", "Authenticated MCP initialization succeeded.");

    activeCheck = 2;
    const catalog = await session.call("tools/list", {}, toolListResponseSchema);
    const toolNames = new Set(catalog.result.tools.map((tool) => tool.name));
    if (!REQUIRED_TOOLS.every((name) => toolNames.has(name))) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "MCP catalog omitted a rehearsal tool.",
      );
    }
    checks[2] = check(
      "mcp-tool-catalog",
      "valid",
      "MCP exposed the bounded Workflow lifecycle tools.",
    );

    activeCheck = 3;
    activeAgentsBefore = (await readStatus(session)).usage.agents.active;
    const createInput = {
      capabilities: [
        {
          configuration: { fallbackModels: [], primaryModel: SMOKE_MODEL },
          id: WORKERS_AI_CAPABILITY_ID,
          schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
        },
      ],
      executionLimits: AGENT_LIMITS,
      idempotencyKey: `smoke-agent-${suffix}`,
      instructions: "Complete each admitted Workflow stage concisely without tools.",
      name: `Crewhelm Workflow smoke ${suffix}`,
    };
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
      try {
        created = await callTool(
          session,
          "crewhelm_create_agent",
          createInput,
          createAgentResultSchema,
          "Agent creation replay returned an invalid payload.",
        );
      } catch {
        const listed = await callTool(
          session,
          "crewhelm_list_agents",
          { limit: 2, name: createInput.name, status: "active" },
          listAgentsResultSchema,
          "Agent creation recovery returned an invalid payload.",
        );
        const recovered = listed.ok
          ? listed.agents.filter((candidate) => candidate.name === createInput.name)
          : [];
        if (recovered.length === 1) {
          const exact = await callTool(
            session,
            "crewhelm_get_agent",
            { id: recovered[0]!.id },
            getAgentResultSchema,
            "Agent creation recovery inspection returned an invalid payload.",
          );
          if (exact.ok) created = { agent: exact.agent, created: false, ok: true };
        }
      }
    }
    if (
      !created?.ok ||
      created.agent.name !== createInput.name ||
      created.agent.instructions !== createInput.instructions
    ) {
      throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was not created.");
    }
    agent = created.agent;
    checks[3] = check("agent-create", "valid", "A zero-grant Workflow Agent was created.");

    try {
      activeCheck = 4;
      const input = {
        action: "start",
        agentId: agent.id,
        expectedRevision: agent.revision,
        idempotencyKey: `smoke-workflow-${suffix}`,
        objective: "Produce one concise two-step rehearsal acknowledgment.",
        stages: [
          { name: "Observe", prompt: "State that the first bounded stage completed." },
          { name: "Conclude", prompt: "Use prior context and state that the rehearsal completed." },
        ],
      };
      try {
        const started = await callTool(
          session,
          "crewhelm_agent_workflows",
          input,
          manageAgentWorkflowsResultSchema,
          "Workflow start returned an invalid payload.",
        );
        workflow = exactWorkflow(started);
      } catch {
        try {
          const recovered = await callTool(
            session,
            "crewhelm_agent_workflows",
            input,
            manageAgentWorkflowsResultSchema,
            "Workflow start replay returned an invalid payload.",
          );
          workflow = exactWorkflow(recovered);
        } catch {
          const listed = await callTool(
            session,
            "crewhelm_agent_workflows",
            { action: "list", agentId: agent.id, limit: 2 },
            manageAgentWorkflowsResultSchema,
            "Workflow start recovery returned an invalid payload.",
          );
          if (listed.ok && "workflows" in listed && listed.workflows.length === 1) {
            workflow = listed.workflows[0];
          }
        }
      }
      if (!workflow) {
        throw new TemporaryOwnerSessionError("request_failed", "Workflow start was not recovered.");
      }
      const replayed = await callTool(
        session,
        "crewhelm_agent_workflows",
        input,
        manageAgentWorkflowsResultSchema,
        "Workflow replay returned an invalid payload.",
      );
      if (
        !("created" in replayed) ||
        replayed.created ||
        exactWorkflow(replayed).workflowId !== workflow.workflowId
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Workflow replay was not idempotent.",
        );
      }
      checks[4] = check(
        "workflow-start-replay",
        "valid",
        "Workflow start replay returned the exact identity.",
      );

      activeCheck = 5;
      const denied = await callTool(
        session,
        "crewhelm_agent_workflows",
        { ...input, expectedRevision: agent.revision + 1, idempotencyKey: `smoke-stale-${suffix}` },
        manageAgentWorkflowsResultSchema,
        "Stale Agent revision denial returned an invalid payload.",
        true,
      );
      if (denied.ok || denied.error.code !== "revision_conflict") {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Stale Agent revision was not denied.",
        );
      }
      checks[5] = check(
        "stale-revision-denial",
        "valid",
        "A stale Agent revision was denied deterministically.",
      );

      activeCheck = 6;
      const listed = await callTool(
        session,
        "crewhelm_agent_workflows",
        { action: "list", agentId: agent.id, limit: 2 },
        manageAgentWorkflowsResultSchema,
        "Workflow list returned an invalid payload.",
      );
      if (
        !listed.ok ||
        !("workflows" in listed) ||
        !listed.workflows.some((item) => item.workflowId === workflow?.workflowId)
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Compact Workflow discovery omitted the fixture.",
        );
      }
      const inspected = await callTool(
        session,
        "crewhelm_agent_workflows",
        { action: "inspect", workflowId: workflow.workflowId },
        manageAgentWorkflowsResultSchema,
        "Workflow inspection returned an invalid payload.",
      );
      if (JSON.stringify(inspected).includes(input.stages[0]!.prompt)) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Compact inspection returned frozen prompts.",
        );
      }
      workflow = exactWorkflow(inspected, workflow.workflowId);
      checks[6] = check(
        "compact-discovery",
        "valid",
        "List and default inspection stayed compact.",
      );

      activeCheck = 7;
      const deadline = now() + options.runTimeoutMs;
      while (!isTerminalWorkflowStatus(workflow.status)) {
        if (now() >= deadline) {
          throw new TemporaryOwnerSessionError(
            "timeout",
            "Workflow did not reach a terminal state in time.",
          );
        }
        await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        const polled = await callTool(
          session,
          "crewhelm_agent_workflows",
          { action: "inspect", workflowId: workflow.workflowId },
          manageAgentWorkflowsResultSchema,
          "Workflow polling returned an invalid payload.",
        );
        workflow = exactWorkflow(polled, workflow.workflowId);
      }
      workflowStatus = workflow.status;
      if (workflow.status !== "completed" || workflow.completedStages !== 2) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          `Workflow ended as ${workflow.status} after ${workflow.completedStages} of 2 stages.`,
        );
      }
      checks[7] = check("workflow-terminal", "valid", "Both Workflow stages completed durably.");
    } catch (error) {
      checks[activeCheck] = failure(checks[activeCheck]!.name, error);
    } finally {
      await cleanup(session);
    }
  });

  checks[0] = sessionResult.authorization.ok
    ? check("saved-owner-access", "valid", "Saved owner access refreshed and rotated.")
    : failure("saved-owner-access", sessionResult.authorization.error);
  if (sessionResult.operation.status === "failed") {
    checks[activeCheck] = failure(checks[activeCheck]!.name, sessionResult.operation.error);
  }
  checks[10] =
    sessionResult.revocation.status === "revoked"
      ? check("access-token-revocation", "valid", "The short-lived access token was revoked.")
      : sessionResult.revocation.status === "failed"
        ? failure("access-token-revocation", sessionResult.revocation.error)
        : skipped("access-token-revocation");

  return workflowSmokeReportSchema.parse({
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    ...(activeAgentsBefore === undefined ? {} : { activeAgentsBefore }),
    ...(agent === undefined ? {} : { agentId: agent.id }),
    checks,
    ok: publicReport.ok && checks.every((item) => item.status === "pass"),
    public: publicReport,
    schemaVersion: 1,
    ...(workflow === undefined ? {} : { workflowId: workflow.workflowId }),
    ...(workflowStatus === undefined ? {} : { workflowStatus }),
  });
}

export async function recoverWorkflowSmoke(
  options: WorkflowSmokeRecoveryOptions,
  dependencies: WorkflowSmokeDependencies,
): Promise<
  | WorkflowSmokeRecoveryReport
  | { ok: false; public: z.infer<typeof doctorReportSchema>; schemaVersion: 1 }
> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let workflowDeleted = false;
  let agentDisabled = false;
  let activeAgentsAfter: number | undefined;
  let lastWorkflowStatus: AgentWorkflowSummary["status"] | undefined;

  const sessionResult = await runRefreshableOwnerSession(options, dependencies, async (session) => {
    await session.call(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "crewhelm-feature-recovery", version: CREWHELM_CLI_VERSION },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      initializeResponseSchema,
    );
    const deadline = now() + options.runTimeoutMs;
    let inspected = await callTool(
      session,
      "crewhelm_agent_workflows",
      { action: "inspect", workflowId: options.workflowId },
      manageAgentWorkflowsResultSchema,
      "Workflow recovery inspection returned an invalid payload.",
      true,
    );
    let current: AgentWorkflowSummary | undefined;
    if (!inspected.ok) {
      if (inspected.error.code !== "workflow_not_found") {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Workflow recovery inspection was denied.",
        );
      }
      workflowDeleted = true;
    } else {
      current = exactWorkflow(inspected, options.workflowId);
      lastWorkflowStatus = current.status;
    }

    while (current !== undefined && !isTerminalWorkflowStatus(current.status)) {
      if (now() >= deadline) {
        throw new TemporaryOwnerSessionError(
          "timeout",
          "Workflow recovery did not reach a terminal state in time.",
        );
      }
      let cancelled: z.infer<typeof manageAgentWorkflowsResultSchema> | undefined;
      try {
        cancelled = await callTool(
          session,
          "crewhelm_agent_workflows",
          {
            action: "cancel",
            expectedRevision: current.revision,
            workflowId: current.workflowId,
          },
          manageAgentWorkflowsResultSchema,
          "Workflow recovery cancellation returned an invalid payload.",
          true,
        );
      } catch {
        // A lost cancellation response is reconciled by the exact inspection below.
      }
      if (cancelled !== undefined) {
        if (cancelled.ok) {
          current = exactWorkflow(cancelled, current.workflowId);
          lastWorkflowStatus = current.status;
        } else if (
          cancelled.error.code !== "revision_conflict" &&
          cancelled.error.code !== "workflow_busy"
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Workflow recovery cancellation was denied.",
          );
        }
      }
      if (!isTerminalWorkflowStatus(current.status)) {
        await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
        inspected = await callTool(
          session,
          "crewhelm_agent_workflows",
          { action: "inspect", workflowId: current.workflowId },
          manageAgentWorkflowsResultSchema,
          "Workflow recovery polling returned an invalid payload.",
        );
        current = exactWorkflow(inspected, current.workflowId);
        lastWorkflowStatus = current.status;
      }
    }

    if (current !== undefined) {
      const deletionInput = {
        action: "delete" as const,
        expectedRevision: current.revision,
        idempotencyKey: workflowDeletionIdempotencyKey(current.workflowId),
        workflowId: current.workflowId,
      };
      let deleted: z.infer<typeof manageAgentWorkflowsResultSchema> | undefined;
      try {
        deleted = await callTool(
          session,
          "crewhelm_agent_workflows",
          deletionInput,
          manageAgentWorkflowsResultSchema,
          "Workflow recovery deletion returned an invalid payload.",
          true,
        );
      } catch {
        // A lost deletion response is reconciled by an idempotent replay below.
      }
      deleted ??= await callTool(
        session,
        "crewhelm_agent_workflows",
        deletionInput,
        manageAgentWorkflowsResultSchema,
        "Workflow recovery deletion replay returned an invalid payload.",
        true,
      );
      if (!deleted.ok && deleted.error.code === "workflow_not_found") {
        workflowDeleted = true;
      } else if (deleted.ok && "deleted" in deleted && deleted.deleted) {
        workflowDeleted = true;
      } else {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          deleted.ok
            ? "Workflow recovery deletion was not verified."
            : `Workflow recovery deletion was denied (${deleted.error.code}).`,
        );
      }
    }

    let exactAgent = await callTool(
      session,
      "crewhelm_get_agent",
      { id: options.agentId },
      getAgentResultSchema,
      "Workflow recovery Agent inspection returned an invalid payload.",
    );
    if (!exactAgent.ok) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Workflow recovery Agent was not found.",
      );
    }
    if (exactAgent.agent.status === "active") {
      let disabled: z.infer<typeof batchDisableAgentsResultSchema> | undefined;
      try {
        disabled = await callTool(
          session,
          "crewhelm_batch_disable_agents",
          {
            agents: [{ agentId: exactAgent.agent.id, expectedRevision: exactAgent.agent.revision }],
          },
          batchDisableAgentsResultSchema,
          "Workflow recovery Agent disablement returned an invalid payload.",
        );
      } catch {
        // A lost response is reconciled through exact Agent inspection below.
      }
      exactAgent = await callTool(
        session,
        "crewhelm_get_agent",
        { id: options.agentId },
        getAgentResultSchema,
        "Workflow recovery Agent reinspection returned an invalid payload.",
      );
      const receipt = disabled?.ok ? disabled.receipts[0] : undefined;
      if (
        !exactAgent.ok ||
        exactAgent.agent.status !== "disabled" ||
        (receipt !== undefined &&
          receipt.outcome !== "disabled" &&
          receipt.outcome !== "already_disabled" &&
          receipt.outcome !== "revision_conflict")
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Workflow recovery Agent disablement was not verified.",
        );
      }
    }
    agentDisabled = true;
    activeAgentsAfter = (await readStatus(session)).usage.agents.active;
  });

  const operation =
    sessionResult.operation.status === "failed"
      ? { error: sessionResult.operation.error, status: "failed" as const }
      : { status: sessionResult.operation.status };
  return workflowSmokeRecoveryReportSchema.parse({
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    agentDisabled,
    authorization: sessionResult.authorization,
    ...(lastWorkflowStatus === undefined ? {} : { lastWorkflowStatus }),
    ok:
      publicReport.ok &&
      workflowDeleted &&
      agentDisabled &&
      sessionResult.operation.status === "completed" &&
      sessionResult.revocation.status === "revoked",
    operation,
    public: publicReport,
    revocation: sessionResult.revocation,
    schemaVersion: 1,
    workflowDeleted,
  });
}
