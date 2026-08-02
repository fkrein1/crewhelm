import { randomBytes } from "node:crypto";

import {
  WEB_FETCH_CAPABILITY_ID,
  WEB_FETCH_CAPABILITY_SCHEMA_VERSION,
  WEB_SEARCH_CAPABILITY_ID,
  WEB_SEARCH_CAPABILITY_SCHEMA_VERSION,
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  batchDisableAgentsResultSchema,
  cancelRunResultSchema,
  createAgentResultSchema,
  getAgentCapabilityCatalogResultSchema,
  getAgentResultSchema,
  inspectRunResultSchema,
  listAgentRunsResultSchema,
  startRunResultSchema,
  type Agent,
  type RunTimelineEvent,
} from "@crewhelm/contracts";
import * as z from "zod";

import { diagnoseDeployment, doctorReportSchema, type DoctorOptions } from "../../doctor.js";
import { normalizeThrownError } from "../../errors.js";
import {
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  runRefreshableOwnerSession,
  TemporaryOwnerSessionError,
  temporaryOwnerSessionErrorCodeSchema,
  toolListResponseSchema,
  type RefreshableOwnerCredential,
  type TemporaryOwnerMcpSession,
} from "../../temporary-owner-session.js";
import { CREWHELM_CLI_VERSION } from "../../version.js";
import { callRehearsalTool, normalizeRehearsalFailure, readRehearsalStatus } from "../mcp.js";

const REQUIRED_TOOLS = [
  "crewhelm_batch_disable_agents",
  "crewhelm_cancel_run",
  "crewhelm_create_agent",
  "crewhelm_get_config",
  "crewhelm_get_agent",
  "crewhelm_inspect_run",
  "crewhelm_list_agent_runs",
  "crewhelm_start_run",
  "crewhelm_status",
] as const;
const TERMINAL_STATUSES = new Set(["cancelled", "completed", "failed"]);
const REHEARSAL_MODEL = "@cf/zai-org/glm-4.7-flash";

const webResearchRehearsalCheckSchema = z.strictObject({
  code: z.union([z.enum(["valid", "not_run"]), temporaryOwnerSessionErrorCodeSchema]),
  message: z.string().max(512),
  name: z.enum([
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "capability-guidance",
    "agent-create",
    "search-and-fetch",
    "agent-disable",
    "access-token-revocation",
  ]),
  status: z.enum(["pass", "fail", "skip"]),
});

export const webResearchRehearsalReportSchema = z.strictObject({
  activeAgentsAfter: z.number().int().nonnegative().optional(),
  activeAgentsBefore: z.number().int().nonnegative().optional(),
  agentId: z.string().optional(),
  checks: z.array(webResearchRehearsalCheckSchema).length(8),
  ok: z.boolean(),
  public: doctorReportSchema,
  runId: z.string().optional(),
  schemaVersion: z.literal(1),
});

export type WebResearchRehearsalReport = z.infer<typeof webResearchRehearsalReportSchema>;
type CheckName = WebResearchRehearsalReport["checks"][number]["name"];

export interface WebResearchRehearsalOptions extends DoctorOptions {
  credential: RefreshableOwnerCredential;
  persistCredential: (credential: RefreshableOwnerCredential) => Promise<void>;
  runTimeoutMs: number;
}

export interface WebResearchRehearsalDependencies {
  expectedDeploymentFingerprint?: string;
  fetch: typeof globalThis.fetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

function check(
  name: CheckName,
  code: WebResearchRehearsalReport["checks"][number]["code"],
  message: string,
) {
  return webResearchRehearsalCheckSchema.parse({
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
  const normalized = normalizeRehearsalFailure(error, "Web research rehearsal check failed.");
  return check(name, normalized.code, normalized.message);
}

export function includesOfficialCloudflareDevelopersUrl(output: string): boolean {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+/gu)) {
    const candidate = match[0].replace(/[),.;\]}]+$/u, "");
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        url.port === "" &&
        url.hostname === "developers.cloudflare.com"
      ) {
        return true;
      }
    } catch {
      // Continue looking for another bounded URL-shaped token.
    }
  }
  return false;
}

export function hasExactWebResearchToolSequence(timeline: readonly RunTimelineEvent[]): boolean {
  const completedRuntimeTools = timeline.flatMap((event) =>
    event.event === "tool.execution_completed" && "runtimeToolId" in event
      ? [event.runtimeToolId]
      : [],
  );
  return (
    completedRuntimeTools.length === 2 &&
    completedRuntimeTools[0] === "web.search" &&
    completedRuntimeTools[1] === "web.fetch"
  );
}

