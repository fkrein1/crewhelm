import {
  acceptRunAdmissionResultSchema,
  cancelAdmittedRunResultSchema,
  cancelRunInputSchema,
  cancelRunResultSchema,
  crewAgentObjectName,
  decideRunToolApprovalInputSchema,
  decideRunToolApprovalResultSchema,
  inspectAdmittedRunResultSchema,
  inspectRunInputSchema,
  inspectRunResultSchema,
  MAXIMUM_RUN_TIMELINE_EVENTS,
  listAdmittedRunToolApprovalsResultSchema,
  listRunToolApprovalsInputSchema,
  listRunToolApprovalsResultSchema,
  startRunInputSchema,
  startRunResultSchema,
  runTimelineEventSchema,
  type CancelRunResult,
  type DecideRunToolApprovalResult,
  type InspectRunResult,
  type ListRunToolApprovalsResult,
  type OwnerAuthority,
  type PendingToolApproval,
  type RedeemRunReceiverCapabilityResult,
  type Run,
  type RunTimelineEvent,
  type StartRunResult,
} from "@crewhelm/contracts";
import { asc, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";
import type { CrewAgent } from "../../agent/durable-object.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import {
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  toolApprovals,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import type { RunAdmissions } from "../runs/module.js";
import type { ToolExecutions } from "../runs/tool-execution.js";
import { RunReceiverCapabilities } from "./protocol.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type StartRunFailure = Extract<StartRunResult, { ok: false }>;
type InspectRunFailure = Extract<InspectRunResult, { ok: false }>;
type CancelRunFailure = Extract<CancelRunResult, { ok: false }>;
type ListApprovalsFailure = Extract<ListRunToolApprovalsResult, { ok: false }>;
type DecideApprovalFailure = Extract<DecideRunToolApprovalResult, { ok: false }>;
type StoredRunAdmission = NonNullable<ReturnType<RunAdmissions["read"]>>;
type CrewAgentStub = ReturnType<DurableObjectNamespace<CrewAgent>["getByName"]>;

const TIMELINE_EVENT_ORDER = [
  "run.admitted",
  "run.started",
  "tool.approval_required",
  "tool.approval_approved",
  "tool.approval_rejected",
  "tool.execution_reserved",
  "tool.execution_dispatched",
  "tool.execution_completed",
  "tool.execution_failed",
  "tool.execution_unknown",
  "tool.execution_reconciled_applied",
  "tool.execution_reconciled_not_applied",
  "run.cancellation_requested",
  "run.cancelled",
  "run.completed",
  "run.failed",
] as const satisfies readonly RunTimelineEvent["event"][];
const TIMELINE_EVENT_PRIORITY = new Map(TIMELINE_EVENT_ORDER.map((event, index) => [event, index]));

function alignRunCompletion(run: Run, timeline: RunTimelineEvent[]): Run {
  const terminalEvent =
    run.status === "completed"
      ? "run.completed"
      : run.status === "failed"
        ? "run.failed"
        : run.status === "cancelled"
          ? "run.cancelled"
          : undefined;
  const terminal = timeline.find((event) => event.event === terminalEvent);

  return terminal === undefined ? run : { ...run, completedAt: terminal.occurredAt };
}

export function deniedStartRun(code: StartRunFailure["error"]["code"]): StartRunFailure {
  return {
    error: { code, message: "Run request denied." },
    ok: false,
  };
}

export function deniedInspectRun(code: InspectRunFailure["error"]["code"]): InspectRunFailure {
  return {
    error: { code, message: "Run request denied." },
    ok: false,
  };
}

export function deniedCancelRun(code: CancelRunFailure["error"]["code"]): CancelRunFailure {
  return {
    error: { code, message: "Run cancellation denied." },
    ok: false,
  };
}

export function deniedListRunToolApprovals(
  code: ListApprovalsFailure["error"]["code"],
): ListApprovalsFailure {
  return {
    error: { code, message: "Tool approval request denied." },
    ok: false,
  };
}

export function deniedDecideRunToolApproval(
  code: DecideApprovalFailure["error"]["code"],
): DecideApprovalFailure {
  return {
    error: { code, message: "Tool approval request denied." },
    ok: false,
  };
}

export class AgentChannel {
  readonly #admissions: RunAdmissions;
  readonly #capabilities: RunReceiverCapabilities;
  readonly #crewAgents: DurableObjectNamespace<CrewAgent>;
  readonly #database: Database;
  readonly #toolExecutions: ToolExecutions;

  constructor(
    objectName: string | undefined,
    database: Database,
    crewAgents: DurableObjectNamespace<CrewAgent>,
    admissions: RunAdmissions,
    executionStore: ToolExecutions,
  ) {
    this.#admissions = admissions;
    this.#capabilities = new RunReceiverCapabilities(objectName, admissions);
    this.#crewAgents = crewAgents;
    this.#database = database;
    this.#toolExecutions = executionStore;
  }

  redeem(input: unknown): RedeemRunReceiverCapabilityResult {
    return this.#capabilities.redeem(input);
  }

  #agent(authority: OwnerAuthority, admission: StoredRunAdmission) {
    return this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId: admission.agentId,
        ownerKey: authority.ownerKey,
      }),
    );
  }

  async #inspectAdmittedRun(
    authority: OwnerAuthority,
    admission: StoredRunAdmission,
    agent: CrewAgentStub,
  ) {
    try {
      const capability = this.#capabilities.issue(authority, admission, "inspect");

      if (capability === undefined) {
        return undefined;
      }

      const result = inspectAdmittedRunResultSchema.safeParse(
        await agent.inspectAdmittedRun({ capability }),
      );

      return result.success &&
        result.data.ok &&
        result.data.run.runId === admission.runId &&
        result.data.run.agentId === admission.agentId &&
        result.data.run.agentRevision === admission.agentRevision
        ? result.data
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #pendingApprovals(
    authority: OwnerAuthority,
    admission: StoredRunAdmission,
    agent?: CrewAgentStub,
  ) {
    const capability = this.#capabilities.issue(authority, admission, "list_approvals");

    if (capability === undefined) {
      return { state: "unavailable" } as const;
    }

    try {
      const result = listAdmittedRunToolApprovalsResultSchema.safeParse(
        await (agent ?? this.#agent(authority, admission)).listAdmittedRunToolApprovals({
          capability,
        }),
      );

      if (!result.success || !result.data.ok) {
        return { state: "invalid" } as const;
      }

      for (const approval of result.data.approvals) {
        const existing = this.#database
          .select({ executionId: toolApprovals.executionId })
          .from(toolApprovals)
          .where(eq(toolApprovals.executionId, approval.executionId))
          .get();

        if (existing !== undefined) {
          continue;
        }

        const inserted = this.#database
          .insert(toolApprovals)
          .values({
            actionDigest: approval.actionDigest,
            clientId: authority.clientId,
            decision: null,
            decidedAt: null,
            executionId: approval.executionId,
            expiresAt: Date.parse(approval.expiresAt),
            grantId: approval.grantId,
            requestedAt: Date.parse(approval.requestedAt),
            runId: admission.runId,
            toolCallId: approval.toolCallId,
          })
          .onConflictDoNothing()
          .returning({ executionId: toolApprovals.executionId })
          .all();

        if (inserted.length === 1) {
          this.#database
            .insert(auditEvents)
            .values({
              action: "tool.approval_required",
              clientId: authority.clientId,
              occurredAt: Date.parse(approval.requestedAt),
              subjectId: approval.toolCallId,
            })
            .run();
        }
      }

      return { approvals: result.data.approvals, state: "available" as const };
    } catch {
      return { state: "unavailable" } as const;
    }
  }

  #timeline(
    admission: StoredRunAdmission,
    run: Run,
    pendingApprovals: PendingToolApproval[] = [],
  ): RunTimelineEvent[] {
    this.#toolExecutions.reconcileExpired(Date.now());
    const events = new Map<string, RunTimelineEvent>();
    const add = (
      event: RunTimelineEvent["event"],
      occurredAt: number | string,
      toolCallId?: string,
    ): void => {
      const candidate = runTimelineEventSchema.parse({
        event,
        occurredAt:
          typeof occurredAt === "number" ? new Date(occurredAt).toISOString() : occurredAt,
        ...(toolCallId === undefined ? {} : { toolCallId }),
      });
      const key = `${candidate.event}:${candidate.toolCallId ?? ""}`;
      const existing = events.get(key);

      if (
        existing === undefined ||
        Date.parse(candidate.occurredAt) < Date.parse(existing.occurredAt)
      ) {
        events.set(key, candidate);
      }
    };

    add("run.admitted", admission.createdAt);

    if (run.startedAt !== undefined) {
      add("run.started", run.startedAt);
    }

    for (const approval of this.#database
      .select({
        decidedAt: toolApprovals.decidedAt,
        decision: toolApprovals.decision,
        requestedAt: toolApprovals.requestedAt,
        toolCallId: toolApprovals.toolCallId,
      })
      .from(toolApprovals)
      .where(eq(toolApprovals.runId, admission.runId))
      .orderBy(asc(toolApprovals.requestedAt))
      .all()) {
      add("tool.approval_required", approval.requestedAt, approval.toolCallId);
      if (approval.decision !== null && approval.decidedAt !== null) {
        add(
          approval.decision === "approved" ? "tool.approval_approved" : "tool.approval_rejected",
          approval.decidedAt,
          approval.toolCallId,
        );
      }
    }

    for (const approval of pendingApprovals) {
      add("tool.approval_required", approval.requestedAt, approval.toolCallId);
    }

    for (const execution of this.#database
      .select({
        completedAt: toolExecutions.completedAt,
        dispatchedAt: toolExecutions.dispatchedAt,
        reconciliation: toolExecutions.reconciliation,
        reconciledAt: toolExecutions.reconciledAt,
        startedAt: toolExecutions.startedAt,
        status: toolExecutions.status,
        toolCallId: toolExecutions.toolCallId,
      })
      .from(toolExecutions)
      .where(eq(toolExecutions.runId, admission.runId))
      .orderBy(asc(toolExecutions.startedAt))
      .all()) {
      add("tool.execution_reserved", execution.startedAt, execution.toolCallId);

      if (execution.dispatchedAt !== null) {
        add("tool.execution_dispatched", execution.dispatchedAt, execution.toolCallId);
      }

      if (
        execution.reconciliation !== null &&
        execution.completedAt !== null &&
        execution.reconciledAt !== null
      ) {
        add("tool.execution_unknown", execution.completedAt, execution.toolCallId);
        add(
          `tool.execution_reconciled_${execution.reconciliation}`,
          execution.reconciledAt,
          execution.toolCallId,
        );
      } else if (execution.status !== "reserved" && execution.completedAt !== null) {
        add(`tool.execution_${execution.status}`, execution.completedAt, execution.toolCallId);
      }
    }

    if (admission.cancellationRequestedAt !== null) {
      add("run.cancellation_requested", admission.cancellationRequestedAt);
    }

    if (admission.cancelledAt !== null) {
      add("run.cancelled", admission.cancelledAt);
    } else if (run.status === "cancelled" && run.completedAt !== undefined) {
      add("run.cancelled", run.completedAt);
    }

    if (run.completedAt !== undefined) {
      const terminalAt = Math.max(
        Date.parse(run.completedAt),
        ...[...events.values()].map((event) => Date.parse(event.occurredAt)),
      );

      if (run.status === "completed") {
        add("run.completed", terminalAt);
      } else if (run.status === "failed") {
        add("run.failed", terminalAt);
      }
    }

    return [...events.values()]
      .toSorted(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          (TIMELINE_EVENT_PRIORITY.get(left.event) ?? Number.MAX_SAFE_INTEGER) -
            (TIMELINE_EVENT_PRIORITY.get(right.event) ?? Number.MAX_SAFE_INTEGER) ||
          (left.toolCallId ?? "").localeCompare(right.toolCallId ?? ""),
      )
      .slice(0, MAXIMUM_RUN_TIMELINE_EVENTS);
  }

  async start(authority: OwnerAuthority, input: unknown): Promise<StartRunResult> {
    const request = startRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedStartRun("invalid_request");
    }

    const admission = await this.#admissions.create(authority, {
      agentId: request.data.agentId,
      expectedRevision: request.data.expectedRevision,
      idempotencyKey: request.data.idempotencyKey,
      promptCharacters: request.data.prompt.length,
      promptDigest: await digestRunPrompt(request.data.prompt),
    });

    if (!admission.ok) {
      return deniedStartRun(admission.error.code);
    }

    const runId = admission.state === "issued" ? admission.permit.runId : admission.admission.runId;
    const storedAdmission = this.#admissions.read(runId);

    if (storedAdmission === undefined) {
      return deniedStartRun("run_unavailable");
    }

    const { agentId, agentRevision } = storedAdmission;
    const agent = this.#agent(authority, storedAdmission);

    if (storedAdmission.cancellationRequestedAt !== null) {
      return startRunResultSchema.parse({
        created: false,
        ok: true,
        run: {
          agentId,
          agentRevision,
          createdAt: new Date(storedAdmission.createdAt).toISOString(),
          ...(storedAdmission.cancelledAt === null
            ? {}
            : { completedAt: new Date(storedAdmission.cancelledAt).toISOString() }),
          runId,
          status: storedAdmission.cancelledAt === null ? "cancelling" : "cancelled",
        },
      });
    }

    if (admission.state === "expired") {
      return startRunResultSchema.parse({
        created: false,
        ok: true,
        run: {
          agentId,
          agentRevision,
          createdAt: new Date(storedAdmission.createdAt).toISOString(),
          runId,
          status: "failed",
        },
      });
    }

    let accepted: unknown;

    try {
      if (admission.state === "issued") {
        accepted = await agent.acceptRunAdmission({
          permit: admission.permit,
          prompt: request.data.prompt,
        });
      } else {
        const capability = this.#capabilities.issue(authority, storedAdmission, "resume");

        if (capability === undefined) {
          return deniedStartRun("run_unavailable");
        }

        accepted = await agent.resumeRunAdmission({
          capability,
          prompt: request.data.prompt,
        });
      }
    } catch {
      return deniedStartRun("run_unavailable");
    }

    const acceptance = acceptRunAdmissionResultSchema.safeParse(accepted);

    if (
      !acceptance.success ||
      !acceptance.data.ok ||
      acceptance.data.runId !== runId ||
      acceptance.data.agentId !== agentId ||
      acceptance.data.agentRevision !== agentRevision
    ) {
      return deniedStartRun("run_unavailable");
    }

    const inspected = await this.#inspectAdmittedRun(authority, storedAdmission, agent);

    if (inspected === undefined) {
      return deniedStartRun("run_unavailable");
    }

    const run: Run = {
      ...inspected.run,
      createdAt: new Date(storedAdmission.createdAt).toISOString(),
    };

    return startRunResultSchema.parse({
      created: admission.state === "issued" && admission.created,
      ok: true,
      run: alignRunCompletion(run, this.#timeline(storedAdmission, run)),
    });
  }

  async inspect(authority: OwnerAuthority, input: unknown): Promise<InspectRunResult> {
    const request = inspectRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedInspectRun("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedInspectRun("run_not_found");
    }

    if (admission.cancellationRequestedAt !== null) {
      const inspected =
        admission.status === "redeemed"
          ? await this.#inspectAdmittedRun(authority, admission, this.#agent(authority, admission))
          : undefined;
      const run: Run = {
        agentId: admission.agentId,
        agentRevision: admission.agentRevision,
        ...(admission.cancelledAt === null
          ? {}
          : { completedAt: new Date(admission.cancelledAt).toISOString() }),
        createdAt: new Date(admission.createdAt).toISOString(),
        runId: admission.runId,
        ...(inspected?.run.startedAt === undefined ? {} : { startedAt: inspected.run.startedAt }),
        status: admission.cancelledAt === null ? "cancelling" : "cancelled",
      };

      return inspectRunResultSchema.parse({
        ok: true,
        run,
        timeline: this.#timeline(admission, run),
      });
    }

    if (admission.status !== "redeemed") {
      const run = {
        agentId: admission.agentId,
        agentRevision: admission.agentRevision,
        createdAt: new Date(admission.createdAt).toISOString(),
        runId: admission.runId,
        status: admission.status === "expired" ? ("failed" as const) : ("queued" as const),
      };

      return inspectRunResultSchema.parse({
        ok: true,
        run,
        timeline: this.#timeline(admission, run),
      });
    }

    const agent = this.#agent(authority, admission);
    const inspected = await this.#inspectAdmittedRun(authority, admission, agent);

    if (inspected === undefined) {
      return deniedInspectRun("run_unavailable");
    }

    const inspectedRun: Run = {
      ...inspected.run,
      createdAt: new Date(admission.createdAt).toISOString(),
    };
    const pending = await this.#pendingApprovals(authority, admission, agent);
    const waitingForApproval = pending.state === "available" && pending.approvals.length > 0;
    const run: Run = waitingForApproval
      ? {
          agentId: inspectedRun.agentId,
          agentRevision: inspectedRun.agentRevision,
          createdAt: inspectedRun.createdAt,
          runId: inspectedRun.runId,
          ...(inspectedRun.startedAt === undefined ? {} : { startedAt: inspectedRun.startedAt }),
          status: "running",
        }
      : inspectedRun;

    const timeline = this.#timeline(
      admission,
      run,
      pending.state === "available" ? pending.approvals : [],
    );

    return inspectRunResultSchema.parse({
      ok: true,
      run: alignRunCompletion(run, timeline),
      timeline,
    });
  }

  async cancel(authority: OwnerAuthority, input: unknown): Promise<CancelRunResult> {
    const request = cancelRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedCancelRun("invalid_request");
    }

    let admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedCancelRun("run_not_found");
    }

    if (admission.cancelledAt !== null) {
      return cancelRunResultSchema.parse({
        cancelled: true,
        ok: true,
        runId: admission.runId,
      });
    }

    const agent = this.#agent(authority, admission);

    if (admission.status === "redeemed" && admission.cancellationRequestedAt === null) {
      const inspected = await this.#inspectAdmittedRun(authority, admission, agent);
      const pending = await this.#pendingApprovals(authority, admission, agent);

      if (inspected === undefined || pending.state !== "available") {
        return deniedCancelRun("run_unavailable");
      }

      if (
        pending.approvals.length === 0 &&
        ["cancelled", "completed", "failed"].includes(inspected.run.status)
      ) {
        return deniedCancelRun("run_not_cancellable");
      }
    }

    const cancellation = this.#admissions.requestCancellation(authority, admission.runId);

    if (cancellation === "not_found") {
      return deniedCancelRun("run_not_found");
    }

    if (cancellation === "not_cancellable") {
      return deniedCancelRun("run_not_cancellable");
    }

    admission = this.#admissions.read(admission.runId);

    if (admission === undefined) {
      return deniedCancelRun("run_unavailable");
    }

    if (admission.status === "redeemed") {
      const capability = this.#capabilities.issue(authority, admission, "cancel");

      if (capability === undefined) {
        return deniedCancelRun("run_unavailable");
      }

      let cancelled: unknown;

      try {
        cancelled = await agent.cancelAdmittedRun({ capability });
      } catch {
        return deniedCancelRun("run_unavailable");
      }

      const result = cancelAdmittedRunResultSchema.safeParse(cancelled);

      if (!result.success || !result.data.ok) {
        return deniedCancelRun("run_unavailable");
      }

      if (!result.data.cancelled) {
        const inspected = await this.#inspectAdmittedRun(authority, admission, agent);

        if (inspected === undefined) {
          return deniedCancelRun("run_unavailable");
        }

        if (inspected.run.status === "cancelled") {
          if (!this.#admissions.completeCancellation(authority, admission.runId)) {
            return deniedCancelRun("run_unavailable");
          }

          return cancelRunResultSchema.parse({
            cancelled: true,
            ok: true,
            runId: admission.runId,
          });
        }

        if (!["completed", "failed"].includes(inspected.run.status)) {
          return deniedCancelRun("run_unavailable");
        }

        if (!this.#admissions.releaseCancellation(authority, admission.runId)) {
          return deniedCancelRun("run_unavailable");
        }

        return deniedCancelRun("run_not_cancellable");
      }
    }

    if (!this.#admissions.completeCancellation(authority, admission.runId)) {
      return deniedCancelRun("run_unavailable");
    }

    return cancelRunResultSchema.parse({
      cancelled: true,
      ok: true,
      runId: admission.runId,
    });
  }

  async listApprovals(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ListRunToolApprovalsResult> {
    const request = listRunToolApprovalsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedListRunToolApprovals("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedListRunToolApprovals("run_not_found");
    }

    if (admission.status !== "redeemed" || admission.cancellationRequestedAt !== null) {
      return listRunToolApprovalsResultSchema.parse({ approvals: [], ok: true });
    }

    const listed = await this.#pendingApprovals(authority, admission);

    if (listed.state !== "available") {
      return deniedListRunToolApprovals("run_unavailable");
    }

    return listRunToolApprovalsResultSchema.parse({
      approvals: listed.approvals,
      ok: true,
    });
  }

  async decideApproval(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<DecideRunToolApprovalResult> {
    const request = decideRunToolApprovalInputSchema.safeParse(input);

    if (!request.success) {
      return deniedDecideRunToolApproval("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedDecideRunToolApproval("run_not_found");
    }

    if (admission.status !== "redeemed" || admission.cancellationRequestedAt !== null) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const agent = this.#agent(authority, admission);
    const pending = await this.#pendingApprovals(authority, admission, agent);

    if (pending.state === "unavailable") {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const approval =
      pending.state === "available"
        ? pending.approvals.find((candidate) => candidate.executionId === request.data.executionId)
        : undefined;

    if (approval === undefined || Date.parse(approval.expiresAt) <= Date.now()) {
      return deniedDecideRunToolApproval("approval_not_found");
    }

    const currentTime = Date.now();
    const storedDecision = request.data.decision === "approve" ? "approved" : "rejected";
    const existing = this.#database
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.executionId, approval.executionId))
      .get();

    if (
      existing !== undefined &&
      (existing.runId !== request.data.runId ||
        existing.toolCallId !== approval.toolCallId ||
        existing.grantId !== approval.grantId ||
        existing.actionDigest !== approval.actionDigest ||
        (existing.decision !== null && existing.decision !== storedDecision))
    ) {
      return deniedDecideRunToolApproval("approval_not_found");
    }

    const grantAuthority = this.#database
      .select({
        agentId: capabilityGrants.agentId,
        agentRevision: capabilityGrants.agentRevision,
        agentStatus: agents.status,
        connectionStatus: connections.status,
        currentAgentRevision: agents.currentRevision,
        grantStatus: capabilityGrants.status,
      })
      .from(capabilityGrants)
      .innerJoin(connections, eq(connections.connectionId, capabilityGrants.connectionId))
      .innerJoin(agents, eq(agents.agentId, capabilityGrants.agentId))
      .where(eq(capabilityGrants.grantId, approval.grantId))
      .get();

    if (
      grantAuthority === undefined ||
      grantAuthority.agentId !== admission.agentId ||
      grantAuthority.agentRevision !== admission.agentRevision ||
      grantAuthority.currentAgentRevision !== admission.agentRevision ||
      grantAuthority.agentStatus !== "active" ||
      grantAuthority.connectionStatus !== "active" ||
      grantAuthority.grantStatus !== "active"
    ) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    let decisionRecorded = existing?.decision === null;

    if (existing === undefined) {
      this.#database
        .insert(toolApprovals)
        .values({
          actionDigest: approval.actionDigest,
          clientId: authority.clientId,
          decidedAt: currentTime,
          decision: storedDecision,
          executionId: approval.executionId,
          expiresAt: Date.parse(approval.expiresAt),
          grantId: approval.grantId,
          requestedAt: Date.parse(approval.requestedAt),
          runId: request.data.runId,
          toolCallId: approval.toolCallId,
        })
        .run();
      this.#database
        .insert(auditEvents)
        .values({
          action: `tool.approval_${storedDecision}`,
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: approval.toolCallId,
        })
        .run();
      decisionRecorded = true;
    } else if (existing.decision === null) {
      this.#database
        .update(toolApprovals)
        .set({
          decidedAt: currentTime,
          decision: storedDecision,
        })
        .where(eq(toolApprovals.executionId, approval.executionId))
        .run();
      this.#database
        .insert(auditEvents)
        .values({
          action: `tool.approval_${storedDecision}`,
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: approval.toolCallId,
        })
        .run();
    }

    if (decisionRecorded) {
      recordExecutionEvent({
        outcome: storedDecision,
        phase: "tool.approval",
        runId: request.data.runId,
        toolCallId: approval.toolCallId,
      });
    }

    const decisionCapability = this.#capabilities.issue(
      authority,
      admission,
      request.data.decision === "approve" ? "approve_tool" : "reject_tool",
      approval.executionId,
    );

    if (decisionCapability === undefined) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    let decided: unknown;

    try {
      decided = await agent.decideAdmittedRunToolApproval({
        capability: decisionCapability,
      });
    } catch {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const result = decideRunToolApprovalResultSchema.safeParse({
      ...(typeof decided === "object" && decided !== null ? decided : {}),
      decision: request.data.decision,
    });

    if (!result.success || !result.data.ok) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    return result.data;
  }
}
