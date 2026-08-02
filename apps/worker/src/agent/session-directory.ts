import {
  acceptRunAdmissionInputSchema,
  acceptRunAdmissionResultSchema,
  agentTaskWorkflowParamsSchema,
  agentWorkflowIdSchema,
  agentWorkflowRunEventSchema,
  branchIdSchema,
  continuationFromRunSession,
  conversationFromRunSession,
  crewAgentObjectName,
  crewSessionObjectName,
  DEFAULT_AGENT_SESSION_RETENTION_SECONDS,
  deleteAgentSessionResultSchema,
  inspectAdmittedRunResultSchema,
  inspectAgentSessionResultSchema,
  listAgentSessionsResultSchema,
  MAXIMUM_ACTIVE_AGENT_WORKFLOWS_PER_OWNER,
  MAXIMUM_AGENT_SESSIONS,
  runIdSchema,
  runSessionSchema,
  sessionContinuationSchema,
  sessionIdSchema,
  sessionSummarySchema,
  type AcceptRunAdmissionResult,
  type DeleteAgentSessionResult,
  type InspectAgentSessionResult,
  type InspectAdmittedRunResult,
  type ListAgentSessionsResult,
  type RunSession,
  type SessionContinuation,
  type SessionSummary,
} from "@crewhelm/contracts";
import { Agent } from "agents";
import * as z from "zod";

import {
  AGENT_TASK_WORKFLOW_AGENT_BINDING,
  AGENT_TASK_WORKFLOW_BINDING,
  agentWorkflowStageEventType,
} from "../agent-workflows/index.js";
import { CrewSession } from "./admitted-runs/index.js";

const SESSION_RECORD_PREFIX = "crewhelm:session:";
const RUN_SESSION_PREFIX = "crewhelm:run-session:";
const SESSION_RUN_INDEX_PREFIX = "crewhelm:session-run:";
const SESSION_DELETE_PREFIX = "crewhelm:session-delete:";
const SESSION_DELETE_INTENT_PREFIX = "crewhelm:session-deletion-intent:";
const SESSION_EXPIRY_DELETE_INTENT_PREFIX = "crewhelm:session-expiry-deletion-intent:";
const SESSION_RUN_PAGE_SIZE = 50;
const SESSION_EXPIRY_DELETE_RETRY_MILLISECONDS = 60_000;
const AGENT_WORKFLOW_RECORD_PREFIX = "crewhelm:agent-workflow:";
const AGENT_WORKFLOW_RUN_PREFIX = "crewhelm:agent-workflow-run:";
const AGENT_WORKFLOW_RUN_INDEX_PREFIX = "crewhelm:agent-workflow-run-index:";
const AGENT_WORKFLOW_PENDING_PREFIX = "crewhelm:agent-workflow-pending:";
const AGENT_WORKFLOW_CLIENT_PREFIX = "crewhelm:workflow:";
const TERMINAL_PROVIDER_WORKFLOW_STATUSES = ["complete", "errored", "terminated"] as const;

const agentWorkflowDirectoryRecordSchema = agentTaskWorkflowParamsSchema.extend({
  startedAt: z.number().int().positive(),
});

const agentWorkflowRunDirectoryRecordSchema = z.strictObject({
  delivered: z.boolean(),
  runId: runIdSchema,
  session: runSessionSchema,
  stageIndex: z.number().int().min(0).max(7),
  terminalStatus: z.enum(["cancelled", "completed", "failed"]).nullable(),
  workflowId: agentWorkflowIdSchema,
});

const attachAgentWorkflowRunSchema = agentWorkflowRunDirectoryRecordSchema
  .omit({ delivered: true, terminalStatus: true })
  .extend({ agentId: z.string().min(1), ownerKey: z.string().min(1) });

const workflowCallbackSchema = z.looseObject({
  workflowId: agentWorkflowIdSchema,
  workflowName: z.literal(AGENT_TASK_WORKFLOW_BINDING),
});

const sessionDirectoryRecordSchema = z.strictObject({
  activeRunId: runIdSchema.nullable(),
  agentId: z.string().min(1),
  availableUntil: z.number().int().positive(),
  branchId: branchIdSchema,
  branchRevision: z.number().int().positive().safe(),
  createdAt: z.number().int().positive(),
  deleting: z.boolean().default(false),
  ownerKey: z.string().min(1),
  sessionId: sessionIdSchema,
  updatedAt: z.number().int().positive(),
  visible: z.boolean(),
  workflowId: agentWorkflowIdSchema.nullable().default(null),
});

const runSessionDirectoryRecordSchema = z.strictObject({
  continuation: sessionContinuationSchema.nullable(),
  deadlineAt: z.number().int().positive(),
  previousRevision: z.number().int().nonnegative().safe(),
  session: runSessionSchema,
});

const sessionDirectoryRequestSchema = z.strictObject({
  agentId: z.string().min(1),
  ownerKey: z.string().min(1),
});

const listSessionsRequestSchema = sessionDirectoryRequestSchema.extend({
  cursor: sessionIdSchema.optional(),
  limit: z.number().int().min(1).max(100),
});

const inspectSessionRequestSchema = sessionDirectoryRequestSchema.extend({
  sessionId: sessionIdSchema,
});

const listSessionRunIdsRequestSchema = inspectSessionRequestSchema.extend({
  cursor: runIdSchema.optional(),
});

const deleteSessionRequestSchema = inspectSessionRequestSchema.extend({
  expectedBranchRevision: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(128),
  workflowId: agentWorkflowIdSchema.nullable().default(null),
});

const sessionDeleteReceiptSchema = z.strictObject({
  deletedAt: z.number().int().positive(),
  expectedBranchRevision: z.number().int().positive().safe(),
  sessionId: sessionIdSchema,
});

const sessionDeleteIntentSchema = z.strictObject({
  expectedBranchRevision: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(128),
  sessionId: sessionIdSchema,
});

const sessionExpiryDeleteIntentSchema = z.strictObject({
  branchRevision: z.number().int().positive().safe(),
  claimedAt: z.number().int().positive(),
  sessionId: sessionIdSchema,
});

type SessionDirectoryRecord = z.infer<typeof sessionDirectoryRecordSchema>;
type RunSessionDirectoryRecord = z.infer<typeof runSessionDirectoryRecordSchema>;

function sessionRecordKey(sessionId: string): string {
  return `${SESSION_RECORD_PREFIX}${sessionId}`;
}

function runSessionKey(runId: string): string {
  return `${RUN_SESSION_PREFIX}${runId}`;
}

function sessionRunIndexPrefix(sessionId: string): string {
  return `${SESSION_RUN_INDEX_PREFIX}${sessionId}:`;
}