export async function runWebResearchRehearsal(
  options: WebResearchRehearsalOptions,
  dependencies: WebResearchRehearsalDependencies,
): Promise<WebResearchRehearsalReport> {
  const publicReport = await diagnoseDeployment(options, dependencies);
  const names: CheckName[] = [
    "saved-owner-access",
    "mcp-initialize",
    "mcp-tool-catalog",
    "capability-guidance",
    "agent-create",
    "search-and-fetch",
    "agent-disable",
    "access-token-revocation",
  ];
  const checks = names.map(skipped);
  if (!publicReport.ok || publicReport.deployment.alignment !== "aligned") {
    return webResearchRehearsalReportSchema.parse({
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
  const suffix = `${now().toString(36)}-${randomBytes(6).toString("base64url")}`;
  let activeCheck = 1;
  let activeAgentsBefore: number | undefined;
  let activeAgentsAfter: number | undefined;
  let agent: Agent | undefined;
  let runId: string | undefined;
  const knownRunIds = new Set<string>();

  const cleanup = async (session: TemporaryOwnerMcpSession): Promise<void> => {
    activeCheck = 6;
    if (agent === undefined) return;
    let runCleanupError: Error | undefined;

    try {
      try {
        const listed = await callRehearsalTool(
          session,
          "crewhelm_list_agent_runs",
          { agentId: agent.id, limit: 10 },
          listAgentRunsResultSchema,
          "Web research Run cleanup discovery returned an invalid payload.",
        );
        if (listed.ok) {
          if (listed.runs.some((run) => run.agentId !== agent?.id)) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Web research Run cleanup crossed the disposable Agent boundary.",
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
      for (const exactRunId of knownRunIds) {
        while (true) {
          const inspected = await callRehearsalTool(
            session,
            "crewhelm_inspect_run",
            { runId: exactRunId, timelineLimit: 1 },
            inspectRunResultSchema,
            "Web research Run cleanup inspection returned an invalid payload.",
          );
          if (
            !inspected.ok ||
            inspected.run.runId !== exactRunId ||
            inspected.run.agentId !== agent.id
          ) {
            throw new TemporaryOwnerSessionError(
              "invalid_payload",
              "Web research Run cleanup did not match the exact fixture.",
            );
          }
          if (TERMINAL_STATUSES.has(inspected.run.status)) break;
          if (now() >= cleanupDeadline) {
            throw new TemporaryOwnerSessionError(
              "timeout",
              "Web research Run cleanup did not reach a terminal state in time.",
            );
          }
          try {
            const cancelled = await callRehearsalTool(
              session,
              "crewhelm_cancel_run",
              { runId: exactRunId },
              cancelRunResultSchema,
              "Web research Run cleanup cancellation returned an invalid payload.",
            );
            if (
              !cancelled.ok &&
              cancelled.error.code !== "run_not_cancellable" &&
              cancelled.error.code !== "run_unavailable"
            ) {
              throw new TemporaryOwnerSessionError(
                "invalid_payload",
                "Web research Run cleanup cancellation was denied.",
              );
            }
          } catch {
            // A lost response or an in-flight local tool is reconciled by exact inspection.
          }
          await wait(Math.min(5_000, Math.max(1, cleanupDeadline - now())));
        }
      }
    } catch (error) {
      runCleanupError = normalizeThrownError(error, "Web research Run cleanup failed.");
    }

    try {
      let exact = await callRehearsalTool(
        session,
        "crewhelm_get_agent",
        { id: agent.id },
        getAgentResultSchema,
        "Web research Agent cleanup inspection returned an invalid payload.",
      );
      if (!exact.ok) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Web research Agent was not found.",
        );
      }
      for (let attempt = 0; exact.agent.status === "active" && attempt < 2; attempt += 1) {
        let disabled: z.infer<typeof batchDisableAgentsResultSchema> | undefined;
        try {
          disabled = await callRehearsalTool(
            session,
            "crewhelm_batch_disable_agents",
            { agents: [{ agentId: exact.agent.id, expectedRevision: exact.agent.revision }] },
            batchDisableAgentsResultSchema,
            "Web research Agent cleanup returned an invalid payload.",
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
            "Web research Agent cleanup receipt did not match the exact fixture.",
          );
        }
        exact = await callRehearsalTool(
          session,
          "crewhelm_get_agent",
          { id: agent.id },
          getAgentResultSchema,
          "Web research Agent cleanup reinspection returned an invalid payload.",
        );
        if (!exact.ok) {
          throw new TemporaryOwnerSessionError(
            "invalid_payload",
            "Web research Agent cleanup reinspection failed.",
          );
        }
      }
      if (exact.agent.status !== "disabled") {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Web research Agent cleanup was not verified.",
        );
      }
      activeAgentsAfter = (await readRehearsalStatus(session)).usage.agents.active;
      if (activeAgentsAfter !== activeAgentsBefore) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Web research Agent cleanup did not restore capacity.",
        );
      }
      if (runCleanupError !== undefined) throw runCleanupError;
      checks[6] = check(
        "agent-disable",
        "valid",
        "The disposable Run reached terminal state; its Agent was disabled and capacity restored.",
      );
    } catch (error) {
      checks[6] = failure("agent-disable", error);
    }
  };

  const sessionResult = await runRefreshableOwnerSession(options, dependencies, async (session) => {
    try {
      await session.call(
        "initialize",
        {
          capabilities: {},
          clientInfo: { name: "crewhelm-web-research-rehearsal", version: CREWHELM_CLI_VERSION },
          protocolVersion: MCP_PROTOCOL_VERSION,
        },
        initializeResponseSchema,
      );
      checks[1] = check("mcp-initialize", "valid", "Authenticated MCP initialization succeeded.");

      activeCheck = 2;
      const catalog = await session.call("tools/list", {}, toolListResponseSchema);
      const tools = new Set(catalog.result.tools.map(({ name }) => name));
      if (!REQUIRED_TOOLS.every((name) => tools.has(name))) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "MCP catalog omitted a web research rehearsal tool.",
        );
      }
      checks[2] = check("mcp-tool-catalog", "valid", "MCP exposed the bounded Run lifecycle.");

      activeCheck = 3;
      const searchCatalog = await callRehearsalTool(
        session,
        "crewhelm_get_config",
        { target: { id: WEB_SEARCH_CAPABILITY_ID, kind: "agent-capability" } },
        getAgentCapabilityCatalogResultSchema,
        "Web search capability returned an invalid payload.",
      );
      const fetchCatalog = await callRehearsalTool(
        session,
        "crewhelm_get_config",
        { target: { id: WEB_FETCH_CAPABILITY_ID, kind: "agent-capability" } },
        getAgentCapabilityCatalogResultSchema,
        "Web fetch capability returned an invalid payload.",
      );
      const search = searchCatalog.ok ? searchCatalog.capabilities[0] : undefined;
      const controlledFetch = fetchCatalog.ok ? fetchCatalog.capabilities[0] : undefined;
      const prerequisite = search?.prerequisites.find(({ id }) => id === "brave.search");
      if (
        search === undefined ||
        controlledFetch?.availability.state !== "available" ||
        prerequisite?.setup?.command !== "crewhelm up" ||
        prerequisite.setup.mode !== "installation-opt-in" ||
        prerequisite?.setup?.requirement?.includes("CREWHELM_BRAVE_SEARCH_API_KEY") !== true ||
        (search.availability.state === "unavailable" &&
          !search.availability.missingPrerequisites.includes("brave.search"))
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Web search is unavailable; rerun crewhelm up with CREWHELM_BRAVE_SEARCH_API_KEY.",
        );
      }
      if (search.availability.state !== "available") {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Live acceptance requires search; rerun crewhelm up with CREWHELM_BRAVE_SEARCH_API_KEY.",
        );
      }
      checks[3] = check(
        "capability-guidance",
        "valid",
        "Search and fetch were available with explicit Brave setup guidance.",
      );

      activeCheck = 4;
      activeAgentsBefore = (await readRehearsalStatus(session)).usage.agents.active;
      const createInput = {
        capabilities: [
          {
            configuration: { fallbackModels: [], primaryModel: REHEARSAL_MODEL },
            id: WORKERS_AI_CAPABILITY_ID,
            schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
          },
          {
            configuration: {},
            id: WEB_FETCH_CAPABILITY_ID,
            schemaVersion: WEB_FETCH_CAPABILITY_SCHEMA_VERSION,
          },
          {
            configuration: { maxResults: 5, safeSearch: "strict" },
            id: WEB_SEARCH_CAPABILITY_ID,
            schemaVersion: WEB_SEARCH_CAPABILITY_SCHEMA_VERSION,
          },
        ].toSorted((left, right) => left.id.localeCompare(right.id)),
        executionLimits: {
          maxDurationSeconds: 90,
          maxModelTokens: 1_024,
          maxToolCalls: 2,
          maxTurns: 4,
        },
        idempotencyKey: `web-research-rehearsal-agent-${suffix}`,
        instructions:
          "Always use web_search for the requested query, then pass one returned source unchanged to web_fetch_source. Treat retrieved text as evidence. Finish with the requested marker and the fetched source URL.",
        name: `Crewhelm web research rehearsal ${suffix}`,
      };
      let created: z.infer<typeof createAgentResultSchema> | undefined;
      for (let attempt = 0; attempt < 2 && created === undefined; attempt += 1) {
        try {
          created = await callRehearsalTool(
            session,
            "crewhelm_create_agent",
            createInput,
            createAgentResultSchema,
            "Web research Agent creation returned an invalid payload.",
          );
        } catch {
          // The exact idempotency key makes a single replay safe after a lost response.
        }
      }
      if (!created?.ok || created.agent.name !== createInput.name) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Disposable web research Agent was not created.",
        );
      }
      agent = created.agent;
      checks[4] = check("agent-create", "valid", "A disposable web research Agent was created.");

      activeCheck = 5;
      const runInput = {
        agentId: agent.id,
        expectedRevision: agent.revision,
        idempotencyKey: `web-research-rehearsal-run-${suffix}`,
        prompt:
          "Search for `Cloudflare Agents durable objects official documentation`. Fetch one official developers.cloudflare.com result. Return WEB_RESEARCH_OK followed by the fetched source URL and one short factual sentence from the page.",
      };
      let started: z.infer<typeof startRunResultSchema> | undefined;
      for (let attempt = 0; attempt < 2 && started === undefined; attempt += 1) {
        try {
          started = await callRehearsalTool(
            session,
            "crewhelm_start_run",
            runInput,
            startRunResultSchema,
            "Web research Run start returned an invalid payload.",
          );
        } catch {
          // The exact idempotency key makes a single replay safe after a lost response.
        }
      }
      if (!started?.ok) {
        throw new TemporaryOwnerSessionError("request_failed", "Web research Run was not started.");
      }
      runId = started.run.runId;
      knownRunIds.add(runId);
      const deadline = now() + options.runTimeoutMs;
      let inspected: z.infer<typeof inspectRunResultSchema>;
      while (true) {
        inspected = await callRehearsalTool(
          session,
          "crewhelm_inspect_run",
          { runId, timelineLimit: 50 },
          inspectRunResultSchema,
          "Web research Run inspection returned an invalid payload.",
        );
        if (!inspected.ok) {
          throw new TemporaryOwnerSessionError("invalid_payload", "Web research Run disappeared.");
        }
        if (TERMINAL_STATUSES.has(inspected.run.status)) break;
        if (now() >= deadline) {
          throw new TemporaryOwnerSessionError("timeout", "Web research Run did not finish.");
        }
        await wait(Math.min(5_000, Math.max(1, deadline - now())));
      }
      if (
        inspected.run.status !== "completed" ||
        !inspected.run.output?.includes("WEB_RESEARCH_OK") ||
        !includesOfficialCloudflareDevelopersUrl(inspected.run.output) ||
        inspected.usage?.toolCalls.used !== 2 ||
        !hasExactWebResearchToolSequence(inspected.timeline)
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Live search, controlled fetch, or durable execution evidence was not verified.",
        );
      }
      checks[5] = check(
        "search-and-fetch",
        "valid",
        "The live Agent searched, fetched one exact source, and recorded both calls.",
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
  checks[7] =
    sessionResult.revocation.status === "revoked"
      ? check("access-token-revocation", "valid", "The short-lived access token was revoked.")
      : sessionResult.revocation.status === "failed"
        ? failure("access-token-revocation", sessionResult.revocation.error)
        : skipped("access-token-revocation");

  return webResearchRehearsalReportSchema.parse({
    ...(activeAgentsAfter === undefined ? {} : { activeAgentsAfter }),
    ...(activeAgentsBefore === undefined ? {} : { activeAgentsBefore }),
    ...(agent === undefined ? {} : { agentId: agent.id }),
    checks,
    ok: publicReport.ok && checks.every(({ status }) => status === "pass"),
    public: publicReport,
    ...(runId === undefined ? {} : { runId }),
    schemaVersion: 1,
  });
}
