import { randomBytes } from "node:crypto";

import {
  SANDBOX_CODE_CAPABILITY_ID,
  SANDBOX_CODE_CAPABILITY_SCHEMA_VERSION,
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  batchDisableAgentsResultSchema,
  cancelRunResultSchema,
  createAgentResultSchema,
  getAgentCapabilityCatalogResultSchema,
  getAgentResultSchema,
  inspectRunResultSchema,
  listAgentRunsResultSchema,
  listAgentsResultSchema,
  startRunResultSchema,
  type Agent,
  type InspectRunResult,
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
const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"] as const;
const REQUIRED_TOOLS = [
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
] as const;
const SMOKE_MODEL = "@cf/zai-org/glm-4.7-flash";

const sandboxSmokeCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  message: z.string().max(512),
  name: z.enum([
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "sandbox-capability",
    "agent-create",
    "code-execution",
    "network-denial",
    "compact-discovery",
    "agent-disable",
    "access-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const sandboxSmokeReportSchema = z.strictObject({
  activeAgentsAfter: z.number().int().nonnegative().optional(),
  activeAgentsBefore: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  checks: z.array(sandboxSmokeCheckSchema).length(10),
  codeRunId: z.string().optional(),
  networkRunId: z.string().optional(),
  ok: z.boolean(),
  public: doctorReportSchema,
  schemaVersion: z.literal(1),
});

export type SandboxSmokeReport = z.infer<typeof sandboxSmokeReportSchema>;
type CheckName = SandboxSmokeReport["checks"][number]["name"];

export interface SandboxSmokeOptions extends DoctorOptions {
  credential: RefreshableOwnerCredential;
  persistCredential: (credential: RefreshableOwnerCredential) => Promise<void>;
  runTimeoutMs: number;
}

export interface SandboxSmokeDependencies {
  expectedDeploymentFingerprint?: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface SandboxRunInspectionOptions extends DoctorOptions {
  credential: RefreshableOwnerCredential;
  persistCredential: (credential: RefreshableOwnerCredential) => Promise<void>;
  runId: string;
}

function check(
  name: CheckName,
  code: SandboxSmokeReport["checks"][number]["code"],
  message: string,
) {
  return sandboxSmokeCheckSchema.parse({
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
  return error instanceof TemporaryOwnerSessionError
    ? check(name, error.code, error.message)
    : check(name, "request_failed", "Sandbox rehearsal check failed.");
}

async function callTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
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

function hasToolTimeline(result: InspectRunResult, terminalEvent: string): boolean {
  return (
    result.ok &&
    ["tool.execution_reserved", "tool.execution_dispatched", terminalEvent].every((event) =>
      result.timeline.some((item) => item.event === event),
    )
  );
}

export function observedNetworkDenial(output: string): boolean {
  return (
    !output.includes("NETWORK_UNEXPECTED_CONNECTED") &&
    /(?:^|\s)NETWORK_BLOCKED (?:ConnectionRefusedError|OSError|PermissionError|TimeoutError)(?:\s|$)/u.test(
      output,
    )
  );
}

async function inspectTerminalRun(
  session: TemporaryOwnerMcpSession,
  runId: string,
  deadline: number,
  now: () => number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<InspectRunResult> {
  while (true) {
    const inspected = await callTool(
      session,
      "crewhelm_inspect_run",
      { runId, timelineLimit: 50 },
      inspectRunResultSchema,
      "Sandbox Run inspection returned an invalid payload.",
    );
    if (!inspected.ok) {
      throw new TemporaryOwnerSessionError("invalid_payload", "Sandbox Run was unavailable.");
    }
    if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(inspected.run.status)) {
      return inspected;
    }
    if (now() >= deadline) {
      throw new TemporaryOwnerSessionError("timeout", "Sandbox Run did not finish in time.");
    }
    await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - now())));
  }
}

async function startRunWithRecovery(
  session: TemporaryOwnerMcpSession,
  input: { agentId: string; expectedRevision: number; idempotencyKey: string; prompt: string },
  knownRunIds: ReadonlySet<string>,
): Promise<z.infer<typeof startRunResultSchema>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let started: z.infer<typeof startRunResultSchema>;
    try {
      started = await callTool(
        session,
        "crewhelm_start_run",
        input,
        startRunResultSchema,
        attempt === 0
          ? "Sandbox Run start returned an invalid payload."
          : "Sandbox Run start replay returned an invalid payload.",
      );
    } catch {
      continue;
    }
    if (!started.ok || started.run.agentId !== input.agentId) {
      throw new TemporaryOwnerSessionError("invalid_payload", "Sandbox Run was denied.");
    }
    return started;
  }

  const listed = await callTool(
    session,
    "crewhelm_list_agent_runs",
    { agentId: input.agentId, limit: 10 },
    listAgentRunsResultSchema,
    "Sandbox Run recovery discovery returned an invalid payload.",
  );
  const candidates = listed.ok
    ? listed.runs.filter((candidate) => !knownRunIds.has(candidate.runId))
    : [];
  if (candidates.length !== 1) {
    throw new TemporaryOwnerSessionError("request_failed", "Sandbox Run start was not recovered.");
  }
  const inspected = await callTool(
    session,
    "crewhelm_inspect_run",
    { runId: candidates[0]!.runId, timelineLimit: 1 },
    inspectRunResultSchema,
    "Sandbox Run recovery inspection returned an invalid payload.",
  );
  if (!inspected.ok || inspected.run.agentId !== input.agentId) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Sandbox Run recovery did not match the disposable Agent.",
    );
  }
  return startRunResultSchema.parse({ created: false, ok: true, run: inspected.run });
}

