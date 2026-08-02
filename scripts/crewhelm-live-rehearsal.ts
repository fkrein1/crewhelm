#!/usr/bin/env -S pnpm exec tsx

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  agentWatchesResultSchema,
  batchDisableAgentsResultSchema,
  cancelRunResultSchema,
  configureAgentScheduleResultSchema,
  createAgentResultSchema,
  getAgentScheduleResultSchema,
  inspectRunResultSchema,
  listConnectionsResultSchema,
  listAgentSchedulesResultSchema,
  manageAgentSessionsResultSchema,
  manageAgentWorkflowsResultSchema,
  startRunResultSchema,
  type BatchDisableAgentsResult,
  type AgentWatchesResult,
  type ConfigureAgentScheduleResult,
  type CreateAgentResult,
  type GetAgentScheduleResult,
  type ListAgentSchedulesResult,
  type InspectRunResult,
  type ListConnectionsResult,
  type StartRunResult,
} from "../packages/contracts/src/index.js";

import { diagnoseDeployment } from "../apps/cli/src/doctor.js";
import { readInstallation } from "../apps/cli/src/installation.js";
import { openInCodexBrowser } from "../apps/cli/src/codex-browser.js";
import { openInDefaultBrowser } from "../apps/cli/src/interactive.js";
import {
  readRehearsalCredential,
  writeRehearsalCredential,
} from "../apps/cli/src/rehearsal/credential.js";
import {
  authorizeRefreshableOwnerCredential,
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseMcpToolResult,
  runRefreshableOwnerSession,
  TemporaryOwnerSessionError,
  toolCallResponseSchema,
  toolListResponseSchema,
  type TemporaryOwnerMcpSession,
} from "../apps/cli/src/temporary-owner-session.js";
import { CREWHELM_CLI_VERSION } from "../apps/cli/src/version.js";
import {
  inspectSandboxRun,
  runSandboxRehearsal,
} from "../apps/cli/src/rehearsal/journeys/sandbox.js";
import { runWebResearchRehearsal } from "../apps/cli/src/rehearsal/journeys/web-research.js";
import {
  recoverWorkflowRehearsal,
  runWorkflowRehearsal,
} from "../apps/cli/src/rehearsal/journeys/workflow.js";
import { callRehearsalTool, readRehearsalStatus } from "../apps/cli/src/rehearsal/mcp.js";

const DEFAULT_INSTALLATION = "crewhelm.testing.installation.json";
const DEFAULT_CREDENTIAL = ".crewhelm-rehearsal-credential.json";
const STANDARD_REHEARSAL_ORIGIN = "https://crewhelm-testing.fkrein.workers.dev";

interface RehearsalTarget {
  expectedDeploymentFingerprint: string;
  origin: URL;
}

type McpResultSchema<Result> = Parameters<typeof parseMcpToolResult<Result>>[1];

const SCHEDULE_REHEARSAL_TOOLS = [
  "crewhelm_batch_disable_agents",
  "crewhelm_configure_agent_schedule",
  "crewhelm_create_agent",
  "crewhelm_get_agent_schedule",
  "crewhelm_list_agent_schedules",
] as const;
const WATCH_REHEARSAL_TOOLS = [
  "crewhelm_agent_watches",
  "crewhelm_batch_disable_agents",
  "crewhelm_create_agent",
] as const;
const CONNECTED_WATCH_REHEARSAL_TOOLS = [
  "crewhelm_agent_watches",
  "crewhelm_batch_disable_agents",
  "crewhelm_create_agent",
  "crewhelm_list_connections",
] as const;
const CONVERSATION_REHEARSAL_TOOLS = [
  "crewhelm_agent_sessions",
  "crewhelm_batch_disable_agents",
  "crewhelm_cancel_run",
  "crewhelm_create_agent",
  "crewhelm_delete_agent_session",
  "crewhelm_inspect_run",
  "crewhelm_start_run",
  "crewhelm_status",
] as const;
const TYPED_OUTPUT_REHEARSAL_TOOLS = [
  "crewhelm_agent_workflows",
  "crewhelm_batch_disable_agents",
  "crewhelm_create_agent",
  "crewhelm_inspect_run",
  "crewhelm_start_run",
] as const;
const TYPED_OUTPUT_CONTRACT = {
  kind: "json",
  schema: {
    jsonSchema: {
      additionalProperties: false,
      properties: {
        confidence: { maximum: 1, minimum: 0, type: "number" },
        summary: { maxLength: 200, minLength: 1, type: "string" },
      },
      required: ["summary", "confidence"],
      type: "object",
    },
    name: "CrewhelmAssessment",
    version: "1",
  },
} as const;

function boundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`${name} is outside its allowed bounds.`);
  }
  return parsedValue;
}

export async function resolveRehearsalTarget(installationPath: string): Promise<RehearsalTarget> {
  const installation = await readInstallation(installationPath);
  if (!installation) throw new Error("Rehearsal installation metadata does not exist.");
  if (installation.workerName !== "crewhelm-testing") {
    throw new Error("Live rehearsal is pinned to the crewhelm-testing Worker.");
  }
  if (installation.origin !== STANDARD_REHEARSAL_ORIGIN) {
    throw new Error("Live rehearsal is pinned to the canonical crewhelm-testing origin.");
  }
  const release: unknown = JSON.parse(await readFile("apps/cli/dist/release.json", "utf8"));
  const workerFingerprint =
    typeof release === "object" && release !== null
      ? Reflect.get(release, "workerFingerprint")
      : undefined;
  if (typeof workerFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(workerFingerprint)) {
    throw new Error("Packaged Worker fingerprint is invalid.");
  }
  return {
    expectedDeploymentFingerprint: workerFingerprint,
    origin: new URL(installation.origin),
  };
}

async function authorize(options: {
  browser: "codex" | "system";
  credentialPath: string;
  installationPath: string;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: rehearsalTarget.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    throw new Error("Rehearsal deployment is not aligned to the packaged build.");
  }
  const openUrl =
    options.browser === "codex"
      ? (url: URL) => openInCodexBrowser(url, { writeError: (text) => process.stderr.write(text) })
      : openInDefaultBrowser;
  const result = await authorizeRefreshableOwnerCredential(
    {
      clientName: "Crewhelm combined authentication rehearsal",
      origin: rehearsalTarget.origin,
      persistCredential: (credential) =>
        writeRehearsalCredential(options.credentialPath, credential),
      scope: "crewhelm:full",
      timeoutMs: options.timeoutMs,
    },
    { fetch, openUrl },
    (session) =>
      session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      ),
  );

  return {
    authorization: result.authorization,
    credential: result.authorization.ok ? "saved" : "not_saved",
    initialization: result.operation.status,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
  };
}

