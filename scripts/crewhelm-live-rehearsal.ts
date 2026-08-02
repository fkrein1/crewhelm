#!/usr/bin/env -S pnpm exec tsx

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  batchDisableAgentsResultSchema,
  configureAgentScheduleResultSchema,
  createAgentResultSchema,
  getAgentScheduleResultSchema,
  inspectRunResultSchema,
  listAgentSchedulesResultSchema,
  manageAgentWorkflowsResultSchema,
  startRunResultSchema,
  type BatchDisableAgentsResult,
  type ConfigureAgentScheduleResult,
  type CreateAgentResult,
  type GetAgentScheduleResult,
  type ListAgentSchedulesResult,
  type InspectRunResult,
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
            maxModelTokens: 1_024,
            maxToolCalls: 0,
            maxTurns: 2,
          },
          idempotencyKey: `typed-output-agent-${suffix}`,
          instructions:
            "Follow the requested output contract exactly. Return concise factual content without tools.",
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
            "Assess whether a durable typed output is useful. Set confidence between zero and one.",
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

        const deadline = Date.now() + options.runTimeoutMs;
        let compactRun: InspectRunResult | undefined;
        while (Date.now() < deadline) {
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
                prompt: "Return the final assessment under the exact requested contract.",
              },
            ],
          },
          manageAgentWorkflowsResultSchema,
        );
        if (!("workflow" in workflowStarted) || !workflowStarted.ok) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Typed Workflow was denied.");
        }
        workflowId = workflowStarted.workflow.workflowId;
        let compactWorkflow: ReturnType<typeof manageAgentWorkflowsResultSchema.parse> | undefined;
        while (Date.now() < deadline) {
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
    action !== "inspect-sandbox" &&
    action !== "recover" &&
    action !== "sandbox" &&
    action !== "schedules" &&
    action !== "typed-output" &&
    action !== "web-research" &&
    action !== "workflow"
  ) {
    process.stderr.write(
      "Usage: crewhelm-live-rehearsal.ts <authorize|inspect-sandbox|recover|sandbox|schedules|typed-output|web-research|workflow> [options]\n",
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
      : action === "inspect-sandbox"
        ? await inspectSandbox({
            ...common,
            runId:
              parsed.values["run-id"] ??
              (() => {
                throw new Error("inspect-sandbox requires run-id.");
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