function sessionRunIndexKey(sessionId: string, runId: string): string {
  return `${sessionRunIndexPrefix(sessionId)}${runId}`;
}

function sessionDeleteKey(idempotencyKey: string): string {
  return `${SESSION_DELETE_PREFIX}${idempotencyKey}`;
}

function sessionDeleteIntentKey(idempotencyKey: string): string {
  return `${SESSION_DELETE_INTENT_PREFIX}${idempotencyKey}`;
}

function sessionExpiryDeleteIntentKey(sessionId: string): string {
  return `${SESSION_EXPIRY_DELETE_INTENT_PREFIX}${sessionId}`;
}

function agentWorkflowRecordKey(workflowId: string): string {
  return `${AGENT_WORKFLOW_RECORD_PREFIX}${workflowId}`;
}

function agentWorkflowRunKey(runId: string): string {
  return `${AGENT_WORKFLOW_RUN_PREFIX}${runId}`;
}

function agentWorkflowRunIndexKey(workflowId: string, runId: string): string {
  return `${AGENT_WORKFLOW_RUN_INDEX_PREFIX}${workflowId}:${runId}`;
}

function agentWorkflowPendingKey(runId: string): string {
  return `${AGENT_WORKFLOW_PENDING_PREFIX}${runId}`;
}

function newSessionId(): string {
  return `session_${crypto.randomUUID()}`;
}

function newBranchId(): string {
  return `branch_${crypto.randomUUID()}`;
}

function workflowIdFromPermit(trigger: string, clientId: string): string | null | undefined {
  if (trigger !== "workflow") return null;
  if (!clientId.startsWith(AGENT_WORKFLOW_CLIENT_PREFIX)) return undefined;

  const parsed = agentWorkflowIdSchema.safeParse(
    clientId.slice(AGENT_WORKFLOW_CLIENT_PREFIX.length),
  );
  return parsed.success ? parsed.data : undefined;
}

function sessionProjection(record: SessionDirectoryRecord): SessionSummary {
  return sessionSummarySchema.parse({
    agentId: record.agentId,
    availableUntil: new Date(record.availableUntil).toISOString(),
    branchId: record.branchId,
    branchRevision: record.branchRevision,
    createdAt: new Date(record.createdAt).toISOString(),
    sessionId: record.sessionId,
    status: record.activeRunId === null && !record.deleting ? "idle" : "active",
    updatedAt: new Date(record.updatedAt).toISOString(),
  });
}

function isExpiredIdleSession(record: SessionDirectoryRecord, currentTime: number): boolean {
  return !record.deleting && record.activeRunId === null && record.availableUntil <= currentTime;
}

const invalidAdmission = {
  error: { code: "invalid_admission", message: "Run admission denied." },
  ok: false,
} as const;

export class CrewAgent extends CrewSession {
  override async onStart(): Promise<void> {
    await super.onStart();

    if (!this.durableSessionsEnabled() || !this.ctx.id.name?.startsWith("crew-agent:")) {
      return;
    }

    await this.#recoverAgentWorkflowRunEvents();
  }

  protected durableSessionsEnabled(): boolean {
    return true;
  }

  protected sessionNamespace(): DurableObjectNamespace<CrewSession> {
    return this.env.CREW_SESSION;
  }

  async ensureAgentTaskWorkflow(input: unknown): Promise<boolean> {
    const request = agentTaskWorkflowParamsSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return false;
    }

    const verified = await this.env.OWNER_CONTROL_PLANE.getByName(
      request.data.ownerKey,
    ).verifyAgentWorkflowRuntime({
      agentId: request.data.agentId,
      stageCount: request.data.stageCount,
      workflowId: request.data.workflowId,
    });

    if (!verified) {
      return false;
    }

    const key = agentWorkflowRecordKey(request.data.workflowId);
    const stored = agentWorkflowDirectoryRecordSchema.safeParse(await this.ctx.storage.get(key));

    if (stored.success) {
      if (
        stored.data.agentId !== request.data.agentId ||
        stored.data.ownerKey !== request.data.ownerKey ||
        stored.data.stageCount !== request.data.stageCount
      ) {
        return false;
      }
    } else {
      await this.ctx.storage.put(key, {
        ...request.data,
        startedAt: Date.now(),
      });
    }

    if (Agent.prototype.getWorkflow.call(this, request.data.workflowId) !== undefined) {
      return true;
    }

    if (this.env.AGENT_TASK_WORKFLOW === undefined) {
      return false;
    }