async function workflow(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return runWorkflowRehearsal(
    {
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function sandbox(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return runSandboxRehearsal(
    {
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function webResearch(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return runWebResearchRehearsal(
    {
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function inspectSandbox(options: {
  credentialPath: string;
  installationPath: string;
  runId: string;
  timeoutMs: number;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return inspectSandboxRun(
    {
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runId: options.runId,
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function recover(options: {
  agentId: string;
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
  workflowId: string;
}): Promise<unknown> {
  const rehearsalTarget = await resolveRehearsalTarget(options.installationPath);
  const credential = await readRehearsalCredential(options.credentialPath);
  return recoverWorkflowRehearsal(
    {
      agentId: options.agentId,
      credential,
      origin: rehearsalTarget.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      runTimeoutMs: options.runTimeoutMs,
      timeoutMs: options.timeoutMs,
      workflowId: options.workflowId,
    },
    { expectedDeploymentFingerprint: rehearsalTarget.expectedDeploymentFingerprint, fetch },
  );
}

async function recoverConversation(options: {
  agentId: string;
  credentialPath: string;
  installationPath: string;
  sessionId: string;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const inspected = await callRehearsalTool(
        session,
        "crewhelm_agent_sessions",
        { action: "inspect", agentId: options.agentId, sessionId: options.sessionId },
        manageAgentSessionsResultSchema,
        "Exact conversation recovery returned an invalid payload.",
        { acceptErrorResult: true },
      );
      if (!inspected.ok) {
        if (inspected.error.code === "session_not_found") {
          return { alreadyDeleted: true, deleted: true };
        }
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Exact conversation recovery inspection was denied.",
        );
      }
      if (!("conversation" in inspected)) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Exact conversation recovery did not find the retained Session.",
        );
      }
      const deleted = await callTool(
        session,
        "crewhelm_delete_agent_session",
        {
          agentId: options.agentId,
          expectedBranchRevision: inspected.conversation.expectedRevision,
          idempotencyKey: `conversation-recover-${options.sessionId.slice("session_".length)}`,
          sessionId: options.sessionId,
        },
        manageAgentSessionsResultSchema,
      );
      if (!deleted.ok || !("deleted" in deleted) || !deleted.deleted) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Retained conversation Session deletion was not verified.",
        );
      }
      return { deleted: true };
    },
  );

  return {
    agentId: options.agentId,
    authorization: result.authorization,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
    sessionId: options.sessionId,
  };
}

async function callTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  input: unknown,
  schema: McpResultSchema<T>,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: input, name },
    toolCallResponseSchema,
  );

  return parseMcpToolResult(response, schema, `${name} returned an invalid rehearsal payload.`);
}

async function callDeniedTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  input: unknown,
  schema: McpResultSchema<T>,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: input, name },
    toolCallResponseSchema,
  );
  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      `${name} returned an invalid rehearsal denial.`,
    );
  }

  const parsed = schema.safeParse(payload);

  if (!response.result.isError || !parsed.success) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      `${name} returned an invalid rehearsal denial.`,
    );
  }

  return parsed.data;
}

async function callToolOutcome<T extends { ok: boolean }>(
  session: TemporaryOwnerMcpSession,
  name: string,
  input: unknown,
  schema: McpResultSchema<T>,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: input, name },
    toolCallResponseSchema,
  );
  const text = response.result.content.find((content) => content.text !== undefined)?.text;
  let payload: unknown;

  try {
    payload = JSON.parse(text ?? "");
  } catch {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      `${name} returned an invalid rehearsal outcome.`,
    );
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      `${name} returned an invalid rehearsal outcome.`,
    );
  }

  if (response.result.isError === parsed.data.ok) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      `${name} returned inconsistent rehearsal success metadata.`,
    );
  }

  return parsed.data;
}

function localTime(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).formatToParts(new Date(instant));
  const values = new Map(parts.map((part) => [part.type, part.value]));

  return `${values.get("hour")}:${values.get("minute")}`;
}

async function schedules(options: {
  credentialPath: string;
  installationPath: string;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );

  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const suffix = crypto.randomUUID().slice(0, 8);
  let agentId: string | undefined;
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const names = new Set(catalog.result.tools.map((tool) => tool.name));

      if (!SCHEDULE_REHEARSAL_TOOLS.every((name) => names.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a schedule rehearsal tool.",
        );
      }

      const created = await callTool<CreateAgentResult>(
        session,
        "crewhelm_create_agent",
        {
          capabilities: [
            {
              configuration: {
                fallbackModels: [],
                primaryModel: "@cf/zai-org/glm-4.7-flash",
              },
              id: WORKERS_AI_CAPABILITY_ID,
              schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
            },
          ],
          executionLimits: {
            maxDurationSeconds: 45,
            maxModelTokens: 512,
            maxToolCalls: 0,
            maxTurns: 1,
          },
          idempotencyKey: `schedule-rehearsal-agent-${suffix}`,
          instructions: "Execute each bounded recurring responsibility without tools.",
          name: `Schedule rehearsal ${suffix}`,
        },
        createAgentResultSchema,
      );

      if (!created.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was denied.");
      }

      agentId = created.agent.id;
      const configured = [];
      const definitions = [
        {
          at: "07:00",
          name: "Morning brief",
          prompt: "Prepare the bounded morning brief.",
        },
        {
          at: "19:00",
          name: "Evening review",
          prompt: "Prepare the bounded evening review.",
        },
      ] as const;
      let evidence: unknown;
      let operationFailure: unknown;

      try {
        for (const definition of definitions) {
          const response = await callTool<ConfigureAgentScheduleResult>(
            session,
            "crewhelm_configure_agent_schedule",
            {
              agentId,
              expectedAgentRevision: created.agent.revision,
              expectedScheduleRevision: null,
              idempotencyKey: `schedule-rehearsal-${definition.at.replace(":", "")}-${suffix}`,
              schedule: {
                name: definition.name,
                prompt: definition.prompt,
                trigger: {
                  at: definition.at,
                  frequency: "daily",
                  timeZone: "America/Sao_Paulo",
                  type: "calendar",
                },
              },
              scheduleId: null,
            },
            configureAgentScheduleResultSchema,
          );

          if (!response.ok || !response.configured) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Named calendar schedule was not created.",
            );
          }
          configured.push(response.schedule);
        }

        const listed = await callTool<ListAgentSchedulesResult>(
          session,
          "crewhelm_list_agent_schedules",
          { agentId },
          listAgentSchedulesResultSchema,
        );
        const ambiguous = await callDeniedTool<GetAgentScheduleResult>(
          session,
          "crewhelm_get_agent_schedule",
          { agentId },
          getAgentScheduleResultSchema,
        );
        const persistedDefinitions = listed.ok
          ? listed.schedules
              .map((schedule) => {
                const configuration = schedule.configuration;
                const trigger =
                  configuration !== null && "trigger" in configuration
                    ? configuration.trigger
                    : undefined;

                return configuration !== null && trigger?.type === "calendar"
                  ? {
                      at: trigger.at,
                      frequency: trigger.frequency,
                      name: schedule.name,
                      prompt: configuration.prompt,
                      timeZone: trigger.timeZone,
                    }
                  : null;
              })
              .toSorted((left, right) => (left?.name ?? "").localeCompare(right?.name ?? ""))
          : [];
        const expectedDefinitions = definitions
          .map((definition) => ({
            at: definition.at,
            frequency: "daily" as const,
            name: definition.name,
            prompt: definition.prompt,
            timeZone: "America/Sao_Paulo",
          }))
          .toSorted((left, right) => left.name.localeCompare(right.name));

        if (
          !listed.ok ||
          listed.schedules.length !== 2 ||
          new Set(listed.schedules.map((schedule) => schedule.id)).size !== 2 ||
          listed.schedules.some((schedule) => {
            const trigger =
              schedule.configuration !== null && "trigger" in schedule.configuration
                ? schedule.configuration.trigger
                : undefined;

            return (
              trigger?.type !== "calendar" ||
              schedule.nextRunAt === null ||
              localTime(schedule.nextRunAt, trigger.timeZone) !== trigger.at
            );
          }) ||
          JSON.stringify(persistedDefinitions) !== JSON.stringify(expectedDefinitions) ||
          ambiguous.ok ||
          ambiguous.error.code !== "schedule_selection_required"
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Multiple schedule discovery did not preserve exact identities.",
          );
        }

        for (const schedule of configured) {
          const exact = await callTool<GetAgentScheduleResult>(
            session,
            "crewhelm_get_agent_schedule",
            { agentId, scheduleId: schedule.id },
            getAgentScheduleResultSchema,
          );

          if (!exact.ok || exact.schedule.id !== schedule.id) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Exact schedule lookup returned the wrong resource.",
            );
          }
        }

        evidence = {
          agentId,
          schedules: listed.schedules.map((schedule) => ({
            id: schedule.id,
            name: schedule.name,
            nextRunAt: schedule.nextRunAt,
            revision: schedule.revision,
            configuration: schedule.configuration,
          })),
        };
      } catch (error) {
        operationFailure = error;
      }

      let cleanupFailure: unknown;

      try {
        const listed = await callTool<ListAgentSchedulesResult>(
          session,
          "crewhelm_list_agent_schedules",
          { agentId },
          listAgentSchedulesResultSchema,
        );

        if (!listed.ok) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Schedule rehearsal cleanup could not list exact schedules.",
          );
        }

        for (const schedule of listed.schedules.filter((item) => item.status === "active")) {
          const paused = await callTool<ConfigureAgentScheduleResult>(
            session,
            "crewhelm_configure_agent_schedule",
            {
              agentId,
              expectedAgentRevision: created.agent.revision,
              expectedScheduleRevision: schedule.revision,
              idempotencyKey: `schedule-rehearsal-pause-${schedule.id}`,
              schedule: null,
              scheduleId: schedule.id,
            },
            configureAgentScheduleResultSchema,
          );

          if (
            !paused.ok ||
            !paused.configured ||
            paused.schedule.id !== schedule.id ||
            paused.schedule.status !== "paused"
          ) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Schedule rehearsal cleanup did not pause an exact schedule.",
            );
          }
        }

        const verified = await callTool<ListAgentSchedulesResult>(
          session,
          "crewhelm_list_agent_schedules",
          { agentId },
          listAgentSchedulesResultSchema,
        );

        if (!verified.ok || verified.schedules.some((schedule) => schedule.status === "active")) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Schedule rehearsal cleanup left an active schedule.",
          );
        }
      } catch (error) {
        cleanupFailure = error;
      }

      try {
        const disabled = await callTool<BatchDisableAgentsResult>(
          session,
          "crewhelm_batch_disable_agents",
          { agents: [{ agentId, expectedRevision: created.agent.revision }] },
          batchDisableAgentsResultSchema,
        );

        if (
          !disabled.ok ||
          disabled.receipts.length !== 1 ||
          !["already_disabled", "disabled"].includes(disabled.receipts[0]?.outcome ?? "")
        ) {
          cleanupFailure ??= new TemporaryOwnerSessionError(
            "invalid_payload",
            "Disposable schedule rehearsal Agent was not disabled.",
          );
        }
      } catch (error) {
        cleanupFailure ??= error;
      }

      if (cleanupFailure !== undefined) {
        throw cleanupFailure;
      }
      if (operationFailure !== undefined) {
        throw operationFailure;
      }

      return evidence;
    },
  );

  return {
    agentId,
    authorization: result.authorization,
    evidence: result.operation.status === "completed" ? result.operation.value : undefined,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
  };
}

