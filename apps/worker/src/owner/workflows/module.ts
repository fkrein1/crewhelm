import {
  MAXIMUM_ACTIVE_AGENT_WORKFLOWS_PER_OWNER,
  MAXIMUM_AGENT_WORKFLOWS_PER_OWNER,
  agentTaskWorkflowParamsSchema,
  agentWorkflowAggregateBudgetSchema,
  agentWorkflowIdSchema,
  agentWorkflowSchema,
  agentWorkflowStageSummarySchema,
  agentWorkflowSummarySchema,
  cancelAgentWorkflowInputSchema,
  cancelAgentWorkflowResultSchema,
  completeAgentWorkflowStageInputSchema,
  completeAgentWorkflowStageResultSchema,
  continuationFromRunSession,
  crewAgentObjectName,
  deleteAgentWorkflowInputSchema,
  deleteAgentWorkflowResultSchema,
  dispatchAgentWorkflowStageInputSchema,
  dispatchAgentWorkflowStageResultSchema,
  inspectAgentWorkflowInputSchema,
  inspectAgentWorkflowResultSchema,
  listAgentWorkflowsInputSchema,
  listAgentWorkflowsResultSchema,
  runPromptSchema,
  runIdSchema,
  startAgentWorkflowInputSchema,
  startAgentWorkflowResultSchema,
  type AgentWorkflowStatus,
  type AgentWorkflowSummary,
  type CancelAgentWorkflowResult,
  type CompleteAgentWorkflowStageResult,
  type DeleteAgentWorkflowResult,
  type DispatchAgentWorkflowStageResult,
  type FleetConfiguration,
  type InspectAgentWorkflowResult,
  type ListAgentWorkflowsResult,
  type OwnerAuthority,
  type StartAgentWorkflowInput,
  type StartAgentWorkflowResult,
} from "@crewhelm/contracts";
import { and, asc, count, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import * as z from "zod";

import { digestRunPrompt } from "../../agent/admitted-runs/index.js";
import type { CrewAgent } from "../../agent/session-directory.js";
import type { AgentChannel } from "../agent-channel/index.js";
import {
  agentRevisions,
  agents,
  agentWorkflowDeletions,
  agentWorkflowStages,
  agentWorkflows,
  auditEvents,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type FailureCode = Extract<StartAgentWorkflowResult, { ok: false }>["error"]["code"];
type StoredWorkflow = typeof agentWorkflows.$inferSelect;
type StoredStage = typeof agentWorkflowStages.$inferSelect;
type StoredFailureCode = NonNullable<StoredWorkflow["failureCode"]>;

const ACTIVE_WORKFLOW_STATUSES = [
  "queued",
  "running",
  "waiting",
  "cancelling",
] as const satisfies readonly AgentWorkflowStatus[];
const TERMINAL_WORKFLOW_STATUSES = ["completed", "failed", "cancelled"] as const;
const RECOVERY_DELAY_MS = 5_000;
const WORKFLOW_DELETION_INTENT_PREFIX = "crewhelm:agent-workflow-deletion:";

const workflowDeletionIntentSchema = z.strictObject({
  clientId: z.string().min(1),
  expectedRevision: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(128),
  workflowId: agentWorkflowIdSchema,
});
type WorkflowDeletionIntent = z.infer<typeof workflowDeletionIntentSchema>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function requestDigest(input: StartAgentWorkflowInput): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

function workflowId(): string {
  return agentWorkflowIdSchema.parse(`workflow_${crypto.randomUUID()}`);
}

function workflowDeletionIntentKey(id: string): string {
  return `${WORKFLOW_DELETION_INTENT_PREFIX}${id}`;
}

function denied(code: FailureCode): Extract<StartAgentWorkflowResult, { ok: false }> {
  return { error: { code, message: "Agent workflow request denied." }, ok: false };
}

function admittedStagePrompt(
  objective: string,
  stageCount: number,
  stage: Pick<StoredStage, "name" | "prompt" | "stageIndex">,
): string {
  return runPromptSchema.parse(
    [
      "Workflow objective:",
      objective,
      "",
      `Stage ${stage.stageIndex + 1}/${stageCount} — ${stage.name}:`,
      stage.prompt,
    ].join("\n"),
  );
}

function failureNextAction(code: StoredFailureCode) {
  if (code === "run_failed") return "inspect_run" as const;
  if (code === "agent_unavailable" || code === "revision_conflict") {
    return "review_agent" as const;
  }
  return "inspect_workflow" as const;
}

function isTerminalWorkflowStatus(
  status: AgentWorkflowStatus,
): status is (typeof TERMINAL_WORKFLOW_STATUSES)[number] {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function stageProjection(stage: StoredStage, includePrompt: boolean) {
  return agentWorkflowStageSummarySchema.parse({
    completedAt: stage.completedAt === null ? null : new Date(stage.completedAt).toISOString(),
    index: stage.stageIndex,
    name: stage.name,
    ...(includePrompt ? { prompt: stage.prompt } : {}),
    runId: stage.runId,
    startedAt: stage.startedAt === null ? null : new Date(stage.startedAt).toISOString(),
    status: stage.status,
  });
}

export class AgentWorkflows {
  readonly #agentChannel: AgentChannel;
  readonly #crewAgents: DurableObjectNamespace<CrewAgent>;
  readonly #currentFleetConfiguration: () => FleetConfiguration;
  readonly #database: Database;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;

  constructor(
    objectName: string | undefined,
    database: Database,
    storage: DurableObjectStorage,
    crewAgents: DurableObjectNamespace<CrewAgent>,
    agentChannel: AgentChannel,
    currentFleetConfiguration: () => FleetConfiguration,
  ) {
    this.#agentChannel = agentChannel;
    this.#crewAgents = crewAgents;
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#objectName = objectName;
    this.#storage = storage;
  }

  async start(authority: OwnerAuthority, input: unknown): Promise<StartAgentWorkflowResult> {
    const request = startAgentWorkflowInputSchema.safeParse(input);

    if (!request.success || this.#objectName === undefined) {
      return denied("invalid_request");
    }

    const digest = await requestDigest(request.data);
    const promptDigests = await Promise.all(
      request.data.stages.map((stage, stageIndex) =>
        digestRunPrompt(
          admittedStagePrompt(request.data.objective, request.data.stages.length, {
            ...stage,
            stageIndex,
          }),
        ),
      ),
    );
    const currentTime = Date.now();
    const fleet = this.#currentFleetConfiguration();
    const result = this.#database.transaction((transaction) => {
      const replay = transaction
        .select()
        .from(agentWorkflows)
        .where(
          and(
            eq(agentWorkflows.clientId, authority.clientId),
            eq(agentWorkflows.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .get();

      if (replay !== undefined) {
        return replay.requestDigest === digest
          ? { created: false as const, row: replay }
          : denied("idempotency_conflict");
      }

      const deletedReplay = transaction
        .select()
        .from(agentWorkflowDeletions)
        .where(
          and(
            eq(agentWorkflowDeletions.startClientId, authority.clientId),
            eq(agentWorkflowDeletions.startIdempotencyKey, request.data.idempotencyKey),
          ),
        )
        .get();

      if (deletedReplay !== undefined) {
        return denied(
          deletedReplay.startRequestDigest === digest ? "workflow_deleted" : "idempotency_conflict",
        );
      }

      const agent = transaction
        .select({
          currentRevision: agents.currentRevision,
          executionLimits: agentRevisions.executionLimits,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agents.agentId),
            eq(agentRevisions.revision, agents.currentRevision),
          ),
        )
        .where(eq(agents.agentId, request.data.agentId))
        .get();

      if (agent === undefined) {
        return denied("agent_not_found");
      }

      if (agent.currentRevision !== request.data.expectedRevision) {
        return denied("revision_conflict");
      }

      if (agent.status !== "active") {
        return denied("agent_unavailable");
      }

      const total = transaction.select({ value: count() }).from(agentWorkflows).get()?.value ?? 0;
      const active =
        transaction
          .select({ value: count() })
          .from(agentWorkflows)
          .where(inArray(agentWorkflows.status, [...ACTIVE_WORKFLOW_STATUSES]))
          .get()?.value ?? 0;

      if (
        total >= MAXIMUM_AGENT_WORKFLOWS_PER_OWNER ||
        active >= MAXIMUM_ACTIVE_AGENT_WORKFLOWS_PER_OWNER
      ) {
        return denied("admission_limit_exceeded");
      }

      const stageCount = request.data.stages.length;
      const effective = {
        maxDurationSeconds: Math.min(
          agent.executionLimits.maxDurationSeconds,
          fleet.data.execution.maxDurationSeconds,
        ),
        maxModelTokens: Math.min(
          agent.executionLimits.maxModelTokens,
          fleet.data.execution.maxModelTokens,
        ),
        maxToolCalls: Math.min(
          agent.executionLimits.maxToolCalls,
          fleet.data.execution.maxToolCalls,
          fleet.data.integrations.maxCallsPerRun,
        ),
        maxTurns: Math.min(agent.executionLimits.maxTurns, fleet.data.execution.maxTurns),
      };
      const budget = agentWorkflowAggregateBudgetSchema.parse({
        maxDurationSeconds: effective.maxDurationSeconds * stageCount,
        maxModelTokens: effective.maxModelTokens * stageCount,
        maxToolCalls: effective.maxToolCalls * stageCount,
        maxTurns: effective.maxTurns * stageCount,
      });
      const id = workflowId();
      const cleanupAt = currentTime + fleet.data.retention.inboxSeconds * 1_000;

      transaction
        .insert(agentWorkflows)
        .values({
          agentId: request.data.agentId,
          agentRevision: agent.currentRevision,
          budget,
          cleanupAt,
          clientId: authority.clientId,
          completedStages: 0,
          createdAt: currentTime,
          fleetRevision: fleet.revision,
          idempotencyKey: request.data.idempotencyKey,
          objective: request.data.objective,
          requestDigest: digest,
          stageCount,
          status: "queued",
          updatedAt: currentTime,
          workflowId: id,
          workflowRevision: 1,
        })
        .run();
      transaction
        .insert(agentWorkflowStages)
        .values(
          request.data.stages.map((stage, stageIndex) => ({
            name: stage.name,
            prompt: stage.prompt,
            promptDigest: promptDigests[stageIndex] ?? "",
            stageIndex,
            status: "pending" as const,
            workflowId: id,
          })),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "workflow.created",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: id,
        })
        .run();

      const row = transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, id))
        .get();
      if (row === undefined) {
        throw new Error("Workflow creation was not durable.");
      }
      return { created: true as const, row };
    });

    if ("error" in result) {
      return result;
    }

    await this.#scheduleRecovery(result.row.cleanupAt);
    await this.#ensureStarted(result.row);
    const current = this.#workflow(result.row.workflowId) ?? result.row;
    return startAgentWorkflowResultSchema.parse({
      created: result.created,
      ok: true,
      workflow: this.#summary(current),
    });
  }

  list(input: unknown): ListAgentWorkflowsResult {
    const request = listAgentWorkflowsInputSchema.safeParse(input);
    if (!request.success) {
      return {
        error: { code: "invalid_request", message: "Agent workflow request denied." },
        ok: false,
      };
    }

    if (
      request.data.agentId !== undefined &&
      this.#database
        .select({ id: agents.agentId })
        .from(agents)
        .where(eq(agents.agentId, request.data.agentId))
        .get() === undefined
    ) {
      return {
        error: { code: "agent_not_found", message: "Agent workflow request denied." },
        ok: false,
      };
    }

    const filters = [
      request.data.agentId === undefined
        ? undefined
        : eq(agentWorkflows.agentId, request.data.agentId),
      request.data.cursor === undefined
        ? undefined
        : gt(agentWorkflows.workflowId, request.data.cursor),
      request.data.status === undefined
        ? undefined
        : request.data.status === "active"
          ? inArray(agentWorkflows.status, [...ACTIVE_WORKFLOW_STATUSES])
          : eq(agentWorkflows.status, request.data.status),
    ].filter((filter) => filter !== undefined);
    const rows = this.#database
      .select()
      .from(agentWorkflows)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(asc(agentWorkflows.workflowId))
      .limit(request.data.limit + 1)
      .all();
    const page = rows.slice(0, request.data.limit);

    return listAgentWorkflowsResultSchema.parse({
      nextCursor: rows.length > page.length ? (page.at(-1)?.workflowId ?? null) : null,
      ok: true,
      workflows: page.map((row) => this.#summary(row)),
    });
  }

  inspect(input: unknown): InspectAgentWorkflowResult {
    const request = inspectAgentWorkflowInputSchema.safeParse(input);
    if (!request.success) {
      return {
        error: { code: "invalid_request", message: "Agent workflow request denied." },
        ok: false,
      };
    }

    const row = this.#database
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.workflowId, request.data.workflowId))
      .get();
    if (row === undefined) {
      return {
        error: { code: "workflow_not_found", message: "Agent workflow request denied." },
        ok: false,
      };
    }
    const stages = this.#stages(row.workflowId);

    return inspectAgentWorkflowResultSchema.parse({
      ok: true,
      workflow: agentWorkflowSchema.parse({
        ...this.#summary(row),
        objective: row.objective,
        session: row.session,
        stages: stages.map((stage) => stageProjection(stage, request.data.includePrompts)),
      }),
    });
  }

  async dispatch(input: unknown): Promise<DispatchAgentWorkflowStageResult> {
    const request = dispatchAgentWorkflowStageInputSchema.safeParse(input);
    if (!request.success || this.#objectName === undefined) {
      return dispatchAgentWorkflowStageResultSchema.parse(denied("invalid_request"));
    }

    let row = this.#workflow(request.data.workflowId);
    if (row === undefined || row.agentId !== request.data.agentId) {
      return dispatchAgentWorkflowStageResultSchema.parse(denied("workflow_not_found"));
    }
    const stage = this.#stage(row.workflowId, request.data.stageIndex);
    if (stage === undefined) {
      return dispatchAgentWorkflowStageResultSchema.parse(denied("invalid_request"));
    }

    if (stage.runId !== null && row.session !== null) {
      const attached = await this.#agent(row).attachAgentTaskWorkflowRun({
        agentId: row.agentId,
        ownerKey: this.#objectName,
        runId: stage.runId,
        session: row.session,
        stageIndex: stage.stageIndex,
        workflowId: row.workflowId,
      });
      if (!attached) {
        throw new Error("Workflow run completion routing is unavailable.");
      }
      const status = stage.status === "waiting" ? "running" : stage.status;
      return dispatchAgentWorkflowStageResultSchema.parse({
        ok: true,
        runId: stage.runId,
        session: row.session,
        status,
      });
    }

    if (
      !["queued", "running"].includes(row.status) ||
      row.cancellationRequestedAt !== null ||
      row.completedStages !== request.data.stageIndex ||
      stage.status !== "pending" ||
      row.currentRunId !== null ||
      (row.currentStageIndex !== null && row.currentStageIndex !== stage.stageIndex)
    ) {
      return dispatchAgentWorkflowStageResultSchema.parse(denied("workflow_busy"));
    }

    const currentAgent = this.#database
      .select({ revision: agents.currentRevision, status: agents.status })
      .from(agents)
      .where(eq(agents.agentId, row.agentId))
      .get();
    if (
      currentAgent?.revision !== row.agentRevision ||
      currentAgent.status !== "active" ||
      this.#currentFleetConfiguration().revision !== row.fleetRevision
    ) {
      this.#failBeforeDispatch(row, stage, "revision_conflict");
      await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
      return dispatchAgentWorkflowStageResultSchema.parse(denied("revision_conflict"));
    }

    const workflowIdToReserve = row.workflowId;
    const reserved = this.#database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, workflowIdToReserve))
        .get();
      const currentStage = transaction
        .select()
        .from(agentWorkflowStages)
        .where(
          and(
            eq(agentWorkflowStages.workflowId, workflowIdToReserve),
            eq(agentWorkflowStages.stageIndex, stage.stageIndex),
          ),
        )
        .get();

      if (
        current === undefined ||
        currentStage?.status !== "pending" ||
        currentStage.runId !== null ||
        current.cancellationRequestedAt !== null ||
        !["queued", "running"].includes(current.status) ||
        current.completedStages !== stage.stageIndex ||
        current.currentRunId !== null ||
        (current.currentStageIndex !== null && current.currentStageIndex !== stage.stageIndex)
      ) {
        return undefined;
      }

      if (current.currentStageIndex === null) {
        transaction
          .update(agentWorkflows)
          .set({
            currentStageIndex: stage.stageIndex,
            status: "running",
            updatedAt: Date.now(),
            workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
          })
          .where(eq(agentWorkflows.workflowId, current.workflowId))
          .run();
      }

      return transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, current.workflowId))
        .get();
    });

    if (reserved === undefined) {
      return dispatchAgentWorkflowStageResultSchema.parse(denied("workflow_busy"));
    }
    row = reserved;

    const authority = this.#runtimeAuthority(row);
    const started = await this.#agentChannel.start(
      authority,
      {
        agentId: row.agentId,
        ...(row.session === null ? {} : { continuation: continuationFromRunSession(row.session) }),
        expectedRevision: row.agentRevision,
        idempotencyKey: `workflow.${row.workflowId}.${stage.stageIndex}`,
        prompt: admittedStagePrompt(row.objective, row.stageCount, stage),
      },
      "workflow",
      null,
      row.fleetRevision,
    );

    if (!started.ok) {
      const code: FailureCode =
        started.error.code === "branch_revision_conflict"
          ? "revision_conflict"
          : started.error.code === "session_busy"
            ? "workflow_busy"
            : started.error.code === "run_unavailable" || started.error.code === "session_not_found"
              ? "workflow_unavailable"
              : started.error.code;
      if (code !== "workflow_unavailable" && code !== "workflow_busy") {
        this.#failBeforeDispatch(row, stage, code);
        await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
      } else {
        const cancelled = this.#releaseDispatchReservation(row, stage);
        if (cancelled) await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
      }
      return dispatchAgentWorkflowStageResultSchema.parse(denied(code));
    }

    if (started.run.session === undefined) {
      this.#failBeforeDispatch(row, stage, "workflow_unavailable");
      await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
      return dispatchAgentWorkflowStageResultSchema.parse(denied("workflow_unavailable"));
    }

    const updatedAt = Date.now();
    const claimed = this.#database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .get();
      const currentStage = transaction
        .select()
        .from(agentWorkflowStages)
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, stage.stageIndex),
          ),
        )
        .get();

      if (
        current === undefined ||
        currentStage === undefined ||
        current.currentStageIndex !== stage.stageIndex ||
        current.currentRunId !== null ||
        currentStage.runId !== null ||
        currentStage.status !== "pending" ||
        !["running", "cancelling"].includes(current.status)
      ) {
        return false;
      }

      transaction
        .update(agentWorkflowStages)
        .set({ runId: started.run.runId, startedAt: updatedAt, status: "running" })
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, stage.stageIndex),
            eq(agentWorkflowStages.status, "pending"),
          ),
        )
        .run();
      transaction
        .update(agentWorkflows)
        .set({
          currentRunId: started.run.runId,
          session: started.run.session,
          status: current.status,
          updatedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .run();
      return true;
    });

    if (!claimed) {
      await this.#agentChannel.cancel(authority, { runId: started.run.runId });
      return dispatchAgentWorkflowStageResultSchema.parse(denied("workflow_unavailable"));
    }

    const attached = await this.#agent(row).attachAgentTaskWorkflowRun({
      agentId: row.agentId,
      ownerKey: this.#objectName,
      runId: started.run.runId,
      session: started.run.session,
      stageIndex: stage.stageIndex,
      workflowId: row.workflowId,
    });
    if (!attached) {
      throw new Error("Workflow run completion routing is unavailable.");
    }

    const current = this.#workflow(row.workflowId);
    if (
      current !== undefined &&
      current.cancellationRequestedAt !== null &&
      current.currentRunId === started.run.runId
    ) {
      await this.#agentChannel.cancel(this.#runtimeAuthority(current), {
        runId: started.run.runId,
      });
    }

    return dispatchAgentWorkflowStageResultSchema.parse({
      ok: true,
      runId: started.run.runId,
      session: started.run.session,
      status: started.run.status,
    });
  }

  async complete(input: unknown): Promise<CompleteAgentWorkflowStageResult> {
    const request = completeAgentWorkflowStageInputSchema.safeParse(input);
    if (!request.success || this.#objectName === undefined) {
      return completeAgentWorkflowStageResultSchema.parse(denied("invalid_request"));
    }
    const row = this.#workflow(request.data.workflowId);
    const stage = this.#stage(request.data.workflowId, request.data.stageIndex);
    if (
      row === undefined ||
      stage === undefined ||
      row.agentId !== request.data.agentId ||
      stage.runId !== request.data.runId
    ) {
      return completeAgentWorkflowStageResultSchema.parse(denied("workflow_not_found"));
    }

    if (isTerminalWorkflowStatus(row.status)) {
      const stageStatus =
        stage.status === "completed"
          ? "completed"
          : stage.status === "cancelled"
            ? "cancelled"
            : "failed";
      return completeAgentWorkflowStageResultSchema.parse({
        ok: true,
        status: stageStatus,
        workflowStatus: row.status,
      });
    }

    if (row.currentRunId !== request.data.runId) {
      return completeAgentWorkflowStageResultSchema.parse(denied("workflow_not_found"));
    }

    const inspected = await this.#agentChannel.inspect(this.#runtimeAuthority(row), {
      includeUsage: false,
      runId: request.data.runId,
      timelineLimit: 1,
    });
    if (!inspected.ok) {
      return completeAgentWorkflowStageResultSchema.parse(denied("workflow_unavailable"));
    }
    if (!isTerminalWorkflowStatus(inspected.run.status)) {
      return completeAgentWorkflowStageResultSchema.parse(denied("workflow_busy"));
    }

    const runStatus = inspected.run.status;
    const finalized = this.#database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .get();
      const currentStage = transaction
        .select()
        .from(agentWorkflowStages)
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, stage.stageIndex),
          ),
        )
        .get();
      if (current === undefined || currentStage?.runId !== request.data.runId) return undefined;
      if (isTerminalWorkflowStatus(current.status)) {
        return {
          status:
            currentStage.status === "completed"
              ? ("completed" as const)
              : currentStage.status === "cancelled"
                ? ("cancelled" as const)
                : ("failed" as const),
          workflowStatus: current.status,
        };
      }
      if (current.currentRunId !== request.data.runId) return undefined;

      const cancelled = current.cancellationRequestedAt !== null || runStatus === "cancelled";
      const workflowStatus: AgentWorkflowStatus = cancelled
        ? "cancelled"
        : runStatus === "failed"
          ? "failed"
          : stage.stageIndex === current.stageCount - 1
            ? "completed"
            : "running";
      const completedAt = isTerminalWorkflowStatus(workflowStatus) ? Date.now() : null;
      const stageStatus = cancelled ? "cancelled" : runStatus;
      const updatedAt = Date.now();

      transaction
        .update(agentWorkflowStages)
        .set({ completedAt: updatedAt, status: stageStatus })
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, stage.stageIndex),
            inArray(agentWorkflowStages.status, ["running", "waiting"]),
          ),
        )
        .run();
      transaction
        .update(agentWorkflows)
        .set({
          completedAt,
          completedStages: current.completedStages + (stageStatus === "completed" ? 1 : 0),
          currentRunId: null,
          currentStageIndex: null,
          failureCode: runStatus === "failed" ? "run_failed" : null,
          failureStageIndex: runStatus === "failed" ? stage.stageIndex : null,
          status: workflowStatus,
          updatedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: `workflow.stage_${stageStatus}`,
          clientId: "crewhelm:workflow",
          occurredAt: updatedAt,
          subjectId: row.workflowId,
        })
        .run();
      return { status: stageStatus, workflowStatus };
    });

    if (finalized === undefined) {
      return completeAgentWorkflowStageResultSchema.parse(denied("workflow_busy"));
    }
    if (isTerminalWorkflowStatus(finalized.workflowStatus)) {
      await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
    }

    return completeAgentWorkflowStageResultSchema.parse({
      ok: true,
      ...finalized,
    });
  }

  async cancel(authority: OwnerAuthority, input: unknown): Promise<CancelAgentWorkflowResult> {
    const request = cancelAgentWorkflowInputSchema.safeParse(input);
    if (!request.success) {
      return cancelAgentWorkflowResultSchema.parse(denied("invalid_request"));
    }
    const stored = this.#workflow(request.data.workflowId);
    if (stored === undefined) {
      return cancelAgentWorkflowResultSchema.parse(denied("workflow_not_found"));
    }
    let row: StoredWorkflow = stored;
    if (row.status === "cancelled") {
      return cancelAgentWorkflowResultSchema.parse({
        cancelled: true,
        ok: true,
        workflow: this.#summary(row),
      });
    }
    if (isTerminalWorkflowStatus(row.status)) {
      return cancelAgentWorkflowResultSchema.parse(denied("workflow_busy"));
    }
    if (row.workflowRevision !== request.data.expectedRevision) {
      return cancelAgentWorkflowResultSchema.parse(denied("revision_conflict"));
    }

    const requestedAt = Date.now();
    this.#database
      .update(agentWorkflows)
      .set({
        cancellationRequestedAt: requestedAt,
        status: "cancelling",
        updatedAt: requestedAt,
        workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
      })
      .where(
        and(
          eq(agentWorkflows.workflowId, row.workflowId),
          eq(agentWorkflows.workflowRevision, row.workflowRevision),
        ),
      )
      .run();
    const cancelling = this.#workflow(row.workflowId);
    if (cancelling === undefined) {
      return cancelAgentWorkflowResultSchema.parse(denied("workflow_unavailable"));
    }
    row = cancelling;

    let cancelled = row.currentRunId === null && row.currentStageIndex === null;
    if (row.currentRunId !== null) {
      const runCancellation = await this.#agentChannel.cancel(this.#runtimeAuthority(row), {
        runId: row.currentRunId,
      });
      cancelled = runCancellation.ok && runCancellation.cancelled;
    }

    if (cancelled) {
      const completedAt = Date.now();
      this.#database.transaction((transaction) => {
        if (row.currentStageIndex !== null) {
          transaction
            .update(agentWorkflowStages)
            .set({ completedAt, status: "cancelled" })
            .where(
              and(
                eq(agentWorkflowStages.workflowId, row.workflowId),
                eq(agentWorkflowStages.stageIndex, row.currentStageIndex),
                inArray(agentWorkflowStages.status, ["running", "waiting"]),
              ),
            )
            .run();
        }
        transaction
          .update(agentWorkflows)
          .set({
            completedAt,
            currentRunId: null,
            currentStageIndex: null,
            status: "cancelled",
            updatedAt: completedAt,
            workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
          })
          .where(eq(agentWorkflows.workflowId, row.workflowId))
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "workflow.cancelled",
            clientId: authority.clientId,
            occurredAt: completedAt,
            subjectId: row.workflowId,
          })
          .run();
      });
      await this.#agent(row).cancelAgentTaskWorkflow({
        ownerKey: authority.ownerKey,
        workflowId: row.workflowId,
      });
      const completed = this.#workflow(row.workflowId);
      if (completed === undefined) {
        return cancelAgentWorkflowResultSchema.parse(denied("workflow_unavailable"));
      }
      row = completed;
      await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
    }

    return cancelAgentWorkflowResultSchema.parse({
      cancelled,
      ok: true,
      workflow: this.#summary(row),
    });
  }

  async delete(authority: OwnerAuthority, input: unknown): Promise<DeleteAgentWorkflowResult> {
    const request = deleteAgentWorkflowInputSchema.safeParse(input);
    if (!request.success) {
      return deleteAgentWorkflowResultSchema.parse(denied("invalid_request"));
    }
    const prior = this.#database
      .select()
      .from(agentWorkflowDeletions)
      .where(
        and(
          eq(agentWorkflowDeletions.clientId, authority.clientId),
          eq(agentWorkflowDeletions.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();
    if (prior !== undefined) {
      return deleteAgentWorkflowResultSchema.parse(
        prior.workflowId === request.data.workflowId &&
          prior.expectedRevision === request.data.expectedRevision
          ? { deleted: true, ok: true, workflowId: prior.workflowId }
          : denied("idempotency_conflict"),
      );
    }
    const intentKey = workflowDeletionIntentKey(request.data.workflowId);
    const row = this.#workflow(request.data.workflowId);
    if (row === undefined) {
      return deleteAgentWorkflowResultSchema.parse(denied("workflow_not_found"));
    }
    if (row.workflowRevision !== request.data.expectedRevision) {
      return deleteAgentWorkflowResultSchema.parse(denied("revision_conflict"));
    }
    if (!isTerminalWorkflowStatus(row.status)) {
      return deleteAgentWorkflowResultSchema.parse(denied("workflow_busy"));
    }

    const proposed = workflowDeletionIntentSchema.parse({
      clientId: authority.clientId,
      expectedRevision: request.data.expectedRevision,
      idempotencyKey: request.data.idempotencyKey,
      workflowId: request.data.workflowId,
    });
    const intent = await this.#storage.transaction(async (storage) => {
      const raw = await storage.get(intentKey);
      if (raw === undefined) {
        await storage.put(intentKey, proposed);
        return proposed;
      }
      const parsed = workflowDeletionIntentSchema.safeParse(raw);
      return parsed.success ? parsed.data : undefined;
    });
    if (intent === undefined) {
      return deleteAgentWorkflowResultSchema.parse(denied("workflow_unavailable"));
    }
    if (
      intent.clientId !== authority.clientId ||
      intent.idempotencyKey !== request.data.idempotencyKey ||
      intent.expectedRevision !== request.data.expectedRevision
    ) {
      return deleteAgentWorkflowResultSchema.parse(denied("workflow_busy"));
    }

    this.#database
      .update(agentWorkflows)
      .set({ deletingAt: row.deletingAt ?? Date.now() })
      .where(eq(agentWorkflows.workflowId, row.workflowId))
      .run();
    await this.#scheduleRecovery(Date.now() + RECOVERY_DELAY_MS);

    if (!(await this.#finishDeletion(intent, row))) {
      return deleteAgentWorkflowResultSchema.parse(denied("workflow_unavailable"));
    }

    return deleteAgentWorkflowResultSchema.parse({
      deleted: true,
      ok: true,
      workflowId: row.workflowId,
    });
  }

  markWaiting(input: unknown): boolean {
    const request = dispatchAgentWorkflowStageInputSchema
      .extend({ runId: runIdSchema })
      .safeParse(input);
    if (!request.success) return false;
    const row = this.#workflow(request.data.workflowId);
    if (
      row?.currentRunId !== request.data.runId ||
      row.currentStageIndex !== request.data.stageIndex ||
      row.status !== "running"
    )
      return false;
    const updatedAt = Date.now();
    this.#database.transaction((transaction) => {
      transaction
        .update(agentWorkflowStages)
        .set({ status: "waiting" })
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, request.data.stageIndex),
            eq(agentWorkflowStages.status, "running"),
          ),
        )
        .run();
      transaction
        .update(agentWorkflows)
        .set({
          status: "waiting",
          updatedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(
          and(
            eq(agentWorkflows.workflowId, row.workflowId),
            eq(agentWorkflows.workflowRevision, row.workflowRevision),
          ),
        )
        .run();
    });
    return true;
  }

  verifyRuntime(input: unknown): boolean {
    const request = agentTaskWorkflowParamsSchema.omit({ ownerKey: true }).safeParse(input);
    if (!request.success) return false;
    const row = this.#workflow(request.data.workflowId);
    return (
      row !== undefined &&
      row.agentId === request.data.agentId &&
      row.stageCount === request.data.stageCount &&
      !isTerminalWorkflowStatus(row.status)
    );
  }

  async failRuntime(input: unknown): Promise<boolean> {
    const request = agentTaskWorkflowParamsSchema
      .pick({ agentId: true, workflowId: true })
      .safeParse(input);
    if (!request.success) return false;
    const row = this.#workflow(request.data.workflowId);
    if (row === undefined || row.agentId !== request.data.agentId) return false;
    if (isTerminalWorkflowStatus(row.status)) {
      return true;
    }

    const completedAt = Date.now();
    const failureStageIndex =
      row.currentStageIndex ?? Math.min(row.completedStages, row.stageCount - 1);
    const cancelled = row.cancellationRequestedAt !== null;
    this.#database.transaction((transaction) => {
      transaction
        .update(agentWorkflowStages)
        .set({ completedAt, status: cancelled ? "cancelled" : "failed" })
        .where(
          and(
            eq(agentWorkflowStages.workflowId, row.workflowId),
            eq(agentWorkflowStages.stageIndex, failureStageIndex),
            cancelled
              ? inArray(agentWorkflowStages.status, ["running", "waiting"])
              : inArray(agentWorkflowStages.status, ["pending", "running", "waiting"]),
          ),
        )
        .run();
      transaction
        .update(agentWorkflows)
        .set({
          completedAt,
          currentRunId: null,
          currentStageIndex: null,
          failureCode: cancelled ? null : "coordinator_failed",
          failureStageIndex: cancelled ? null : failureStageIndex,
          status: cancelled ? "cancelled" : "failed",
          updatedAt: completedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(
          and(
            eq(agentWorkflows.workflowId, row.workflowId),
            eq(agentWorkflows.workflowRevision, row.workflowRevision),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: cancelled ? "workflow.cancelled" : "workflow.coordinator_failed",
          clientId: "crewhelm:workflow",
          occurredAt: completedAt,
          subjectId: row.workflowId,
        })
        .run();
    });
    await this.#scheduleRecovery(Math.max(row.cleanupAt, Date.now()));
    return true;
  }

  async recoverQueued(): Promise<void> {
    const queued = this.#database
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.status, "queued"))
      .orderBy(asc(agentWorkflows.createdAt))
      .limit(10)
      .all();
    for (const row of queued) await this.#ensureStarted(row);
  }

  usage(): { active: number; total: number } {
    return {
      active:
        this.#database
          .select({ value: count() })
          .from(agentWorkflows)
          .where(inArray(agentWorkflows.status, [...ACTIVE_WORKFLOW_STATUSES]))
          .get()?.value ?? 0,
      total: this.#database.select({ value: count() }).from(agentWorkflows).get()?.value ?? 0,
    };
  }

  async cleanup(currentTime: number): Promise<void> {
    await this.#recoverDeletionIntents();
    this.#database
      .delete(agentWorkflowDeletions)
      .where(lt(agentWorkflowDeletions.cleanupAt, currentTime))
      .run();

    const expired = this.#database
      .select()
      .from(agentWorkflows)
      .where(
        and(
          inArray(agentWorkflows.status, [...TERMINAL_WORKFLOW_STATUSES]),
          isNull(agentWorkflows.deletingAt),
          lt(agentWorkflows.cleanupAt, currentTime),
        ),
      )
      .orderBy(asc(agentWorkflows.cleanupAt))
      .limit(25)
      .all();

    for (const row of expired) {
      try {
        const proposed = workflowDeletionIntentSchema.parse({
          clientId: "crewhelm:retention",
          expectedRevision: row.workflowRevision,
          idempotencyKey: row.workflowId,
          workflowId: row.workflowId,
        });
        const intent = await this.#storage.transaction(async (storage) => {
          const key = workflowDeletionIntentKey(row.workflowId);
          const existing = workflowDeletionIntentSchema.safeParse(await storage.get(key));
          if (existing.success) return existing.data;
          await storage.put(key, proposed);
          return proposed;
        });
        this.#database
          .update(agentWorkflows)
          .set({ deletingAt: row.deletingAt ?? currentTime })
          .where(eq(agentWorkflows.workflowId, row.workflowId))
          .run();
        await this.#finishDeletion(intent, row);
      } catch {
        // Retain the exact projection so the next owner alarm can resume cleanup.
      }
    }
  }

  nextAlarmAt(): number | null {
    const queued = this.#database
      .select({ value: agentWorkflows.updatedAt })
      .from(agentWorkflows)
      .where(eq(agentWorkflows.status, "queued"))
      .orderBy(asc(agentWorkflows.updatedAt))
      .limit(1)
      .get()?.value;
    const cleanup = this.#database
      .select({ value: agentWorkflowDeletions.cleanupAt })
      .from(agentWorkflowDeletions)
      .orderBy(asc(agentWorkflowDeletions.cleanupAt))
      .limit(1)
      .get()?.value;
    const workflowCleanup = this.#database
      .select({ value: agentWorkflows.cleanupAt })
      .from(agentWorkflows)
      .where(
        and(
          inArray(agentWorkflows.status, [...TERMINAL_WORKFLOW_STATUSES]),
          isNull(agentWorkflows.deletingAt),
        ),
      )
      .orderBy(asc(agentWorkflows.cleanupAt))
      .limit(1)
      .get()?.value;
    const deletionRecovery = this.#database
      .select({ value: agentWorkflows.deletingAt })
      .from(agentWorkflows)
      .where(sql`${agentWorkflows.deletingAt} IS NOT NULL`)
      .orderBy(asc(agentWorkflows.deletingAt))
      .limit(1)
      .get()?.value;
    const candidates = [
      queued === undefined
        ? undefined
        : Math.max(queued + RECOVERY_DELAY_MS, Date.now() + RECOVERY_DELAY_MS),
      cleanup,
      deletionRecovery == null
        ? undefined
        : Math.max(deletionRecovery + RECOVERY_DELAY_MS, Date.now() + RECOVERY_DELAY_MS),
      workflowCleanup,
    ].filter((value): value is number => value !== undefined);
    return candidates.toSorted((left, right) => left - right)[0] ?? null;
  }

  async #recoverDeletionIntents(): Promise<void> {
    const intents = await this.#storage.list({
      limit: 25,
      prefix: WORKFLOW_DELETION_INTENT_PREFIX,
    });

    for (const [key, value] of intents) {
      const parsed = workflowDeletionIntentSchema.safeParse(value);
      if (!parsed.success) continue;
      const receipt = this.#database
        .select()
        .from(agentWorkflowDeletions)
        .where(
          and(
            eq(agentWorkflowDeletions.clientId, parsed.data.clientId),
            eq(agentWorkflowDeletions.idempotencyKey, parsed.data.idempotencyKey),
          ),
        )
        .get();
      const row = this.#workflow(parsed.data.workflowId);

      if (row === undefined) {
        if (
          receipt?.workflowId === parsed.data.workflowId &&
          receipt.expectedRevision === parsed.data.expectedRevision
        ) {
          await this.#storage.delete(key);
        }
        continue;
      }

      if (
        row.workflowRevision === parsed.data.expectedRevision &&
        isTerminalWorkflowStatus(row.status)
      ) {
        await this.#finishDeletion(parsed.data, row);
      }
    }
  }

  async #finishDeletion(intent: WorkflowDeletionIntent, row: StoredWorkflow): Promise<boolean> {
    try {
      if (row.session !== null) {
        const deletedSession = await this.#agentChannel.deleteSession(
          this.#runtimeAuthority(row),
          {
            agentId: row.agentId,
            expectedBranchRevision: row.session.branchRevision,
            idempotencyKey: `workflow.${intent.idempotencyKey}`,
            sessionId: row.session.sessionId,
          },
          row.workflowId,
        );
        if (!deletedSession.ok && deletedSession.error.code !== "session_not_found") return false;
      }

      if (
        !(await this.#agent(row).deleteAgentTaskWorkflow({
          ownerKey: this.#objectName,
          workflowId: row.workflowId,
        }))
      ) {
        return false;
      }

      const deletedAt = Date.now();
      const cleanupAt =
        deletedAt + this.#currentFleetConfiguration().data.retention.inboxSeconds * 1_000;
      this.#database.transaction((transaction) => {
        const receipt = transaction
          .select()
          .from(agentWorkflowDeletions)
          .where(
            and(
              eq(agentWorkflowDeletions.clientId, intent.clientId),
              eq(agentWorkflowDeletions.idempotencyKey, intent.idempotencyKey),
            ),
          )
          .get();
        if (receipt !== undefined) return;

        transaction
          .delete(agentWorkflows)
          .where(eq(agentWorkflows.workflowId, row.workflowId))
          .run();
        transaction
          .insert(agentWorkflowDeletions)
          .values({
            cleanupAt,
            clientId: intent.clientId,
            deletedAt,
            expectedRevision: intent.expectedRevision,
            idempotencyKey: intent.idempotencyKey,
            startClientId: row.clientId,
            startIdempotencyKey: row.idempotencyKey,
            startRequestDigest: row.requestDigest,
            workflowId: row.workflowId,
          })
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "workflow.deleted",
            clientId: intent.clientId,
            occurredAt: deletedAt,
            subjectId: row.workflowId,
          })
          .run();
      });
      await this.#storage.delete(workflowDeletionIntentKey(row.workflowId));
      return true;
    } catch {
      await this.#scheduleRecovery(Date.now() + RECOVERY_DELAY_MS);
      return false;
    }
  }

  async #ensureStarted(row: StoredWorkflow): Promise<void> {
    if (row.status !== "queued" || this.#objectName === undefined) return;
    try {
      const started = await this.#agent(row).ensureAgentTaskWorkflow({
        agentId: row.agentId,
        ownerKey: this.#objectName,
        stageCount: row.stageCount,
        workflowId: row.workflowId,
      });
      if (!started) {
        await this.#scheduleRecovery(Date.now() + RECOVERY_DELAY_MS);
        return;
      }
      const updatedAt = Date.now();
      this.#database
        .update(agentWorkflows)
        .set({
          status: "running",
          updatedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(
          and(eq(agentWorkflows.workflowId, row.workflowId), eq(agentWorkflows.status, "queued")),
        )
        .run();
    } catch {
      await this.#scheduleRecovery(Date.now() + RECOVERY_DELAY_MS);
    }
  }

  #failBeforeDispatch(row: StoredWorkflow, stage: StoredStage, code: string): void {
    const completedAt = Date.now();
    const failureCode: StoredFailureCode =
      code === "agent_unavailable" ||
      code === "budget_exhausted" ||
      code === "capability_unavailable" ||
      code === "model_unavailable" ||
      code === "revision_conflict"
        ? code
        : "workflow_unavailable";
    this.#database.transaction((transaction) => {
      const current = transaction
        .select()
        .from(agentWorkflows)
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .get();
      if (current === undefined || isTerminalWorkflowStatus(current.status)) return;
      const cancelled = current.cancellationRequestedAt !== null;

      if (!cancelled) {
        transaction
          .update(agentWorkflowStages)
          .set({ completedAt, status: "failed" })
          .where(
            and(
              eq(agentWorkflowStages.workflowId, row.workflowId),
              eq(agentWorkflowStages.stageIndex, stage.stageIndex),
              eq(agentWorkflowStages.status, "pending"),
              isNull(agentWorkflowStages.runId),
            ),
          )
          .run();
      }
      transaction
        .update(agentWorkflows)
        .set({
          completedAt,
          currentStageIndex: null,
          failureCode: cancelled ? null : failureCode,
          failureStageIndex: cancelled ? null : stage.stageIndex,
          status: cancelled ? "cancelled" : "failed",
          updatedAt: completedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: cancelled ? "workflow.cancelled" : `workflow.failed.${code}`,
          clientId: "crewhelm:workflow",
          occurredAt: completedAt,
          subjectId: row.workflowId,
        })
        .run();
    });
  }

  #releaseDispatchReservation(row: StoredWorkflow, stage: StoredStage): boolean {
    const current = this.#workflow(row.workflowId);

    if (
      current === undefined ||
      current.currentRunId !== null ||
      current.currentStageIndex !== stage.stageIndex
    ) {
      return false;
    }

    const updatedAt = Date.now();
    if (current.cancellationRequestedAt !== null) {
      this.#database
        .update(agentWorkflows)
        .set({
          completedAt: updatedAt,
          currentStageIndex: null,
          status: "cancelled",
          updatedAt,
          workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
        })
        .where(eq(agentWorkflows.workflowId, row.workflowId))
        .run();
      return true;
    }

    this.#database
      .update(agentWorkflows)
      .set({
        currentStageIndex: null,
        status: "running",
        updatedAt,
        workflowRevision: sql`${agentWorkflows.workflowRevision} + 1`,
      })
      .where(eq(agentWorkflows.workflowId, row.workflowId))
      .run();
    return false;
  }

  #summary(row: StoredWorkflow): AgentWorkflowSummary {
    const stage =
      row.currentStageIndex === null
        ? undefined
        : this.#stage(row.workflowId, row.currentStageIndex);
    const failureStage =
      row.failureStageIndex === null
        ? undefined
        : this.#stage(row.workflowId, row.failureStageIndex);
    return agentWorkflowSummarySchema.parse({
      agentId: row.agentId,
      agentRevision: row.agentRevision,
      budget: row.budget,
      completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
      completedStages: row.completedStages,
      createdAt: new Date(row.createdAt).toISOString(),
      currentRunId: row.currentRunId,
      currentStage: stage === undefined ? null : stageProjection(stage, false),
      failure:
        row.failureCode === null || row.failureStageIndex === null
          ? null
          : {
              code: row.failureCode,
              nextAction: failureNextAction(row.failureCode),
              runId: failureStage?.runId ?? null,
              stageIndex: row.failureStageIndex,
            },
      revision: row.workflowRevision,
      stageCount: row.stageCount,
      status: row.status,
      updatedAt: new Date(row.updatedAt).toISOString(),
      workflowId: row.workflowId,
    });
  }

  #workflow(id: string): StoredWorkflow | undefined {
    return this.#database
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.workflowId, id))
      .get();
  }

  #stage(id: string, stageIndex: number): StoredStage | undefined {
    return this.#database
      .select()
      .from(agentWorkflowStages)
      .where(
        and(eq(agentWorkflowStages.workflowId, id), eq(agentWorkflowStages.stageIndex, stageIndex)),
      )
      .get();
  }

  #stages(id: string): StoredStage[] {
    return this.#database
      .select()
      .from(agentWorkflowStages)
      .where(eq(agentWorkflowStages.workflowId, id))
      .orderBy(asc(agentWorkflowStages.stageIndex))
      .all();
  }

  #agent(row: Pick<StoredWorkflow, "agentId">) {
    if (this.#objectName === undefined) throw new Error("Workflow owner identity is unavailable.");
    return this.#crewAgents.getByName(
      crewAgentObjectName({ agentId: row.agentId, ownerKey: this.#objectName }),
    );
  }

  #runtimeAuthority(row: Pick<StoredWorkflow, "workflowId">): OwnerAuthority {
    if (this.#objectName === undefined) throw new Error("Workflow owner identity is unavailable.");
    return {
      clientId: `crewhelm:workflow:${row.workflowId}`,
      ownerKey: this.#objectName,
      scopes: ["agents:read", "agents:write", "runs:write"],
    };
  }

  async #scheduleRecovery(at: number): Promise<void> {
    const current = await this.#storage.getAlarm();
    if (current === null || at < current) await this.#storage.setAlarm(at);
  }
}