    const instanceId = z.string().parse(
      await Reflect.apply(Reflect.get(Agent.prototype, "runWorkflow"), this, [
        AGENT_TASK_WORKFLOW_BINDING,
        request.data,
        {
          agentBinding: AGENT_TASK_WORKFLOW_AGENT_BINDING,
          id: request.data.workflowId,
          metadata: {
            agentId: request.data.agentId,
            stageCount: request.data.stageCount,
          },
        },
      ]),
    );
    return instanceId === request.data.workflowId;
  }

  async attachAgentTaskWorkflowRun(input: unknown): Promise<boolean> {
    const request = attachAgentWorkflowRunSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return false;
    }

    const workflow = agentWorkflowDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(agentWorkflowRecordKey(request.data.workflowId)),
    );

    if (!workflow.success || request.data.stageIndex >= workflow.data.stageCount) {
      return false;
    }

    const key = agentWorkflowRunKey(request.data.runId);
    const existing = agentWorkflowRunDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(key),
    );
    const mapping = agentWorkflowRunDirectoryRecordSchema.parse({
      delivered: false,
      runId: request.data.runId,
      session: request.data.session,
      stageIndex: request.data.stageIndex,
      terminalStatus: null,
      workflowId: request.data.workflowId,
    });

    if (existing.success && JSON.stringify(existing.data) !== JSON.stringify(mapping)) {
      if (
        existing.data.runId !== mapping.runId ||
        existing.data.workflowId !== mapping.workflowId ||
        existing.data.stageIndex !== mapping.stageIndex ||
        JSON.stringify(existing.data.session) !== JSON.stringify(mapping.session)
      ) {
        return false;
      }
    } else if (!existing.success) {
      await this.ctx.storage.put({
        [agentWorkflowRunIndexKey(mapping.workflowId, mapping.runId)]: true,
        [agentWorkflowPendingKey(mapping.runId)]: true,
        [key]: mapping,
      });
    }

    await this.#deliverAgentWorkflowRunEvent(request.data.runId);
    return true;
  }

  async markSessionRunWaiting(input: unknown): Promise<boolean> {
    const request = z.strictObject({ runId: runIdSchema }).safeParse(input);

    if (!request.success) {
      return false;
    }

    const mapping = agentWorkflowRunDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(agentWorkflowRunKey(request.data.runId)),
    );

    if (!mapping.success) {
      return false;
    }

    const identity = this.#agentIdentity();
    return this.env.OWNER_CONTROL_PLANE.getByName(identity.ownerKey).markAgentWorkflowStageWaiting({
      agentId: identity.agentId,
      runId: mapping.data.runId,
      stageIndex: mapping.data.stageIndex,
      workflowId: mapping.data.workflowId,
    });
  }

  async deliverAgentWorkflowRunEvent(input: unknown): Promise<void> {
    const request = z.strictObject({ runId: runIdSchema }).safeParse(input);

    if (request.success) {
      await this.#deliverAgentWorkflowRunEvent(request.data.runId);
    }
  }

  async #recoverAgentWorkflowRunEvents(): Promise<void> {
    if (!this.ctx.id.name?.startsWith("crew-agent:")) {
      return;
    }

    const pending = await this.ctx.storage.list<boolean>({
      limit: MAXIMUM_ACTIVE_AGENT_WORKFLOWS_PER_OWNER,
      prefix: AGENT_WORKFLOW_PENDING_PREFIX,
    });

    for (const key of pending.keys()) {
      await this.#deliverAgentWorkflowRunEvent(key.slice(AGENT_WORKFLOW_PENDING_PREFIX.length));
    }
  }

  async cancelAgentTaskWorkflow(input: unknown): Promise<boolean> {
    const request = z
      .strictObject({ ownerKey: z.string().min(1), workflowId: agentWorkflowIdSchema })
      .safeParse(input);

    if (!request.success || this.#agentIdentity().ownerKey !== request.data.ownerKey) {
      return false;
    }

    const workflow = agentWorkflowDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(agentWorkflowRecordKey(request.data.workflowId)),
    );

    if (!workflow.success) {
      return false;
    }

    const tracked = Agent.prototype.getWorkflow.call(this, request.data.workflowId);

    if (
      tracked !== undefined &&
      !(await this.#terminateAgentTaskWorkflow(request.data.workflowId))
    ) {
      return false;
    }

    await this.#sealAgentWorkflowRunDeliveries(request.data.workflowId);

    return true;
  }

  async deleteAgentTaskWorkflow(input: unknown): Promise<boolean> {
    const request = z
      .strictObject({ ownerKey: z.string().min(1), workflowId: agentWorkflowIdSchema })
      .safeParse(input);

    if (!request.success || this.#agentIdentity().ownerKey !== request.data.ownerKey) {
      return false;
    }

    const workflowKey = agentWorkflowRecordKey(request.data.workflowId);
    const workflow = agentWorkflowDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(workflowKey),
    );

    if (!workflow.success) {
      return true;
    }

    const runtimeActive = await this.env.OWNER_CONTROL_PLANE.getByName(
      workflow.data.ownerKey,
    ).verifyAgentWorkflowRuntime({
      agentId: workflow.data.agentId,
      stageCount: workflow.data.stageCount,
      workflowId: workflow.data.workflowId,
    });
    if (runtimeActive) return false;

    const tracked = Agent.prototype.getWorkflow.call(this, request.data.workflowId);

    if (
      tracked !== undefined &&
      !(await this.#terminateAgentTaskWorkflow(request.data.workflowId))
    ) {
      return false;
    }

    if (tracked !== undefined) {
      Agent.prototype.deleteWorkflow.call(this, request.data.workflowId);
    }
    const indexes = await this.ctx.storage.list({
      prefix: `${AGENT_WORKFLOW_RUN_INDEX_PREFIX}${request.data.workflowId}:`,
    });
    const keys = [workflowKey, ...indexes.keys()];

    for (const key of indexes.keys()) {
      const runId = key.slice(key.lastIndexOf(":") + 1);
      keys.push(agentWorkflowPendingKey(runId), agentWorkflowRunKey(runId));
    }

    await this.ctx.storage.delete(keys);
    return true;
  }

  async #terminateAgentTaskWorkflow(workflowId: string): Promise<boolean> {
    const binding = this.env.AGENT_TASK_WORKFLOW;
    if (binding === undefined) return false;

    try {
      const instance = await binding.get(workflowId);
      let status = await instance.status();

      if (!(TERMINAL_PROVIDER_WORKFLOW_STATUSES as readonly string[]).includes(status.status)) {
        await instance.terminate();
        status = await instance.status();
      }

      return (TERMINAL_PROVIDER_WORKFLOW_STATUSES as readonly string[]).includes(status.status);
    } catch (error) {
      console.warn({
        error: error instanceof Error ? error.name : "UnknownError",
        event: "crewhelm.workflow.recovery",
        outcome: "deferred",
        phase: "provider_terminate",
        workflowId,
      });
      return false;
    }
  }

  async deleteAgentTaskWorkflowSession(input: unknown): Promise<boolean> {
    const request = z
      .strictObject({
        idempotencyKey: z.string().min(1).max(128),
        ownerKey: z.string().min(1),
        sessionId: sessionIdSchema,
        workflowId: agentWorkflowIdSchema,
      })
      .safeParse(input);

    if (!request.success || this.#agentIdentity().ownerKey !== request.data.ownerKey) {
      return false;
    }

    const record = await this.#readSession(request.data.sessionId);
    if (record === undefined) return true;
    if (record.workflowId !== request.data.workflowId) return false;
    const deleted = await this.deleteAgentSession({
      agentId: record.agentId,
      expectedBranchRevision: record.branchRevision,
      idempotencyKey: request.data.idempotencyKey,
      ownerKey: record.ownerKey,
      sessionId: record.sessionId,
      workflowId: request.data.workflowId,
    });
    if (deleted.ok) return true;
    if (deleted.error.code !== "session_not_found") return false;

    return (await this.#readSession(request.data.sessionId)) === undefined;
  }

  async #releaseSessionRunForDeletion(record: SessionDirectoryRecord): Promise<boolean> {
    if (record.activeRunId === null) return true;
    const mapping = await this.#readRunSession(record.activeRunId);
    if (mapping === undefined || Date.now() < mapping.deadlineAt) {
      return !(await this.#reconcileActiveRun(record));
    }

    const session: RunSession = {
      branchId: record.branchId,
      branchRevision: record.branchRevision,
      sessionId: record.sessionId,
    };

    try {
      const settled = await this.#session(session).settleExpiredSessionRunForDeletion({
        objectName: crewSessionObjectName({
          agentId: record.agentId,
          ownerKey: record.ownerKey,
          sessionId: record.sessionId,
        }),
        runId: record.activeRunId,
        session,
      });
      return settled && (await this.#clearReconciledRun(record));
    } catch {
      return false;
    }
  }

  override async _workflow_handleCallback(...args: unknown[]): Promise<void> {
    const callback = args[0];
    const request = workflowCallbackSchema.safeParse(callback);

    if (
      !request.success ||
      !agentWorkflowDirectoryRecordSchema.safeParse(
        await this.ctx.storage.get(agentWorkflowRecordKey(request.data.workflowId)),
      ).success
    ) {
      throw new Error("CrewAgent workflow callback denied.");
    }

    await Reflect.apply(Reflect.get(Agent.prototype, "_workflow_handleCallback"), this, [callback]);

    if (request.data.type === "error") {
      const workflow = agentWorkflowDirectoryRecordSchema.parse(
        await this.ctx.storage.get(agentWorkflowRecordKey(request.data.workflowId)),
      );
      const failed = await this.env.OWNER_CONTROL_PLANE.getByName(
        workflow.ownerKey,
      ).failAgentWorkflowRuntime({
        agentId: workflow.agentId,
        workflowId: workflow.workflowId,
      });

      if (!failed) {
        throw new Error("CrewAgent workflow failure projection is unavailable.");
      }

      await this.#sealAgentWorkflowRunDeliveries(workflow.workflowId);
    }
  }

  override async acceptRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    if (!this.durableSessionsEnabled()) {
      return super.acceptRunAdmission(input);
    }

    const request = acceptRunAdmissionInputSchema.safeParse(input);

    if (!request.success || request.data.session !== undefined) {
      return invalidAdmission;
    }

    if (request.data.permit.scheduleRevision !== null) {
      return request.data.continuation === undefined
        ? super.acceptRunAdmission(request.data)
        : invalidAdmission;
    }

    const workflowId = workflowIdFromPermit(
      request.data.permit.trigger,
      request.data.permit.clientId,
    );

    if (workflowId === undefined) {
      return invalidAdmission;
    }

    const prepared = await this.#prepareSession(
      request.data.permit.ownerKey,
      request.data.permit.agentId,
      request.data.permit.runId,
      Date.now() + request.data.permit.budgetReservation.maxDurationSeconds * 1_000,
      Date.now() +
        Math.max(
          DEFAULT_AGENT_SESSION_RETENTION_SECONDS,
          request.data.permit.budgetReservation.retentionSeconds,
        ) *
          1_000,
      workflowId === null,
      request.data.continuation,
      workflowId,
    );

    if (!prepared.ok) {
      return prepared.result;
    }

    let result: AcceptRunAdmissionResult;

    try {
      result = acceptRunAdmissionResultSchema.parse(
        await this.#session(prepared.mapping.session).acceptRunAdmission({
          ...(request.data.briefContext === undefined
            ? {}
            : { briefContext: request.data.briefContext }),
          permit: request.data.permit,
          prompt: request.data.prompt,
          session: prepared.mapping.session,
        }),
      );
    } catch {
      result = invalidAdmission;
    }

    if (!result.ok) {
      try {
        const state = await this.#session(prepared.mapping.session).inspectSessionRunState({
          runId: request.data.permit.runId,
          session: prepared.mapping.session,
        });

        if (state === null) {
          await this.#rollbackPreparedSession(request.data.permit.runId, prepared.mapping);
        }
      } catch {
        // Preserve ambiguous routing so an idempotent retry reaches the same session runtime.
      }
    } else if (!result.accepted) {
      try {
        const discarded = await this.#session(prepared.mapping.session).discardRejectedSessionRun({
          runId: request.data.permit.runId,
          session: prepared.mapping.session,
        });

        if (discarded) {
          await this.#rollbackPreparedSession(request.data.permit.runId, prepared.mapping);
        }
      } catch {
        // Preserve the reservation if exact cleanup cannot be confirmed.
      }
    }

    return result;
  }

  override async resumeRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    if (!this.durableSessionsEnabled()) {
      return super.resumeRunAdmission(input);
    }

    const request = z
      .strictObject({
        capability: z.object({ runId: runIdSchema }).passthrough(),
        continuation: sessionContinuationSchema.optional(),
        prompt: z.string(),
      })
      .safeParse(input);

    if (!request.success) {
      return invalidAdmission;
    }

    const mapping = await this.#readRunSession(request.data.capability.runId);

    if (mapping === undefined) {
      return super.resumeRunAdmission(input);
    }

    if (
      JSON.stringify(mapping.continuation ?? undefined) !==
      JSON.stringify(request.data.continuation)
    ) {
      return invalidAdmission;
    }

    try {
      return acceptRunAdmissionResultSchema.parse(
        await this.#session(mapping.session).resumeRunAdmission({
          capability: request.data.capability,
          ...(request.data.continuation === undefined
            ? {}
            : { continuation: request.data.continuation }),
          prompt: request.data.prompt,
          session: mapping.session,
        }),
      );
    } catch {
      return invalidAdmission;
    }
  }

  override async inspectAdmittedRun(input: unknown): Promise<InspectAdmittedRunResult> {
    const session = await this.#sessionForRunInput(input);
    if (session === undefined) return super.inspectAdmittedRun(input);

    const inspected: unknown = await session.inspectAdmittedRun(input);
    return inspectAdmittedRunResultSchema.parse(inspected);
  }

  override async cancelAdmittedRun(input: unknown): ReturnType<CrewSession["cancelAdmittedRun"]> {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.cancelAdmittedRun(input)
      : session.cancelAdmittedRun(input);
  }

  override async listAdmittedRunToolApprovals(
    input: unknown,
  ): ReturnType<CrewSession["listAdmittedRunToolApprovals"]> {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.listAdmittedRunToolApprovals(input)
      : session.listAdmittedRunToolApprovals(input);
  }

  override async decideAdmittedRunToolApproval(
    input: unknown,
  ): ReturnType<CrewSession["decideAdmittedRunToolApproval"]> {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.decideAdmittedRunToolApproval(input)
      : session.decideAdmittedRunToolApproval(input);
  }

  async completeSessionRun(input: unknown): Promise<boolean> {
    const request = z
      .strictObject({ runId: runIdSchema, session: runSessionSchema })
      .safeParse(input);

    if (!request.success) {
      return false;
    }

    const mapping = await this.#readRunSession(request.data.runId);

    if (
      mapping === undefined ||
      JSON.stringify(mapping.session) !== JSON.stringify(request.data.session)
    ) {
      return false;
    }

    const record = await this.#readSession(request.data.session.sessionId);

    if (record === undefined || record.activeRunId !== request.data.runId) {
      return false;
    }

    await this.ctx.storage.put(sessionRecordKey(record.sessionId), {
      ...record,
      activeRunId: null,
      updatedAt: Date.now(),
    });
    await this.#scheduleSessionCleanup();
    await this.#deliverAgentWorkflowRunEvent(request.data.runId);
    return true;
  }

  async listAgentSessions(input: unknown): Promise<ListAgentSessionsResult> {
    const request = listSessionsRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return { error: { code: "owner_mismatch", message: "Session request denied." }, ok: false };
    }

    await this.#cleanupExpiredSessions();
    const records = await this.#sessionRecords();
    const after = request.data.cursor;
    const eligible = records.filter(
      (record) => record.visible && (after === undefined || record.sessionId > after),
    );
    const page = eligible.slice(0, request.data.limit);

    return listAgentSessionsResultSchema.parse({
      nextCursor: eligible.length > page.length ? (page.at(-1)?.sessionId ?? null) : null,
      ok: true,
      sessions: page.map(sessionProjection),
    });
  }

  async inspectAgentSession(input: unknown): Promise<InspectAgentSessionResult> {
    const request = inspectSessionRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return { error: { code: "owner_mismatch", message: "Session request denied." }, ok: false };
    }

    const record = await this.#readAvailableSession(request.data.sessionId);

    if (record === undefined || !record.visible) {
      return {
        error: { code: "session_not_found", message: "Session request denied." },
        ok: false,
      };
    }

    try {
      const inspection = await this.#session({
        branchId: record.branchId,
        branchRevision: record.branchRevision,
        sessionId: record.sessionId,
      }).inspectSessionMessages();

      return inspectAgentSessionResultSchema.parse({
        ...inspection,
        conversation: conversationFromRunSession(sessionProjection(record)),
        continuation: continuationFromRunSession(sessionProjection(record)),
        ok: true,
        session: sessionProjection(record),
      });
    } catch {
      return {
        error: { code: "session_unavailable", message: "Session request denied." },
        ok: false,
      };
    }
  }

  async deleteAgentSession(input: unknown): Promise<DeleteAgentSessionResult> {
    const request = deleteSessionRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return {
        error: { code: "owner_mismatch", message: "Session deletion denied." },
        ok: false,
      };
    }

    const priorDeletion = sessionDeleteReceiptSchema.safeParse(
      await this.ctx.storage.get(sessionDeleteKey(request.data.idempotencyKey)),
    );

    if (priorDeletion.success) {
      return priorDeletion.data.sessionId === request.data.sessionId &&
        priorDeletion.data.expectedBranchRevision === request.data.expectedBranchRevision
        ? { deleted: true, ok: true, sessionId: request.data.sessionId }
        : {
            error: { code: "invalid_request", message: "Session deletion denied." },
            ok: false,
          };
    }

    let record = await this.#readAvailableSession(request.data.sessionId);

    if (
      record === undefined ||
      record.workflowId !== request.data.workflowId ||
      (request.data.workflowId === null && !record.visible)
    ) {
      return {
        error: { code: "session_not_found", message: "Session deletion denied." },
        ok: false,
      };
    }

    if (record.branchRevision !== request.data.expectedBranchRevision) {
      return {
        error: { code: "revision_conflict", message: "Session deletion denied." },
        ok: false,
      };
    }

    if (!(await this.#releaseSessionRunForDeletion(record))) {
      return {
        error: { code: "session_busy", message: "Session deletion denied." },
        ok: false,
      };
    }

    record = await this.#readAvailableSession(request.data.sessionId);
    if (
      record === undefined ||
      record.workflowId !== request.data.workflowId ||
      record.branchRevision !== request.data.expectedBranchRevision ||
      record.activeRunId !== null
    ) {
      return {
        error: { code: "session_busy", message: "Session deletion denied." },
        ok: false,
      };
    }

    const reservedDeletion = await this.ctx.storage.transaction(async (storage) => {
      const current = sessionDirectoryRecordSchema.safeParse(
        await storage.get(sessionRecordKey(record.sessionId)),
      );
      const intent = sessionDeleteIntentSchema.safeParse(
        await storage.get(sessionDeleteIntentKey(request.data.idempotencyKey)),
      );

      if (
        intent.success &&
        (intent.data.expectedBranchRevision !== request.data.expectedBranchRevision ||
          intent.data.sessionId !== request.data.sessionId)
      ) {
        return { code: "invalid_request", ok: false } as const;
      }

      if (!current.success || current.data.workflowId !== request.data.workflowId) {
        return { code: "session_not_found", ok: false } as const;
      }

      if (current.data.branchRevision !== request.data.expectedBranchRevision) {
        return { code: "revision_conflict", ok: false } as const;
      }

      if (current.data.deleting) {
        return intent.success &&
          intent.data.expectedBranchRevision === request.data.expectedBranchRevision &&
          intent.data.idempotencyKey === request.data.idempotencyKey &&
          intent.data.sessionId === request.data.sessionId
          ? ({ ok: true, record: current.data } as const)
          : ({ code: "session_busy", ok: false } as const);
      }

      if (current.data.activeRunId !== null) {
        return { code: "session_busy", ok: false } as const;
      }

      const reserved = sessionDirectoryRecordSchema.parse({
        ...current.data,
        deleting: true,
        updatedAt: Date.now(),
      });
      await storage.put(sessionDeleteIntentKey(request.data.idempotencyKey), {
        expectedBranchRevision: request.data.expectedBranchRevision,
        idempotencyKey: request.data.idempotencyKey,
        sessionId: request.data.sessionId,
      });
      await storage.put(sessionRecordKey(reserved.sessionId), reserved);
      return { ok: true, record: reserved } as const;
    });

    if (!reservedDeletion.ok) {
      return {
        error: { code: reservedDeletion.code, message: "Session deletion denied." },
        ok: false,
      };
    }

    const idleRecord = reservedDeletion.record;

    const session = {
      branchId: idleRecord.branchId,
      branchRevision: idleRecord.branchRevision,
      sessionId: idleRecord.sessionId,
    };

    try {
      const child = this.#session(session);
      const deleted = await child.deleteSessionStorage({
        objectName: crewSessionObjectName({
          agentId: idleRecord.agentId,
          ownerKey: idleRecord.ownerKey,
          sessionId: idleRecord.sessionId,
        }),
      });

      if (!deleted) {
        throw new Error("Session runtime refused deletion.");
      }

      await this.ctx.storage.transaction(async (storage) => {
        const current = sessionDirectoryRecordSchema.safeParse(
          await storage.get(sessionRecordKey(idleRecord.sessionId)),
        );
        const intent = sessionDeleteIntentSchema.safeParse(
          await storage.get(sessionDeleteIntentKey(request.data.idempotencyKey)),
        );

        if (
          !current.success ||
          !current.data.deleting ||
          !intent.success ||
          intent.data.expectedBranchRevision !== request.data.expectedBranchRevision ||
          intent.data.idempotencyKey !== request.data.idempotencyKey ||
          intent.data.sessionId !== request.data.sessionId
        ) {
          throw new Error("Session deletion reservation changed.");
        }

        await storage.put(sessionDeleteKey(request.data.idempotencyKey), {
          deletedAt: Date.now(),
          expectedBranchRevision: request.data.expectedBranchRevision,
          sessionId: idleRecord.sessionId,
        });
        await storage.delete([
          sessionDeleteIntentKey(request.data.idempotencyKey),
          sessionRecordKey(idleRecord.sessionId),
        ]);
      });
    } catch {
      // The child may already be empty or finalization may have crashed. Keep the durable intent
      // sealed so only the exact idempotent request can resume deletion and finish owner cleanup.
      return {
        error: { code: "session_unavailable", message: "Session deletion denied." },
        ok: false,
      };
    }

    await this.#scheduleSessionCleanup();

    return deleteAgentSessionResultSchema.parse({
      deleted: true,
      ok: true,
      sessionId: idleRecord.sessionId,
    });
  }

  async cleanupExpiredSessions(): Promise<void> {
    if (!this.ctx.id.name?.startsWith("crew-agent:")) {
      return;
    }

    await this.#cleanupExpiredSessions();
    await this.#scheduleSessionCleanup();
  }

  async listAgentSessionRunIds(
    input: unknown,
  ): Promise<{ nextCursor: string | null; runIds: string[] } | null> {
    const request = listSessionRunIdsRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return null;
    }

    const prefix = sessionRunIndexPrefix(request.data.sessionId);
    const entries = await this.ctx.storage.list<boolean>({
      limit: SESSION_RUN_PAGE_SIZE,
      prefix,
      ...(request.data.cursor === undefined
        ? {}
        : { startAfter: sessionRunIndexKey(request.data.sessionId, request.data.cursor) }),
    });
    const runIds = [...entries.keys()].map((key) => key.slice(prefix.length));

    return {
      nextCursor: entries.size < SESSION_RUN_PAGE_SIZE ? null : (runIds.at(-1) ?? null),
      runIds,
    };
  }

  async #deliverAgentWorkflowRunEvent(runId: string): Promise<void> {
    const key = agentWorkflowRunKey(runId);
    const parsed = agentWorkflowRunDirectoryRecordSchema.safeParse(await this.ctx.storage.get(key));

    if (!parsed.success || parsed.data.delivered) {
      await this.ctx.storage.delete(agentWorkflowPendingKey(runId));
      return;
    }
    let mapping = parsed.data;

    if (mapping.terminalStatus === null) {
      let status: unknown;

      try {
        status = await this.#session(mapping.session).inspectSessionRunState({
          runId,
          session: mapping.session,
        });
      } catch {
        await this.#scheduleAgentWorkflowRunDelivery(runId);
        return;
      }

      const terminal = z.enum(["cancelled", "completed", "failed"]).safeParse(status);

      if (!terminal.success) {
        await this.#scheduleAgentWorkflowRunDelivery(runId);
        return;
      }

      const updated = agentWorkflowRunDirectoryRecordSchema.parse({
        ...mapping,
        terminalStatus: terminal.data,
      });
      await this.ctx.storage.put(key, updated);
      mapping = updated;
    }

    try {
      await Reflect.apply(Reflect.get(Agent.prototype, "sendWorkflowEvent"), this, [
        AGENT_TASK_WORKFLOW_BINDING,
        mapping.workflowId,
        {
          payload: agentWorkflowRunEventSchema.parse({
            runId: mapping.runId,
            stageIndex: mapping.stageIndex,
            status: mapping.terminalStatus,
            workflowId: mapping.workflowId,
          }),
          type: agentWorkflowStageEventType(mapping.stageIndex),
        },
      ]);
      const current = agentWorkflowRunDirectoryRecordSchema.safeParse(
        await this.ctx.storage.get(key),
      );

      if (
        current.success &&
        !current.data.delivered &&
        JSON.stringify(current.data) === JSON.stringify(mapping)
      ) {
        await this.ctx.storage.put(key, { ...current.data, delivered: true });
        await this.ctx.storage.delete(agentWorkflowPendingKey(runId));
      }
    } catch {
      await this.#scheduleAgentWorkflowRunDelivery(runId);
    }
  }

  async #scheduleAgentWorkflowRunDelivery(runId: string): Promise<void> {
    await this.schedule(
      new Date(Date.now() + 5_000),
      "deliverAgentWorkflowRunEvent",
      { runId },
      { idempotent: true, retry: { maxAttempts: 5 } },
    );
  }

  async #sealAgentWorkflowRunDeliveries(workflowId: string): Promise<void> {
    const indexes = await this.ctx.storage.list({
      prefix: `${AGENT_WORKFLOW_RUN_INDEX_PREFIX}${workflowId}:`,
    });

    for (const key of indexes.keys()) {
      const runId = key.slice(key.lastIndexOf(":") + 1);
      const mappingKey = agentWorkflowRunKey(runId);
      const mapping = agentWorkflowRunDirectoryRecordSchema.safeParse(
        await this.ctx.storage.get(mappingKey),
      );

      if (mapping.success && !mapping.data.delivered) {
        await this.ctx.storage.put(mappingKey, { ...mapping.data, delivered: true });
      }
      await this.ctx.storage.delete(agentWorkflowPendingKey(runId));
    }
  }

  async #prepareSession(
    ownerKey: string,
    agentId: string,
    runId: string,
    deadlineAt: number,
    availableUntil: number,
    visible: boolean,
    continuation: SessionContinuation | undefined,
    workflowId: string | null,
  ): Promise<
    | { mapping: RunSessionDirectoryRecord; ok: true }
    | { ok: false; result: AcceptRunAdmissionResult }
  > {
    if (!this.#directoryMatches({ agentId, ownerKey })) {
      return { ok: false, result: invalidAdmission };
    }

    const existingMapping = await this.#readRunSession(runId);

    if (existingMapping !== undefined) {
      return JSON.stringify(existingMapping.continuation ?? undefined) ===
        JSON.stringify(continuation)
        ? { mapping: existingMapping, ok: true }
        : { ok: false, result: invalidAdmission };
    }

    await this.#cleanupExpiredSessions();
    const currentTime = Date.now();
    let record: SessionDirectoryRecord;

    if (continuation === undefined) {
      if ((await this.#sessionRecords()).length >= MAXIMUM_AGENT_SESSIONS) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      record = sessionDirectoryRecordSchema.parse({
        activeRunId: runId,
        agentId,
        availableUntil,
        branchId: newBranchId(),
        branchRevision: 1,
        createdAt: currentTime,
        ownerKey,
        sessionId: newSessionId(),
        updatedAt: currentTime,
        visible,
        workflowId,
      });
    } else {
      const current = await this.#readAvailableSession(continuation.sessionId);

      if (
        current === undefined ||
        current.workflowId !== workflowId ||
        (workflowId === null && !current.visible)
      ) {
        return {
          ok: false,
          result: {
            error: { code: "session_not_found", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      if (current.deleting) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      if (await this.#reconcileActiveRun(current)) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      const reservation = await this.ctx.storage.transaction(async (storage) => {
        const refreshed = sessionDirectoryRecordSchema.safeParse(
          await storage.get(sessionRecordKey(current.sessionId)),
        );

        if (
          !refreshed.success ||
          refreshed.data.workflowId !== workflowId ||
          (workflowId === null && !refreshed.data.visible) ||
          refreshed.data.availableUntil <= Date.now()
        ) {
          return { error: "session_not_found" as const };
        }

        if (refreshed.data.deleting || refreshed.data.activeRunId !== null) {
          return { error: "session_busy" as const };
        }

        if (
          refreshed.data.branchId !== continuation.branchId ||
          refreshed.data.branchRevision !== continuation.expectedBranchRevision
        ) {
          return { error: "branch_revision_conflict" as const };
        }

        const reservedRecord = sessionDirectoryRecordSchema.parse({
          ...refreshed.data,
          activeRunId: runId,
          availableUntil: Math.max(refreshed.data.availableUntil, availableUntil),
          branchRevision: refreshed.data.branchRevision + 1,
          updatedAt: currentTime,
        });
        const reservedMapping = runSessionDirectoryRecordSchema.parse({
          continuation,
          deadlineAt,
          previousRevision: refreshed.data.branchRevision,
          session: {
            branchId: reservedRecord.branchId,
            branchRevision: reservedRecord.branchRevision,
            sessionId: reservedRecord.sessionId,
          },
        });

        await storage.put({
          [runSessionKey(runId)]: reservedMapping,
          [sessionRunIndexKey(reservedRecord.sessionId, runId)]: true,
          [sessionRecordKey(reservedRecord.sessionId)]: reservedRecord,
        });
        return { mapping: reservedMapping };
      });

      if ("error" in reservation) {
        return {
          ok: false,
          result: {
            error: { code: reservation.error, message: "Run admission denied." },
            ok: false,
          },
        };
      }

      await this.#scheduleSessionCleanup();
      return { mapping: reservation.mapping, ok: true };
    }

    const mapping = runSessionDirectoryRecordSchema.parse({
      continuation: continuation ?? null,
      deadlineAt,
      previousRevision: 0,
      session: {
        branchId: record.branchId,
        branchRevision: record.branchRevision,
        sessionId: record.sessionId,
      },
    });

    await this.ctx.storage.put({
      [runSessionKey(runId)]: mapping,
      [sessionRunIndexKey(record.sessionId, runId)]: true,
      [sessionRecordKey(record.sessionId)]: record,
    });
    await this.#scheduleSessionCleanup();

    return { mapping, ok: true };
  }

  async #rollbackPreparedSession(runId: string, mapping: RunSessionDirectoryRecord): Promise<void> {
    const record = await this.#readSession(mapping.session.sessionId);

    if (record?.activeRunId !== runId) {
      return;
    }

    if (mapping.previousRevision === 0) {
      await this.ctx.storage.delete([
        runSessionKey(runId),
        sessionRunIndexKey(record.sessionId, runId),
        sessionRecordKey(record.sessionId),
      ]);
      return;
    }

    await this.ctx.storage.put(sessionRecordKey(record.sessionId), {
      ...record,
      activeRunId: null,
      branchRevision: mapping.previousRevision,
      updatedAt: Date.now(),
    });
    await this.ctx.storage.delete([
      runSessionKey(runId),
      sessionRunIndexKey(record.sessionId, runId),
    ]);
  }

  async #sessionForRunInput(input: unknown) {
    const capability: unknown =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? Reflect.get(input, "capability")
        : undefined;
    const runId: unknown =
      typeof capability === "object" && capability !== null && !Array.isArray(capability)
        ? Reflect.get(capability, "runId")
        : undefined;
    const parsedRunId = runIdSchema.safeParse(runId);

    if (!parsedRunId.success) {
      return undefined;
    }

    const mapping = await this.#readRunSession(parsedRunId.data);

    if (mapping === undefined) {
      return undefined;
    }

    return this.#session(mapping.session);
  }

  #session(session: RunSession) {
    return this.sessionNamespace().getByName(
      crewSessionObjectName({
        agentId: this.#agentIdentity().agentId,
        ownerKey: this.#agentIdentity().ownerKey,
        sessionId: session.sessionId,
      }),
    );
  }

  #agentIdentity(): { agentId: string; ownerKey: string } {
    const match = /^crew-agent:([^:]+):(.+)$/.exec(this.ctx.id.name ?? "");

    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("CrewAgent session directory identity is invalid.");
    }

    return { agentId: match[2], ownerKey: match[1] };
  }

  #directoryMatches(input: { agentId: string; ownerKey: string }): boolean {
    return this.ctx.id.name === crewAgentObjectName(input);
  }

  async #readSession(sessionId: string): Promise<SessionDirectoryRecord | undefined> {
    const parsed = sessionDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(sessionRecordKey(sessionId)),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async #readAvailableSession(sessionId: string): Promise<SessionDirectoryRecord | undefined> {
    const record = await this.#readSession(sessionId);

    if (record === undefined || !isExpiredIdleSession(record, Date.now())) {
      return record;
    }

    await this.#deleteExpiredSession(record);
    return undefined;
  }

  async #readRunSession(runId: string): Promise<RunSessionDirectoryRecord | undefined> {
    const parsed = runSessionDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(runSessionKey(runId)),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async #sessionRecords(): Promise<SessionDirectoryRecord[]> {
    const stored = await this.ctx.storage.list({ prefix: SESSION_RECORD_PREFIX });
    return [...stored.values()]
      .flatMap((value) => {
        const parsed = sessionDirectoryRecordSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async #cleanupExpiredSessions(): Promise<void> {
    const currentTime = Date.now();
    const expiryDeletionIntents = await this.ctx.storage.list({
      prefix: SESSION_EXPIRY_DELETE_INTENT_PREFIX,
    });

    for (const [key, value] of expiryDeletionIntents) {
      const intent = sessionExpiryDeleteIntentSchema.safeParse(value);

      if (!intent.success) {
        continue;
      }

      const record = await this.#readSession(intent.data.sessionId);
      if (record === undefined) {
        await this.ctx.storage.delete(key);
        continue;
      }

      if (intent.data.claimedAt + SESSION_EXPIRY_DELETE_RETRY_MILLISECONDS > currentTime) {
        continue;
      }

      await this.#deleteExpiredSession(record);
    }

    const expired = (await this.#sessionRecords()).filter((record) =>
      isExpiredIdleSession(record, currentTime),
    );

    for (const record of expired) {
      await this.#deleteExpiredSession(record);
    }

    const deletions = await this.ctx.storage.list({ prefix: SESSION_DELETE_PREFIX });
    const expiredDeletions = [...deletions.entries()].flatMap(([key, value]) => {
      const parsed = sessionDeleteReceiptSchema.safeParse(value);
      return parsed.success &&
        parsed.data.deletedAt + DEFAULT_AGENT_SESSION_RETENTION_SECONDS * 1_000 <= currentTime
        ? [{ key, sessionId: parsed.data.sessionId }]
        : [];
    });

    for (const deletion of expiredDeletions) {
      await this.#deleteDirectorySession(deletion.sessionId);
      await this.ctx.storage.delete(deletion.key);
    }
  }

  async #scheduleSessionCleanup(): Promise<void> {
    const sessionExpiries = (await this.#sessionRecords())
      .filter((record) => !record.deleting && record.activeRunId === null)
      .map((record) => record.availableUntil);
    const deletionReceipts = await this.ctx.storage.list({ prefix: SESSION_DELETE_PREFIX });
    const deletionExpiries = [...deletionReceipts.values()].flatMap((value) => {
      const parsed = sessionDeleteReceiptSchema.safeParse(value);
      return parsed.success
        ? [parsed.data.deletedAt + DEFAULT_AGENT_SESSION_RETENTION_SECONDS * 1_000]
        : [];
    });
    const expiryDeletionIntents = await this.ctx.storage.list({
      prefix: SESSION_EXPIRY_DELETE_INTENT_PREFIX,
    });
    const expiryDeletionRetries = [...expiryDeletionIntents.values()].flatMap((value) => {
      const parsed = sessionExpiryDeleteIntentSchema.safeParse(value);
      return parsed.success
        ? [parsed.data.claimedAt + SESSION_EXPIRY_DELETE_RETRY_MILLISECONDS]
        : [];
    });
    const nextExpiry = [...sessionExpiries, ...deletionExpiries, ...expiryDeletionRetries].toSorted(
      (left, right) => left - right,
    )[0];

    if (nextExpiry !== undefined) {
      await this.schedule(new Date(Math.max(Date.now() + 1, nextExpiry)), "cleanupExpiredSessions");
    }
  }

  async #deleteExpiredSession(record: SessionDirectoryRecord): Promise<void> {
    const intentKey = sessionExpiryDeleteIntentKey(record.sessionId);
    const reserved = await this.ctx.storage.transaction(async (storage) => {
      const current = sessionDirectoryRecordSchema.safeParse(
        await storage.get(sessionRecordKey(record.sessionId)),
      );
      const intent = sessionExpiryDeleteIntentSchema.safeParse(await storage.get(intentKey));
      const claimedAt = Date.now();

      if (!current.success) {
        if (intent.success) {
          await storage.delete(intentKey);
        }
        return undefined;
      }

      if (intent.success) {
        if (
          !current.data.deleting ||
          current.data.activeRunId !== null ||
          intent.data.branchRevision !== current.data.branchRevision ||
          intent.data.sessionId !== current.data.sessionId
        ) {
          return undefined;
        }

        await storage.put(intentKey, { ...intent.data, claimedAt });
        return current.data;
      }

      if (
        current.data.sessionId !== record.sessionId ||
        current.data.branchRevision !== record.branchRevision ||
        !isExpiredIdleSession(current.data, claimedAt)
      ) {
        return undefined;
      }

      const claimed = sessionDirectoryRecordSchema.parse({
        ...current.data,
        deleting: true,
        updatedAt: claimedAt,
      });
      await storage.put({
        [intentKey]: {
          branchRevision: claimed.branchRevision,
          claimedAt,
          sessionId: claimed.sessionId,
        },
        [sessionRecordKey(claimed.sessionId)]: claimed,
      });
      return claimed;
    });

    if (reserved === undefined) {
      return;
    }

    try {
      const deleted = await this.#session({
        branchId: reserved.branchId,
        branchRevision: reserved.branchRevision,
        sessionId: reserved.sessionId,
      }).deleteSessionStorage({
        objectName: crewSessionObjectName({
          agentId: reserved.agentId,
          ownerKey: reserved.ownerKey,
          sessionId: reserved.sessionId,
        }),
      });

      if (!deleted) {
        return;
      }

      await this.#deleteDirectorySession(reserved.sessionId);
      await this.ctx.storage.delete(intentKey);
    } catch {
      // Keep the expiry intent sealed so the alarm can retry exact cleanup without reopening the
      // possibly emptied child runtime.
    }
  }

  async #deleteDirectorySession(sessionId: string): Promise<void> {
    const prefix = sessionRunIndexPrefix(sessionId);

    for (;;) {
      const indexes = await this.ctx.storage.list<boolean>({
        limit: SESSION_RUN_PAGE_SIZE,
        prefix,
      });

      if (indexes.size === 0) {
        break;
      }

      const runKeys = [...indexes.keys()].map((key) => runSessionKey(key.slice(prefix.length)));
      await this.ctx.storage.delete([...indexes.keys(), ...runKeys]);
    }

    await this.ctx.storage.delete(sessionRecordKey(sessionId));
  }

  async #reconcileActiveRun(record: SessionDirectoryRecord): Promise<boolean> {
    if (record.activeRunId === null) {
      return false;
    }

    const session: RunSession = {
      branchId: record.branchId,
      branchRevision: record.branchRevision,
      sessionId: record.sessionId,
    };

    try {
      const status = await this.#session(session).inspectSessionRunState({
        runId: record.activeRunId,
        session,
      });

      if (status !== null && ["cancelled", "completed", "failed"].includes(status)) {
        return !(await this.#clearReconciledRun(record));
      }

      if (status === null) {
        const mapping = await this.#readRunSession(record.activeRunId);

        if (mapping !== undefined && Date.now() >= mapping.deadlineAt) {
          return !(await this.#clearReconciledRun(record));
        }
      }
    } catch {
      // Fail closed while the exact session runtime is unavailable.
    }

    return true;
  }

  async #clearReconciledRun(record: SessionDirectoryRecord): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const current = sessionDirectoryRecordSchema.safeParse(
        await storage.get(sessionRecordKey(record.sessionId)),
      );

      if (!current.success) {
        return false;
      }

      if (current.data.activeRunId === null) {
        return true;
      }

      if (
        current.data.activeRunId !== record.activeRunId ||
        current.data.branchRevision !== record.branchRevision ||
        current.data.deleting
      ) {
        return false;
      }

      await storage.put(sessionRecordKey(record.sessionId), {
        ...current.data,
        activeRunId: null,
        updatedAt: Date.now(),
      });
      return true;
    });
  }
}