async function watches(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );

  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const suffix = crypto.randomUUID().slice(0, 8);
  let agentId: string | undefined;
  let watchId: string | undefined;
  let watchRevision: number | undefined;
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const names = new Set(catalog.result.tools.map((tool) => tool.name));

      if (!WATCH_REHEARSAL_TOOLS.every((name) => names.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a Watch rehearsal tool.",
        );
      }

      const created = await callTool<CreateAgentResult>(
        session,
        "crewhelm_create_agent",
        {
          capabilities: [
            {
              configuration: {
                fallbackModels: [],
                primaryModel: "@cf/zai-org/glm-4.7-flash",
              },
              id: WORKERS_AI_CAPABILITY_ID,
              schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
            },
          ],
          executionLimits: {
            maxDurationSeconds: 45,
            maxModelTokens: 512,
            maxToolCalls: 0,
            maxTurns: 1,
          },
          idempotencyKey: `watch-rehearsal-agent-${suffix}`,
          instructions: "Complete each bounded Watch check without tools.",
          name: `Watch rehearsal ${suffix}`,
        },
        createAgentResultSchema,
      );

      if (!created.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was denied.");
      }

      agentId = created.agent.id;
      let evidence: unknown;
      let operationFailure: unknown;

      try {
        const sources = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          { action: "sources" },
          agentWatchesResultSchema,
        );

        if (
          !sources.ok ||
          sources.action !== "sources" ||
          !sources.sources.some((source) => source.kind === "scheduled_check")
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Watch source discovery omitted scheduled checks.",
          );
        }

        const createInput = {
          action: "create",
          agentId,
          everyMinutes: 1,
          expectedAgentRevision: created.agent.revision,
          idempotencyKey: `watch-rehearsal-create-${suffix}`,
          instruction: "Return a short confirmation that this scheduled Watch woke the Agent.",
          name: "Scheduled wake-up",
        } as const;
        const createArguments = {
          action: createInput.action,
          agentId: createInput.agentId,
          expectedAgentRevision: createInput.expectedAgentRevision,
          idempotencyKey: createInput.idempotencyKey,
          watch: {
            everyMinutes: createInput.everyMinutes,
            instruction: createInput.instruction,
            name: createInput.name,
          },
        };
        const configured = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          createArguments,
          agentWatchesResultSchema,
        );

        if (
          !configured.ok ||
          configured.action !== "create" ||
          !configured.changed ||
          configured.watch.status !== "active"
        ) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Watch was not created.");
        }

        watchId = configured.watch.id;
        watchRevision = configured.watch.revision;
        const replay = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          createArguments,
          agentWatchesResultSchema,
        );

        if (
          !replay.ok ||
          replay.action !== "create" ||
          replay.changed ||
          replay.watch.id !== watchId ||
          replay.watch.revision !== watchRevision
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Watch creation did not replay exactly.",
          );
        }

        const deadline = Date.now() + options.runTimeoutMs;
        let occurrence:
          | Extract<AgentWatchesResult, { action: "history"; ok: true }>["occurrences"][number]
          | undefined;

        while (Date.now() < deadline) {
          const history = await callTool<AgentWatchesResult>(
            session,
            "crewhelm_agent_watches",
            { action: "history", agentId, limit: 10, watchId },
            agentWatchesResultSchema,
          );

          if (!history.ok || history.action !== "history") {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Watch occurrence history was unavailable.",
            );
          }

          occurrence = history.occurrences.find((item) => item.outcome === "dispatched");
          if (occurrence !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }

        if (occurrence?.runId === null || occurrence?.runId === undefined) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Scheduled Watch did not dispatch in time.",
          );
        }

        const paused = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "pause",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `watch-rehearsal-pause-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!paused.ok || paused.action !== "pause" || paused.watch.status !== "paused") {
          throw new TemporaryOwnerSessionError("invalid_payload", "Watch was not paused.");
        }
        watchRevision = paused.watch.revision;

        const resumed = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "resume",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `watch-rehearsal-resume-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!resumed.ok || resumed.action !== "resume" || resumed.watch.status !== "active") {
          throw new TemporaryOwnerSessionError("invalid_payload", "Watch was not resumed.");
        }
        watchRevision = resumed.watch.revision;

        const deleted = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "delete",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `watch-rehearsal-delete-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!deleted.ok || deleted.action !== "delete" || !deleted.deleted) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Watch was not deleted.");
        }
        const deletionReplay = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "delete",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `watch-rehearsal-delete-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!deletionReplay.ok || deletionReplay.action !== "delete" || deletionReplay.deleted) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Watch deletion did not replay exactly.",
          );
        }
        const listed = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          { action: "list", agentId },
          agentWatchesResultSchema,
        );

        if (!listed.ok || listed.action !== "list" || listed.watches.length !== 0) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Deleted Watch remained discoverable.",
          );
        }

        evidence = {
          occurrence: {
            occurredAt: occurrence.occurredAt,
            runId: occurrence.runId,
            scheduledFor: occurrence.scheduledFor,
            watchRevision: occurrence.watchRevision,
          },
          revisions: {
            created: configured.watch.revision,
            paused: paused.watch.revision,
            resumed: resumed.watch.revision,
          },
          source: "scheduled_check",
          watchId,
        };
        watchId = undefined;
      } catch (error) {
        operationFailure = error;
      }

      if (watchId !== undefined) {
        let cleanupError: unknown;

        for (let attempt = 0; attempt < 5 && watchId !== undefined; attempt += 1) {
          try {
            const inspected = await callToolOutcome<AgentWatchesResult>(
              session,
              "crewhelm_agent_watches",
              { action: "inspect", agentId, watchId },
              agentWatchesResultSchema,
            );

            if (!inspected.ok) {
              if (inspected.error.code === "watch_not_found") {
                watchId = undefined;
                break;
              }
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                `Watch cleanup inspection was denied: ${inspected.error.code}.`,
              );
            }

            if (inspected.action !== "inspect") {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Watch cleanup inspection returned the wrong action.",
              );
            }

            watchRevision = inspected.watch.revision;
            const cleaned = await callToolOutcome<AgentWatchesResult>(
              session,
              "crewhelm_agent_watches",
              {
                action: "delete",
                agentId,
                expectedAgentRevision: created.agent.revision,
                expectedWatchRevision: watchRevision,
                idempotencyKey: `watch-rehearsal-cleanup-${suffix}`,
                watchId,
              },
              agentWatchesResultSchema,
            );

            if (!cleaned.ok) {
              if (cleaned.error.code === "watch_busy") {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                continue;
              }
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                `Watch cleanup was denied: ${cleaned.error.code}.`,
              );
            }

            const verified = await callToolOutcome<AgentWatchesResult>(
              session,
              "crewhelm_agent_watches",
              { action: "inspect", agentId, watchId },
              agentWatchesResultSchema,
            );

            if (!verified.ok && verified.error.code === "watch_not_found") {
              watchId = undefined;
              break;
            }

            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Watch cleanup did not remove the exact Watch.",
            );
          } catch (error) {
            cleanupError = error;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }

        if (watchId !== undefined) {
          operationFailure ??=
            cleanupError ??
            new TemporaryOwnerSessionError("invalid_payload", "Watch cleanup did not finish.");
        }
      }

      try {
        const disabled = await callTool<BatchDisableAgentsResult>(
          session,
          "crewhelm_batch_disable_agents",
          { agents: [{ agentId, expectedRevision: created.agent.revision }] },
          batchDisableAgentsResultSchema,
        );

        if (
          !disabled.ok ||
          disabled.receipts.length !== 1 ||
          !["already_disabled", "disabled"].includes(disabled.receipts[0]?.outcome ?? "")
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Disposable Watch rehearsal Agent was not disabled.",
          );
        }
      } catch (cleanupError) {
        operationFailure ??= cleanupError;
      }

      if (operationFailure !== undefined) throw operationFailure;
      return evidence;
    },
  );

  return {
    agentId,
    authorization: result.authorization,
    evidence: result.operation.status === "completed" ? result.operation.value : undefined,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    ...(watchId === undefined ? {} : { retainedWatchId: watchId }),
    revocation: result.revocation,
    schemaVersion: 1,
  };
}