export async function runSandboxSmoke(
  options: SandboxSmokeOptions,
  dependencies: SandboxSmokeDependencies,
): Promise<SandboxSmokeReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const names: CheckName[] = [
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "sandbox-capability",
    "agent-create",
    "code-execution",
    "network-denial",
    "compact-discovery",
    "agent-disable",
    "access-token-revocation",
  ];
  const checks = names.map(skipped);

  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return sandboxSmokeReportSchema.parse({
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
  let activeCheck = 1;
  let agent: Agent | undefined;
  let codeRunId: string | undefined;
  let networkRunId: string | undefined;
  const knownRunIds = new Set<string>();

  const cleanup = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    activeCheck = 8;
    if (!agent) return;
    const cleanupAgentId = agent.id;
    let runCleanupError: unknown;

    try {
      try {
        const listed = await callTool(
          session,
          "crewhelm_list_agent_runs",
          { agentId: agent.id, limit: 10 },
          listAgentRunsResultSchema,
          "Sandbox Run cleanup discovery returned an invalid payload.",
        );
        if (listed.ok) {
          if (listed.runs.some((run) => run.agentId !== cleanupAgentId)) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Sandbox Run cleanup discovery crossed the disposable Agent boundary.",
            );
          }
          for (const run of listed.runs) knownRunIds.add(run.runId);
        }
      } catch (error) {
        if (error instanceof TemporaryOwnerSessionError && error.code === "invalid_payload") {
          throw error;
        }
        // Exact known Run IDs are still reconciled below.
      }

      const cleanupDeadline = now() + Math.min(options.runTimeoutMs, 60_000);
      for (const runId of knownRunIds) {
        while (true) {
          const inspected = await callTool(
            session,
            "crewhelm_inspect_run",
            { runId, timelineLimit: 1 },
            inspectRunResultSchema,
            "Sandbox Run cleanup inspection returned an invalid payload.",
          );
          if (
            !inspected.ok ||
            inspected.run.runId !== runId ||
            inspected.run.agentId !== agent.id
          ) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Sandbox Run cleanup did not match the exact fixture.",
            );
          }
          if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(inspected.run.status)) break;
          if (now() >= cleanupDeadline) {
            throw new TemporaryOwnerSessionError(
              "timeout",
              "Sandbox Run cleanup did not reach a terminal state in time.",
            );
          }
          try {
            const cancelled = await callTool(
              session,
              "crewhelm_cancel_run",
              { runId },
              cancelRunResultSchema,
              "Sandbox Run cleanup cancellation returned an invalid payload.",
            );
            if (
              !cancelled.ok &&
              cancelled.error.code !== "run_not_cancellable" &&
              cancelled.error.code !== "run_unavailable"
            ) {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Sandbox Run cleanup cancellation was denied.",
              );
            }
          } catch {
            // A lost response or an in-flight local tool is reconciled by exact inspection.
          }
          await wait(Math.min(POLL_INTERVAL_MS, Math.max(1, cleanupDeadline - now())));
        }
      }
    } catch (error) {
      runCleanupError = error;
    }

    try {
      let exact = await callTool(
        session,
        "crewhelm_get_agent",
        { id: agent.id },
        getAgentResultSchema,
        "Sandbox Agent cleanup inspection returned an invalid payload.",
      );
      if (!exact.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Sandbox Agent was not found.");
      }
      for (let attempt = 0; exact.agent.status === "active" && attempt < 2; attempt += 1) {
        let disabled: z.infer<typeof batchDisableAgentsResultSchema> | undefined;
        try {
          disabled = await callTool(
            session,
            "crewhelm_batch_disable_agents",
            { agents: [{ agentId: exact.agent.id, expectedRevision: exact.agent.revision }] },
            batchDisableAgentsResultSchema,
            "Agent disablement returned an invalid payload.",
          );
        } catch {
          // A lost response is reconciled by exact Agent inspection below.
        }
        const receipt = disabled?.ok ? disabled.receipts[0] : undefined;
        if (
          disabled?.ok &&
          (disabled.receipts.length !== 1 ||
            receipt === undefined ||
            receipt.agentId !== exact.agent.id ||
            receipt.expectedRevision !== exact.agent.revision ||
            !["disabled", "already_disabled", "revision_conflict"].includes(receipt.outcome))
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Agent cleanup receipt did not match the exact fixture.",
          );
        }
        exact = await callTool(
          session,
          "crewhelm_get_agent",
          { id: agent.id },
          getAgentResultSchema,
          "Sandbox Agent cleanup reinspection returned an invalid payload.",
        );
        if (!exact.ok) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Sandbox Agent cleanup reinspection failed.",
          );
        }
      }
      if (exact.agent.status !== "disabled") {
        throw new TemporaryOwnerSessionError("invalid_payload", "Agent cleanup was not verified.");
      }
      activeAgentsAfter = (await readStatus(session)).usage.agents.active;
      if (activeAgentsAfter !== activeAgentsBefore) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Agent cleanup did not restore capacity.",
        );
      }
      if (runCleanupError !== undefined) throw runCleanupError;
      checks[8] = check(
        "agent-disable",
        "valid",
        "Disposable Sandbox Runs reached terminal state; the Agent was disabled and capacity restored.",
      );
    } catch (error) {
      checks[8] = failure("agent-disable", error);
    }
  };

  const sessionResult = await runRefreshableOwnerSession(options, dependencies, async (session) => {
    await session.call(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "crewhelm-sandbox-rehearsal", version: CREWHELM_CLI_VERSION },
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
        "MCP catalog omitted a Sandbox rehearsal tool.",
      );
    }
    checks[2] = check("mcp-tool-catalog", "valid", "MCP exposed the bounded Run lifecycle tools.");

    activeCheck = 3;
    const capability = await callTool(
      session,
      "crewhelm_get_config",
      { target: { id: SANDBOX_CODE_CAPABILITY_ID, kind: "agent-capability" } },
      getAgentCapabilityCatalogResultSchema,
      "Sandbox capability catalog returned an invalid payload.",
    );
    if (
      !capability.ok ||
      capability.capabilities.length !== 1 ||
      capability.capabilities[0]?.id !== SANDBOX_CODE_CAPABILITY_ID ||
      capability.capabilities[0].availability.state !== "available"
    ) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Sandbox capability was not available on the test installation.",
      );
    }
    checks[3] = check(
      "sandbox-capability",
      "valid",
      "Sandbox code was discoverable as an available Agent capability.",
    );

    activeCheck = 4;
    activeAgentsBefore = (await readStatus(session)).usage.agents.active;
    const createInput = {
      capabilities: [
        {
          configuration: { fallbackModels: [], primaryModel: SMOKE_MODEL },
          id: WORKERS_AI_CAPABILITY_ID,
          schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
        },
        {
          configuration: {
            languages: ["python"],
            maxCodeBytes: 4_096,
            maxDurationMs: 10_000,
            maxOutputBytes: 16_384,
          },
          id: SANDBOX_CODE_CAPABILITY_ID,
          schemaVersion: SANDBOX_CODE_CAPABILITY_SCHEMA_VERSION,
        },
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
      executionLimits: {
        maxDurationSeconds: 60,
        maxModelTokens: 1_024,
        maxToolCalls: 1,
        maxTurns: 2,
      },
      idempotencyKey: `sandbox-smoke-agent-${suffix}`,
      instructions:
        "For every request, call sandbox_run_code exactly once with the requested Python code. Never simulate its output. Then answer concisely with the exact printed marker.",
      name: `Crewhelm Sandbox smoke ${suffix}`,
    };
    let created: z.infer<typeof createAgentResultSchema> | undefined;
    try {
      created = await callTool(
        session,
        "crewhelm_create_agent",
        createInput,
        createAgentResultSchema,
        "Sandbox Agent creation returned an invalid payload.",
      );
    } catch {
      try {
        created = await callTool(
          session,
          "crewhelm_create_agent",
          createInput,
          createAgentResultSchema,
          "Sandbox Agent creation replay returned an invalid payload.",
        );
      } catch {
        const listed = await callTool(
          session,
          "crewhelm_list_agents",
          { limit: 2, name: createInput.name, status: "active" },
          listAgentsResultSchema,
          "Sandbox Agent recovery returned an invalid payload.",
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
            "Sandbox Agent recovery inspection returned an invalid payload.",
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
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Disposable Sandbox Agent was not created.",
      );
    }
    agent = created.agent;
    checks[4] = check("agent-create", "valid", "A disposable no-egress Sandbox Agent was created.");

    try {
      activeCheck = 5;
      const codeRun = await startRunWithRecovery(
        session,
        {
          agentId: agent.id,
          expectedRevision: agent.revision,
          idempotencyKey: `sandbox-smoke-code-${suffix}`,
          prompt:
            "Call sandbox_run_code with Python code `print(123456 * 789)`. Return SANDBOX_MATH followed by the exact printed number.",
        },
        knownRunIds,
      );
      if (!codeRun.ok) throw new Error("Recovered Sandbox code Run was unexpectedly denied.");
      codeRunId = codeRun.run.runId;
      knownRunIds.add(codeRunId);
      const codeResult = await inspectTerminalRun(
        session,
        codeRunId,
        now() + options.runTimeoutMs,
        now,
        wait,
      );
      if (
        !codeResult.ok ||
        codeResult.run.status !== "completed" ||
        !codeResult.run.output?.includes("97406784") ||
        !hasToolTimeline(codeResult, "tool.execution_completed") ||
        codeResult.usage?.toolCalls.used !== 1
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Sandbox code output or execution evidence was not verified.",
        );
      }
      checks[5] = check(
        "code-execution",
        "valid",
        "Python executed through the admitted native tool and returned 97406784.",
      );

      activeCheck = 6;
      const networkRun = await startRunWithRecovery(
        session,
        {
          agentId: agent.id,
          expectedRevision: agent.revision,
          idempotencyKey: `sandbox-smoke-network-${suffix}`,
          prompt:
            "Call sandbox_run_code with this Python code exactly: `import socket\ns = socket.socket()\ns.settimeout(2)\ntry:\n s.connect(('1.1.1.1', 443))\n print('NETWORK_UNEXPECTED_CONNECTED')\nexcept OSError as error:\n print('NETWORK_BLOCKED', type(error).__name__)\nfinally:\n s.close()`. Return only the printed marker and diagnostic class.",
        },
        knownRunIds,
      );
      if (!networkRun.ok) throw new Error("Recovered Sandbox network Run was unexpectedly denied.");
      networkRunId = networkRun.run.runId;
      knownRunIds.add(networkRunId);
      const networkResult = await inspectTerminalRun(
        session,
        networkRunId,
        now() + options.runTimeoutMs,
        now,
        wait,
      );
      if (
        !networkResult.ok ||
        networkResult.run.status !== "completed" ||
        !networkResult.run.output ||
        !observedNetworkDenial(networkResult.run.output) ||
        !hasToolTimeline(networkResult, "tool.execution_completed") ||
        networkResult.usage?.toolCalls.used !== 1
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Sandbox network denial or execution evidence was not verified.",
        );
      }
      checks[6] = check(
        "network-denial",
        "valid",
        "The live Sandbox observed an outbound TCP denial and returned its exception class.",
      );

      activeCheck = 7;
      const listedRuns = await callTool(
        session,
        "crewhelm_list_agent_runs",
        { agentId: agent.id, limit: 10 },
        listAgentRunsResultSchema,
        "Sandbox Run discovery returned an invalid payload.",
      );
      if (
        !listedRuns.ok ||
        ![codeRunId, networkRunId].every((runId) =>
          listedRuns.runs.some((run) => run.runId === runId),
        ) ||
        JSON.stringify(listedRuns).includes("97406784") ||
        JSON.stringify(listedRuns).includes("NETWORK_BLOCKED")
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Compact Run discovery omitted fixtures or exposed detailed output.",
        );
      }
      checks[7] = check(
        "compact-discovery",
        "valid",
        "Run listing exposed compact identities without detailed Sandbox output.",
      );
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
  checks[9] =
    sessionResult.revocation.status === "revoked"
      ? check("access-token-revocation", "valid", "The short-lived access token was revoked.")
      : sessionResult.revocation.status === "failed"
        ? failure("access-token-revocation", sessionResult.revocation.error)
        : skipped("access-token-revocation");

  return sandboxSmokeReportSchema.parse({
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    ...(activeAgentsBefore === undefined ? {} : { activeAgentsBefore }),
    ...(agent === undefined ? {} : { agentId: agent.id }),
    checks,
    ...(codeRunId === undefined ? {} : { codeRunId }),
    ...(networkRunId === undefined ? {} : { networkRunId }),
    ok: publicReport.ok && checks.every((item) => item.status === "pass"),
    public: publicReport,
    schemaVersion: 1,
  });
}

export async function inspectSandboxRun(
  options: SandboxRunInspectionOptions,
  dependencies: SandboxSmokeDependencies,
): Promise<unknown> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const sessionResult = await runRefreshableOwnerSession(options, dependencies, async (session) => {
    await session.call(
      "initialize",
      {
        capabilities: {},
        clientInfo: { name: "crewhelm-sandbox-inspection", version: CREWHELM_CLI_VERSION },
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
      initializeResponseSchema,
    );
    const inspected = await callTool(
      session,
      "crewhelm_inspect_run",
      { runId: options.runId, timelineLimit: 50 },
      inspectRunResultSchema,
      "Sandbox Run inspection returned an invalid payload.",
    );
    if (!inspected.ok || inspected.run.runId !== options.runId) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Sandbox Run inspection did not match the exact fixture.",
      );
    }
    const output = inspected.run.output ?? "";
    return {
      diagnosis:
        inspected.diagnosis === null
          ? null
          : {
              certainty: inspected.diagnosis.certainty,
              disposition: inspected.diagnosis.disposition,
              nextAction: inspected.diagnosis.nextAction,
              phase: inspected.diagnosis.phase,
              reason: inspected.diagnosis.reason,
            },
      markers: {
        math: output.includes("97406784"),
        networkBlocked: output.includes("NETWORK_BLOCKED"),
        networkUnexpected: output.includes("NETWORK_UNEXPECTED"),
      },
      outputCharacters: output.length,
      runId: inspected.run.runId,
      status: inspected.run.status,
      timeline: inspected.timeline.map((event) => event.event),
      toolCalls: inspected.usage?.toolCalls ?? null,
    };
  });

  return {
    authorization: sessionResult.authorization,
    ok:
      sessionResult.authorization.ok &&
      sessionResult.operation.status === "completed" &&
      sessionResult.revocation.status === "revoked",
    operation:
      sessionResult.operation.status === "completed"
        ? { evidence: sessionResult.operation.value, status: "completed" }
        : sessionResult.operation,
    public: publicReport,
    revocation: sessionResult.revocation,
    schemaVersion: 1,
  };
}