async function connectedWatches(options: {
  credentialPath: string;
  installationPath: string;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );

  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const missingSignatureIngress = await fetch(new URL("/webhooks/composio", target.origin), {
    body: JSON.stringify({ metadata: {} }),
    headers: { "content-type": "application/json" },
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  if (missingSignatureIngress.status !== 401) {
    return {
      boundary: { missingSignatureIngressStatus: missingSignatureIngress.status },
      ok: false,
      public: publicReport,
      schemaVersion: 1,
    };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const suffix = crypto.randomUUID().slice(0, 8);
  let agentId: string | undefined;
  let watchId: string | undefined;
  let watchRevision: number | undefined;
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const names = new Set(catalog.result.tools.map((tool) => tool.name));

      if (!CONNECTED_WATCH_REHEARSAL_TOOLS.every((name) => names.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a connected-Watch rehearsal tool.",
        );
      }

      const activeAgentsBefore = (await readRehearsalStatus(session)).usage.agents.active;
      const connections = await callTool<ListConnectionsResult>(
        session,
        "crewhelm_list_connections",
        { authorizationOutcome: "returned", limit: 20, status: "active" },
        listConnectionsResultSchema,
      );

      if (!connections.ok || connections.connections.length === 0) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Connected-Watch rehearsal requires one active returned test connection.",
        );
      }

      let source:
        | Extract<
            Extract<AgentWatchesResult, { action: "sources"; ok: true }>["sources"][number],
            { kind: "connection_event" }
          >
        | undefined;

      for (const connection of connections.connections) {
        const sources = await callToolOutcome<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          { action: "sources", connectionId: connection.connectionId },
          agentWatchesResultSchema,
        );

        if (!sources.ok || sources.action !== "sources") continue;
        for (const candidate of sources.sources) {
          if (
            candidate.kind === "connection_event" &&
            candidate.configuration.every((field) => !field.required)
          ) {
            source = candidate;
            break;
          }
        }
        if (source !== undefined) break;
      }

      if (source === undefined) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "No active test connection exposed a filter-free connected event.",
        );
      }

      const created = await callTool<CreateAgentResult>(
        session,
        "crewhelm_create_agent",
        {
          capabilities: [
            {
              configuration: {
                fallbackModels: [],
                primaryModel: "@cf/zai-org/glm-4.7-flash",
              },
              id: WORKERS_AI_CAPABILITY_ID,
              schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
            },
          ],
          executionLimits: {
            maxDurationSeconds: 45,
            maxModelTokens: 512,
            maxToolCalls: 0,
            maxTurns: 1,
          },
          idempotencyKey: `connected-watch-rehearsal-agent-${suffix}`,
          instructions: "Handle each bounded connected-app Watch event without tools.",
          name: `Connected Watch rehearsal ${suffix}`,
        },
        createAgentResultSchema,
      );

      if (!created.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was denied.");
      }

      agentId = created.agent.id;
      const createArguments = {
        action: "create",
        agentId,
        expectedAgentRevision: created.agent.revision,
        idempotencyKey: `connected-watch-rehearsal-create-${suffix}`,
        watch: {
          connectionId: source.connectionId,
          delivery: source.delivery,
          eventSlug: source.sourceSlug,
          eventVersion: source.sourceVersion,
          filters: {},
          integrationSlug: source.integration.slug,
          instruction: "Summarize the matching event and recommend the next owner action.",
          name: `Connected ${source.name}`.slice(0, 80),
        },
      } as const;
      let evidence: unknown;
      let operationFailure: unknown;

      try {
        let configured: AgentWatchesResult | undefined;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          configured = await callToolOutcome<AgentWatchesResult>(
            session,
            "crewhelm_agent_watches",
            createArguments,
            agentWatchesResultSchema,
          );
          if (configured.ok) break;
          if (configured.error.code !== "watch_operation_unknown") break;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }

        if (
          configured === undefined ||
          !configured.ok ||
          configured.action !== "create" ||
          configured.watch.status !== "active"
        ) {
          const discovered = await callToolOutcome<AgentWatchesResult>(
            session,
            "crewhelm_agent_watches",
            { action: "list", agentId },
            agentWatchesResultSchema,
          );

          if (discovered.ok && discovered.action === "list" && discovered.watches.length === 1) {
            watchId = discovered.watches[0]?.id;
            watchRevision = discovered.watches[0]?.revision;
          }

          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch was not created.",
          );
        }

        watchId = configured.watch.id;
        watchRevision = configured.watch.revision;
        const replay = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          createArguments,
          agentWatchesResultSchema,
        );

        if (
          !replay.ok ||
          replay.action !== "create" ||
          replay.changed ||
          replay.watch.id !== watchId ||
          replay.watch.revision !== watchRevision
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch creation did not replay exactly.",
          );
        }

        const deniedIngress = await fetch(new URL("/webhooks/composio", target.origin), {
          body: JSON.stringify({ metadata: {} }),
          headers: {
            "content-type": "application/json",
            "webhook-id": `webhook_rehearsal_${suffix}`,
            "webhook-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            "webhook-timestamp": String(Math.floor(Date.now() / 1_000)),
          },
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(options.timeoutMs),
        });

        if (deniedIngress.status !== 401) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Unsigned connected-Watch ingress did not fail closed.",
          );
        }

        const paused = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "pause",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `connected-watch-rehearsal-pause-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!paused.ok || paused.action !== "pause" || paused.watch.status !== "paused") {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch was not paused.",
          );
        }
        watchRevision = paused.watch.revision;

        const resumed = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "resume",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `connected-watch-rehearsal-resume-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!resumed.ok || resumed.action !== "resume" || resumed.watch.status !== "active") {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch was not resumed.",
          );
        }
        watchRevision = resumed.watch.revision;

        const deleted = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "delete",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `connected-watch-rehearsal-delete-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );

        if (!deleted.ok || deleted.action !== "delete" || !deleted.deleted) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch was not deleted.",
          );
        }

        const deletionReplay = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          {
            action: "delete",
            agentId,
            expectedAgentRevision: created.agent.revision,
            expectedWatchRevision: watchRevision,
            idempotencyKey: `connected-watch-rehearsal-delete-${suffix}`,
            watchId,
          },
          agentWatchesResultSchema,
        );
        const listed = await callTool<AgentWatchesResult>(
          session,
          "crewhelm_agent_watches",
          { action: "list", agentId },
          agentWatchesResultSchema,
        );

        if (
          !deletionReplay.ok ||
          deletionReplay.action !== "delete" ||
          deletionReplay.deleted ||
          !listed.ok ||
          listed.action !== "list" ||
          listed.watches.length !== 0
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected Watch cleanup did not replay or disappear exactly.",
          );
        }

        evidence = {
          connectionId: source.connectionId,
          delivery: source.delivery,
          eventSlug: source.sourceSlug,
          eventVersion: source.sourceVersion,
          integrationSlug: source.integration.slug,
          revisions: {
            created: configured.watch.revision,
            paused: paused.watch.revision,
            resumed: resumed.watch.revision,
          },
          missingSignatureIngressStatus: missingSignatureIngress.status,
          unsignedIngressStatus: deniedIngress.status,
          authenticEventDelivery: "not_exercised",
          watchId,
        };
        watchId = undefined;
      } catch (error) {
        operationFailure = error;
      }

      if (watchId !== undefined) {
        try {
          for (let attempt = 0; attempt < 5 && watchId !== undefined; attempt += 1) {
            const listed = await callToolOutcome<AgentWatchesResult>(
              session,
              "crewhelm_agent_watches",
              { action: "list", agentId },
              agentWatchesResultSchema,
            );

            if (!listed.ok || listed.action !== "list") {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              continue;
            }

            const retained = listed.watches.filter((watch) => watch.id === watchId);

            if (retained.length === 0) {
              watchId = undefined;
              break;
            }

            if (retained.length !== 1) break;
            watchRevision = retained[0]?.revision;

            if (watchRevision === undefined) break;

            const deleted = await callToolOutcome<AgentWatchesResult>(
              session,
              "crewhelm_agent_watches",
              {
                action: "delete",
                agentId,
                expectedAgentRevision: created.agent.revision,
                expectedWatchRevision: watchRevision,
                idempotencyKey: `connected-watch-rehearsal-cleanup-${suffix}-${attempt}`,
                watchId,
              },
              agentWatchesResultSchema,
            );
            if (deleted.ok && deleted.action === "delete") {
              watchId = undefined;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        } catch (cleanupError) {
          operationFailure ??= cleanupError;
        }
      }

      if (watchId !== undefined) {
        operationFailure ??= new TemporaryOwnerSessionError(
          "invalid_payload",
          "Connected Watch cleanup did not finish.",
        );
      }

      try {
        const disabled = await callTool<BatchDisableAgentsResult>(
          session,
          "crewhelm_batch_disable_agents",
          { agents: [{ agentId, expectedRevision: created.agent.revision }] },
          batchDisableAgentsResultSchema,
        );
        const activeAgentsAfter = (await readRehearsalStatus(session)).usage.agents.active;

        if (
          !disabled.ok ||
          disabled.receipts.length !== 1 ||
          !["already_disabled", "disabled"].includes(disabled.receipts[0]?.outcome ?? "") ||
          activeAgentsAfter !== activeAgentsBefore
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Connected-Watch rehearsal did not restore Agent capacity.",
          );
        }

        evidence = {
          ...(typeof evidence === "object" && evidence !== null ? evidence : {}),
          activeAgentsAfter,
          activeAgentsBefore,
        };
      } catch (cleanupError) {
        operationFailure ??= cleanupError;
      }

      if (operationFailure !== undefined) throw operationFailure;
      return evidence;
    },
  );

  return {
    agentId,
    authorization: result.authorization,
    boundary: { missingSignatureIngressStatus: missingSignatureIngress.status },
    evidence: result.operation.status === "completed" ? result.operation.value : undefined,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    ...(watchId === undefined ? {} : { retainedWatchId: watchId }),
    revocation: result.revocation,
    schemaVersion: 1,
  };
}

async function conversation(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const suffix = crypto.randomUUID().slice(0, 8);
  const marker = `conversation-${suffix}`;
  let agentId: string | undefined;
  let conversationId: string | undefined;
  let firstRunId: string | undefined;
  let secondRunId: string | undefined;
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const names = new Set(catalog.result.tools.map((tool) => tool.name));
      if (!CONVERSATION_REHEARSAL_TOOLS.every((name) => names.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a conversation rehearsal tool.",
        );
      }

      const activeAgentsBefore = (await readRehearsalStatus(session)).usage.agents.active;
      const created = await callTool<CreateAgentResult>(
        session,
        "crewhelm_create_agent",
        {
          capabilities: [
            {
              configuration: {
                fallbackModels: [],
                primaryModel: "@cf/zai-org/glm-4.7-flash",
              },
              id: WORKERS_AI_CAPABILITY_ID,
              schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
            },
          ],
          executionLimits: {
            maxDurationSeconds: 90,
            maxModelTokens: 768,
            maxToolCalls: 0,
            maxTurns: 2,
          },
          idempotencyKey: `conversation-agent-${suffix}`,
          instructions:
            "Keep a short conversation. Remember owner-provided context and reply concisely without tools.",
          name: `Conversation rehearsal ${suffix}`,
        },
        createAgentResultSchema,
      );
      if (!created.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was denied.");
      }
      agentId = created.agent.id;
      let evidence: unknown;
      let expectedConversationRevision: number | undefined;
      let operationFailure: unknown;
      let sessionDeleted = false;

      const waitForRun = async (runId: string) => {
        const deadline = Date.now() + options.runTimeoutMs;
        let inspected: InspectRunResult | undefined;
        while (Date.now() < deadline) {
          inspected = await callTool<InspectRunResult>(
            session,
            "crewhelm_inspect_run",
            { runId },
            inspectRunResultSchema,
          );
          if (inspected.ok && ["completed", "failed"].includes(inspected.run.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        if (!inspected?.ok || inspected.run.status !== "completed") {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation Run did not complete successfully.",
          );
        }
        return inspected;
      };

      try {
        const firstInput = {
          agentId,
          expectedRevision: created.agent.revision,
          idempotencyKey: `conversation-first-${suffix}`,
          prompt: `Remember the phrase ${marker} and acknowledge it briefly.`,
        };
        const first = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          firstInput,
          startRunResultSchema,
        );
        if (!first.ok) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            `Conversation start was denied with ${first.error.code}.`,
          );
        }
        if (first.conversation === undefined) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation start did not return a copy-ready handle.",
          );
        }
        conversationId = first.conversation.id;
        expectedConversationRevision = first.conversation.expectedRevision;
        firstRunId = first.run.runId;
        const firstReplay = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          firstInput,
          startRunResultSchema,
        );
        if (
          !firstReplay.ok ||
          firstReplay.created ||
          firstReplay.run.runId !== first.run.runId ||
          JSON.stringify(firstReplay.conversation) !== JSON.stringify(first.conversation)
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation start did not return one replay-safe handle.",
          );
        }
        const firstInspection = await waitForRun(firstRunId);
        if (
          firstInspection.conversation?.id !== conversationId ||
          firstInspection.conversation.expectedRevision !== first.conversation.expectedRevision
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Run inspection did not preserve the conversation handle.",
          );
        }

        const listedBeforeFollowUp = await callTool(
          session,
          "crewhelm_agent_sessions",
          { action: "list", agentId, limit: 10 },
          manageAgentSessionsResultSchema,
        );
        if (
          !listedBeforeFollowUp.ok ||
          !("sessions" in listedBeforeFollowUp) ||
          listedBeforeFollowUp.sessions.length !== 1 ||
          listedBeforeFollowUp.sessions[0]?.sessionId !== conversationId ||
          JSON.stringify(listedBeforeFollowUp).includes(marker)
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Compact conversation discovery was not bounded to metadata.",
          );
        }

        const firstConversation = first.conversation;
        const secondInput = {
          agentId,
          conversation: firstConversation,
          expectedRevision: created.agent.revision,
          idempotencyKey: `conversation-second-${suffix}`,
          prompt: "Reply with the exact phrase I asked you to remember and nothing else.",
        };
        const second = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          secondInput,
          startRunResultSchema,
        );
        if (
          !second.ok ||
          second.conversation?.id !== conversationId ||
          second.conversation.expectedRevision !== firstConversation.expectedRevision + 1
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation follow-up did not advance one exact revision.",
          );
        }
        secondRunId = second.run.runId;
        expectedConversationRevision = second.conversation.expectedRevision;
        const secondInspection = await waitForRun(secondRunId);
        if (!secondInspection.run.output?.includes(marker)) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "The Agent follow-up did not preserve conversation context.",
          );
        }
        const secondReplay = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          secondInput,
          startRunResultSchema,
        );
        if (
          !secondReplay.ok ||
          secondReplay.created ||
          secondReplay.run.runId !== secondRunId ||
          JSON.stringify(secondReplay.conversation) !== JSON.stringify(second.conversation)
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation follow-up replay did not return the original Run.",
          );
        }

        const stale = await callDeniedTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          {
            ...secondInput,
            idempotencyKey: `conversation-stale-${suffix}`,
          },
          startRunResultSchema,
        );
        if (stale.ok || stale.error.code !== "branch_revision_conflict") {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "A stale conversation handle did not fail closed.",
          );
        }

        const recovered = await callTool(
          session,
          "crewhelm_agent_sessions",
          { action: "inspect", agentId, sessionId: conversationId },
          manageAgentSessionsResultSchema,
        );
        if (
          !recovered.ok ||
          !("conversation" in recovered) ||
          JSON.stringify(recovered.conversation) !== JSON.stringify(second.conversation) ||
          !recovered.messages.some((message) => message.text.includes(marker)) ||
          secondInspection.run.session?.sessionId !== conversationId
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Exact conversation recovery did not return the latest copy-ready handle.",
          );
        }

        const deleted = await callTool(
          session,
          "crewhelm_delete_agent_session",
          {
            agentId,
            expectedBranchRevision: expectedConversationRevision,
            idempotencyKey: `conversation-delete-${suffix}`,
            sessionId: conversationId,
          },
          manageAgentSessionsResultSchema,
        );
        if (!deleted.ok || !("deleted" in deleted) || !deleted.deleted) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation cleanup was not verified.",
          );
        }
        sessionDeleted = true;

        evidence = {
          activeAgentsBefore,
          conversationId,
          conversationRevisions: [
            firstConversation.expectedRevision,
            second.conversation.expectedRevision,
          ],
          firstRunId,
          secondRunId,
        };
      } catch (error) {
        operationFailure = error;
      }

      let cleanupFailure: unknown;
      if (conversationId !== undefined && !sessionDeleted) {
        try {
          const cleanupDeadline = Date.now() + Math.min(options.runTimeoutMs, 60_000);
          const knownRunIds = [firstRunId, secondRunId].filter(
            (runId): runId is string => runId !== undefined,
          );
          for (const runId of knownRunIds) {
            while (true) {
              const inspected = await callTool<InspectRunResult>(
                session,
                "crewhelm_inspect_run",
                { runId },
                inspectRunResultSchema,
              );
              if (!inspected.ok || inspected.run.runId !== runId) {
                throw new TemporaryOwnerSessionError(
                  "invalid_payload",
                  "Conversation cleanup did not match the exact Run.",
                );
              }
              if (["cancelled", "completed", "failed"].includes(inspected.run.status)) break;
              if (Date.now() >= cleanupDeadline) {
                throw new TemporaryOwnerSessionError(
                  "timeout",
                  "Conversation cleanup did not reach a terminal Run state.",
                );
              }
              try {
                await callTool(session, "crewhelm_cancel_run", { runId }, cancelRunResultSchema);
              } catch {
                // Exact inspection reconciles an in-flight cancellation or a lost response.
              }
              await new Promise((resolve) => setTimeout(resolve, 5_000));
            }
          }

          const recovered = await callTool(
            session,
            "crewhelm_agent_sessions",
            { action: "inspect", agentId, sessionId: conversationId },
            manageAgentSessionsResultSchema,
          );
          if (!recovered.ok || !("conversation" in recovered)) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Conversation cleanup could not recover the latest exact revision.",
            );
          }
          expectedConversationRevision = recovered.conversation.expectedRevision;
          const deleted = await callTool(
            session,
            "crewhelm_delete_agent_session",
            {
              agentId,
              expectedBranchRevision: expectedConversationRevision,
              idempotencyKey: `conversation-delete-${suffix}`,
              sessionId: conversationId,
            },
            manageAgentSessionsResultSchema,
          );
          if (!deleted.ok && deleted.error.code !== "session_not_found") {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Conversation cleanup was not verified.",
            );
          }
        } catch (error) {
          cleanupFailure = error;
        }
      }

      try {
        const disabled = await callTool<BatchDisableAgentsResult>(
          session,
          "crewhelm_batch_disable_agents",
          { agents: [{ agentId, expectedRevision: created.agent.revision }] },
          batchDisableAgentsResultSchema,
        );
        if (
          !disabled.ok ||
          disabled.receipts.length !== 1 ||
          !["already_disabled", "disabled"].includes(disabled.receipts[0]?.outcome ?? "")
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Disposable conversation Agent was not disabled.",
          );
        }
        const activeAgentsAfter = (await readRehearsalStatus(session)).usage.agents.active;
        if (activeAgentsAfter !== activeAgentsBefore) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Conversation rehearsal did not restore Agent capacity.",
          );
        }
        evidence = {
          ...(typeof evidence === "object" && evidence !== null ? evidence : {}),
          activeAgentsAfter,
        };
      } catch (error) {
        cleanupFailure ??= error;
      }

      if (cleanupFailure !== undefined) throw cleanupFailure;
      if (operationFailure !== undefined) throw operationFailure;
      return evidence;
    },
  );

  return {
    agentId,
    authorization: result.authorization,
    conversationId,
    evidence: result.operation.status === "completed" ? result.operation.value : undefined,
    firstRunId,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
    secondRunId,
  };
}

async function typedOutput(options: {
  credentialPath: string;
  installationPath: string;
  runTimeoutMs: number;
  timeoutMs: number;
}): Promise<unknown> {
  const target = await resolveRehearsalTarget(options.installationPath);
  const publicReport = await diagnoseDeployment(
    { origin: target.origin, timeoutMs: options.timeoutMs },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
  );
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return { ok: false, public: publicReport, schemaVersion: 1 };
  }

  const credential = await readRehearsalCredential(options.credentialPath);
  const suffix = crypto.randomUUID().slice(0, 8);
  let agentId: string | undefined;
  let workflowId: string | undefined;
  const result = await runRefreshableOwnerSession(
    {
      credential,
      origin: target.origin,
      persistCredential: (rotated) => writeRehearsalCredential(options.credentialPath, rotated),
      timeoutMs: options.timeoutMs,
    },
    { expectedDeploymentFingerprint: target.expectedDeploymentFingerprint, fetch },
    async (session) => {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-live-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const names = new Set(catalog.result.tools.map((tool) => tool.name));
      if (!TYPED_OUTPUT_REHEARSAL_TOOLS.every((name) => names.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a typed-output rehearsal tool.",
        );
      }

      const created = await callTool<CreateAgentResult>(
        session,
        "crewhelm_create_agent",
        {
          capabilities: [
            {
              configuration: {
                fallbackModels: [],
                primaryModel: "@cf/zai-org/glm-4.7-flash",
              },
              id: WORKERS_AI_CAPABILITY_ID,
              schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
            },
          ],
          executionLimits: {
            maxDurationSeconds: 90,
            maxModelTokens: 2_048,
            maxToolCalls: 0,
            maxTurns: 4,
          },
          idempotencyKey: `typed-output-agent-${suffix}`,
          instructions:
            "Follow the requested JSON output contract exactly. Return only one object with exactly the requested fields, no prose or code fence, and use the values the prompt supplies.",
          name: `Typed output rehearsal ${suffix}`,
        },
        createAgentResultSchema,
      );
      if (!created.ok) {
        throw new TemporaryOwnerSessionError("invalid_payload", "Disposable Agent was denied.");
      }
      agentId = created.agent.id;
      let operationFailure: unknown;
      let evidence: unknown;

      try {
        const runInput = {
          agentId,
          expectedRevision: created.agent.revision,
          idempotencyKey: `typed-output-run-${suffix}`,
          outputContract: TYPED_OUTPUT_CONTRACT,
          prompt:
            'Return exactly this assessment under the requested contract: {"summary":"Durable typed output is useful.","confidence":0.9}',
        };
        const started = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          runInput,
          startRunResultSchema,
        );
        const replayed = await callTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          runInput,
          startRunResultSchema,
        );
        const changed = await callDeniedTool<StartRunResult>(
          session,
          "crewhelm_start_run",
          {
            ...runInput,
            outputContract: {
              ...TYPED_OUTPUT_CONTRACT,
              schema: { ...TYPED_OUTPUT_CONTRACT.schema, version: "2" },
            },
          },
          startRunResultSchema,
        );
        if (
          !started.ok ||
          !replayed.ok ||
          started.run.runId !== replayed.run.runId ||
          replayed.created ||
          changed.ok ||
          changed.error.code !== "idempotency_conflict"
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Typed Run replay did not preserve its exact frozen contract.",
          );
        }

        const runDeadline = Date.now() + options.runTimeoutMs;
        let compactRun: InspectRunResult | undefined;
        while (Date.now() < runDeadline) {
          compactRun = await callTool<InspectRunResult>(
            session,
            "crewhelm_inspect_run",
            { runId: started.run.runId },
            inspectRunResultSchema,
          );
          if (compactRun.ok && ["completed", "failed"].includes(compactRun.run.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        const exactRun = await callTool<InspectRunResult>(
          session,
          "crewhelm_inspect_run",
          { includeDeliverable: true, runId: started.run.runId },
          inspectRunResultSchema,
        );
        if (
          compactRun?.ok !== true ||
          compactRun.run.status !== "completed" ||
          compactRun.run.deliverable?.state !== "valid" ||
          "deliverableContent" in compactRun ||
          compactRun.retention.output.retainedCharacters <= 0 ||
          !exactRun.ok ||
          exactRun.run.status !== "completed" ||
          exactRun.run.deliverable?.state !== "valid" ||
          exactRun.deliverableContent?.summary === undefined ||
          typeof exactRun.deliverableContent.confidence !== "number" ||
          exactRun.retention.output.retainedCharacters !==
            compactRun.retention.output.retainedCharacters
        ) {
          console.warn({
            compactDeliverableState: compactRun?.ok ? compactRun.run.deliverable?.state : undefined,
            compactHasDeliverableContent:
              compactRun === undefined ? undefined : "deliverableContent" in compactRun,
            compactOk: compactRun?.ok,
            compactRetainedCharacters: compactRun?.ok
              ? compactRun.retention.output.retainedCharacters
              : undefined,
            compactStatus: compactRun?.ok ? compactRun.run.status : undefined,
            event: "crewhelm.rehearsal.typed_run_mismatch",
            exactConfidenceType:
              exactRun.ok && exactRun.deliverableContent !== undefined
                ? typeof exactRun.deliverableContent.confidence
                : undefined,
            exactDeliverableState: exactRun.ok ? exactRun.run.deliverable?.state : undefined,
            exactOk: exactRun.ok,
            exactRetainedCharacters: exactRun.ok
              ? exactRun.retention.output.retainedCharacters
              : undefined,
            exactStatus: exactRun.ok ? exactRun.run.status : undefined,
            exactSummaryType:
              exactRun.ok && exactRun.deliverableContent !== undefined
                ? typeof exactRun.deliverableContent.summary
                : undefined,
          });
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Typed Run did not preserve compact discovery and exact validated content.",
          );
        }
        const runDeliverable = exactRun.run.deliverable;

        const workflowStarted = await callTool<
          ReturnType<typeof manageAgentWorkflowsResultSchema.parse>
        >(
          session,
          "crewhelm_agent_workflows",
          {
            action: "start",
            agentId,
            expectedRevision: created.agent.revision,
            idempotencyKey: `typed-output-workflow-${suffix}`,
            objective: "Produce one typed assessment after a short preparation stage.",
            outputContract: TYPED_OUTPUT_CONTRACT,
            stages: [
              { name: "Prepare", prompt: "Prepare the assessment facts in ordinary prose." },
              {
                name: "Deliver",
                prompt:
                  'Return exactly this final assessment under the requested contract: {"summary":"Durable typed workflows are useful.","confidence":0.9}',
              },
            ],
          },
          manageAgentWorkflowsResultSchema,
        );
        if (!("workflow" in workflowStarted) || !workflowStarted.ok) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Typed Workflow was denied.");
        }
        workflowId = workflowStarted.workflow.workflowId;
        const workflowDeadline = Date.now() + options.runTimeoutMs;
        let compactWorkflow: ReturnType<typeof manageAgentWorkflowsResultSchema.parse> | undefined;
        while (Date.now() < workflowDeadline) {
          compactWorkflow = await callTool(
            session,
            "crewhelm_agent_workflows",
            {
              action: "inspect",
              workflowId,
            },
            manageAgentWorkflowsResultSchema,
          );
          if (
            "workflow" in compactWorkflow &&
            compactWorkflow.ok &&
            ["cancelled", "completed", "failed"].includes(compactWorkflow.workflow.status)
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        const exactWorkflow = await callTool(
          session,
          "crewhelm_agent_workflows",
          {
            action: "inspect",
            includeDeliverable: true,
            workflowId,
          },
          manageAgentWorkflowsResultSchema,
        );
        const exactWorkflowAggregate =
          "workflow" in exactWorkflow && exactWorkflow.ok && "deliverable" in exactWorkflow.workflow
            ? exactWorkflow.workflow
            : undefined;
        if (
          compactWorkflow === undefined ||
          !("workflow" in compactWorkflow) ||
          !compactWorkflow.ok ||
          compactWorkflow.workflow.status !== "completed" ||
          "deliverableContent" in compactWorkflow.workflow ||
          exactWorkflowAggregate?.status !== "completed" ||
          exactWorkflowAggregate.deliverable?.kind !== "json" ||
          exactWorkflowAggregate.deliverableContent === undefined
        ) {
          console.warn({
            compactHasDeliverableContent:
              compactWorkflow !== undefined && "workflow" in compactWorkflow
                ? "deliverableContent" in compactWorkflow.workflow
                : undefined,
            compactStatus:
              compactWorkflow !== undefined && "workflow" in compactWorkflow && compactWorkflow.ok
                ? compactWorkflow.workflow.status
                : undefined,
            event: "crewhelm.rehearsal.typed_workflow_mismatch",
            exactDeliverableKind: exactWorkflowAggregate?.deliverable?.kind,
            exactHasDeliverableContent:
              exactWorkflowAggregate === undefined
                ? undefined
                : exactWorkflowAggregate.deliverableContent !== undefined,
            exactStatus: exactWorkflowAggregate?.status,
          });
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Typed Workflow did not return one exact final JSON deliverable.",
          );
        }
        const deleted = await callTool(
          session,
          "crewhelm_agent_workflows",
          {
            action: "delete",
            expectedRevision: exactWorkflowAggregate.revision,
            idempotencyKey: `typed-output-delete-${suffix}`,
            workflowId,
          },
          manageAgentWorkflowsResultSchema,
        );
        if (!("deleted" in deleted) || !deleted.ok || !deleted.deleted) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Typed Workflow cleanup failed.");
        }

        evidence = {
          agentId,
          runId: started.run.runId,
          runRepairAttempted: runDeliverable.repairAttempted,
          runSchemaDigest: runDeliverable.schema.digest,
          workflowId,
          workflowSchemaDigest: exactWorkflowAggregate.deliverable.schema.digest,
        };
      } catch (error) {
        operationFailure = error;
      }

      try {
        const disabled = await callTool<BatchDisableAgentsResult>(
          session,
          "crewhelm_batch_disable_agents",
          { agents: [{ agentId, expectedRevision: created.agent.revision }] },
          batchDisableAgentsResultSchema,
        );
        if (
          !disabled.ok ||
          disabled.receipts.length !== 1 ||
          !["already_disabled", "disabled"].includes(disabled.receipts[0]?.outcome ?? "")
        ) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Disposable typed-output Agent was not disabled.",
          );
        }
      } catch (cleanupError) {
        if (operationFailure === undefined) throw cleanupError;
      }
      if (operationFailure !== undefined) throw operationFailure;
      return evidence;
    },
  );

  return {
    agentId,
    authorization: result.authorization,
    evidence: result.operation.status === "completed" ? result.operation.value : undefined,
    ok:
      result.authorization.ok &&
      result.operation.status === "completed" &&
      result.revocation.status === "revoked",
    operation: result.operation,
    public: publicReport,
    revocation: result.revocation,
    schemaVersion: 1,
    workflowId,
  };
}

export async function runLiveRehearsal(arguments_: readonly string[]): Promise<number> {
  const [action, ...rest] = arguments_;
  if (
    action !== "authorize" &&
    action !== "connected-watches" &&
    action !== "conversation" &&
    action !== "inspect-sandbox" &&
    action !== "recover" &&
    action !== "recover-conversation" &&
    action !== "sandbox" &&
    action !== "schedules" &&
    action !== "watches" &&
    action !== "typed-output" &&
    action !== "web-research" &&
    action !== "workflow"
  ) {
    process.stderr.write(
      "Usage: crewhelm-live-rehearsal.ts <authorize|connected-watches|conversation|inspect-sandbox|recover|recover-conversation|sandbox|schedules|typed-output|watches|web-research|workflow> [options]\n",
    );
    return 2;
  }
  const parsed = parseArgs({
    args: rest,
    options: {
      browser: { default: "codex", type: "string" },
      "agent-id": { type: "string" },
      credential: { default: DEFAULT_CREDENTIAL, type: "string" },
      installation: { default: DEFAULT_INSTALLATION, type: "string" },
      "run-timeout-ms": { default: "240000", type: "string" },
      "run-id": { type: "string" },
      "session-id": { type: "string" },
      "timeout-ms": { default: "5000", type: "string" },
      "workflow-id": { type: "string" },
    },
    strict: true,
  });
  const timeoutMs = boundedInteger(parsed.values["timeout-ms"], 100, 30_000, "timeout-ms");
  const common = {
    credentialPath: parsed.values.credential,
    installationPath: parsed.values.installation,
    timeoutMs,
  };
  const runTimeoutMs = boundedInteger(
    parsed.values["run-timeout-ms"],
    1_000,
    10 * 60 * 1_000,
    "run-timeout-ms",
  );
  const report =
    action === "authorize"
      ? await authorize({
          ...common,
          browser:
            parsed.values.browser === "codex" || parsed.values.browser === "system"
              ? parsed.values.browser
              : (() => {
                  throw new Error("browser must be codex or system.");
                })(),
        })
      : action === "connected-watches"
        ? await connectedWatches(common)
        : action === "conversation"
          ? await conversation({ ...common, runTimeoutMs })
          : action === "inspect-sandbox"
            ? await inspectSandbox({
                ...common,
                runId:
                  parsed.values["run-id"] ??
                  (() => {
                    throw new Error("inspect-sandbox requires run-id.");
                  })(),
              })
            : action === "recover-conversation"
              ? await recoverConversation({
                  ...common,
                  agentId:
                    parsed.values["agent-id"] ??
                    (() => {
                      throw new Error("recover-conversation requires agent-id.");
                    })(),
                  sessionId:
                    parsed.values["session-id"] ??
                    (() => {
                      throw new Error("recover-conversation requires session-id.");
                    })(),
                })
              : action === "recover"
                ? await recover({
                    ...common,
                    agentId:
                      parsed.values["agent-id"] ??
                      (() => {
                        throw new Error("recover requires agent-id.");
                      })(),
                    runTimeoutMs,
                    workflowId:
                      parsed.values["workflow-id"] ??
                      (() => {
                        throw new Error("recover requires workflow-id.");
                      })(),
                  })
                : action === "sandbox"
                  ? await sandbox({
                      ...common,
                      runTimeoutMs,
                    })
                  : action === "schedules"
                    ? await schedules(common)
                    : action === "watches"
                      ? await watches({ ...common, runTimeoutMs })
                      : action === "typed-output"
                        ? await typedOutput({ ...common, runTimeoutMs })
                        : action === "web-research"
                          ? await webResearch({
                              ...common,
                              runTimeoutMs,
                            })
                          : await workflow({
                              ...common,
                              runTimeoutMs,
                            });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return typeof report === "object" && report !== null && Reflect.get(report, "ok") === true
    ? 0
    : 1;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runLiveRehearsal(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      return undefined;
    },
    (error: unknown) => {
      process.stderr.write(
        `Live rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
      return undefined;
    },
  );
}
