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
  listAgentRunsInputSchema,
  listAgentRunsResultSchema,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  listAdmittedRunToolApprovalsResultSchema,
  listRunToolApprovalsInputSchema,
  listRunToolApprovalsResultSchema,
  startRunInputSchema,
  startRunResultSchema,
  runTimelineEventSchema,
  type CancelRunResult,
  type AgentInboxDeferredReason,
  type AgentInboxResult,
  type DecideRunToolApprovalResult,
  type FleetConfigurationData,
  type InspectRunResult,
  type ListAgentRunsResult,
  type ListRunToolApprovalsResult,
  type OwnerAuthority,
  type PendingToolApproval,
  type RecordAgentInboxRunResult,
  type RedeemRunReceiverCapabilityResult,
  type Run,
  type RunDiagnostic,
  type RunTimelineEvent,
  type StartRunResult,
} from "@crewhelm/contracts";
import { asc, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { digestRunPrompt, type CrewAgent } from "../../agent/admitted-runs/index.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import {
  aiGatewayCalls,
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  toolApprovals,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import type { RunAdmissions, ToolExecutions } from "../runs/index.js";
import { RunReceiverCapabilities } from "./protocol.js";
import { AgentInbox } from "./inbox.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type StartRunFailure = Extract<StartRunResult, { ok: false }>;
type InspectRunFailure = Extract<InspectRunResult, { ok: false }>;
type ListAgentRunsFailure = Extract<ListAgentRunsResult, { ok: false }>;
type CancelRunFailure = Extract<CancelRunResult, { ok: false }>;
type ListApprovalsFailure = Extract<ListRunToolApprovalsResult, { ok: false }>;
type DecideApprovalFailure = Extract<DecideRunToolApprovalResult, { ok: false }>;
type StoredRunAdmission = NonNullable<ReturnType<RunAdmissions["read"]>>;
type CrewAgentStub = ReturnType<DurableObjectNamespace<CrewAgent>["getByName"]>;

const TIMELINE_EVENT_ORDER = [
  "run.admitted",
  "run.started",
  "tool.authorization_allowed",
  "tool.authorization_approval_required",
  "tool.authorization_blocked",
  "tool.approval_required",
  "tool.approval_approved",
  "tool.approval_expired",
  "tool.approval_rejected",
  "tool.execution_reserved",
  "tool.execution_dispatched",
  "tool.execution_completed",
  "tool.execution_failed",
  "tool.provider_failed",
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

export function deniedListAgentRuns(
  code: ListAgentRunsFailure["error"]["code"],
): ListAgentRunsFailure {
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
  readonly #inbox: AgentInbox;
  readonly #toolExecutions: ToolExecutions;

  constructor(
    objectName: string | undefined,
    database: Database,
    crewAgents: DurableObjectNamespace<CrewAgent>,
    admissions: RunAdmissions,
    executionStore: ToolExecutions,
    currentFleetConfiguration: () => FleetConfigurationData,
  ) {
    this.#admissions = admissions;
    this.#capabilities = new RunReceiverCapabilities(objectName, admissions);
    this.#crewAgents = crewAgents;
    this.#database = database;
    this.#inbox = new AgentInbox(objectName, database, currentFleetConfiguration);
    this.#toolExecutions = executionStore;
  }

  inbox(authority: OwnerAuthority, input: unknown): AgentInboxResult {
    return this.#inbox.handle(authority, input);
  }

  usage(): {
    inbox: ReturnType<AgentInbox["usage"]>;
    runs: { active: number };
  } {
    return {
      inbox: this.#inbox.usage(),
      runs: { active: this.#admissions.activeCount() },
    };
  }

  repairFailedRun(runId: string): boolean {
    return this.#inbox.repairFailedRun(runId);
  }

  recordInboxRun(input: unknown): Promise<RecordAgentInboxRunResult> {
    return this.#inbox.recordRun(input);
  }

  recordScheduledDeferral(input: {
    agentId: string;
    agentRevision: number;
    fleetRevision: number;
    occurredAt: number;
    prompt: string;
    reason: AgentInboxDeferredReason;
    retryAt: number | null;
    scheduleRevision: number;
    scheduledAt: number;
  }): void {
    this.#inbox.recordDeferral(input);
  }

  clearScheduledDeferral(agentId: string): void {
    this.#inbox.clearDeferral(agentId);
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
    authorizationTrace: RunTimelineEvent[] = [],
  ): RunTimelineEvent[] {
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

    for (const traceEvent of authorizationTrace) {
      const event = runTimelineEventSchema.parse(traceEvent);
      events.set(`trace:${event.event}:${event.toolCallId ?? ""}:${event.occurredAt}`, event);
    }

    for (const approval of this.#database
      .select({
        decidedAt: toolApprovals.decidedAt,
        decision: toolApprovals.decision,
        expiresAt: toolApprovals.expiresAt,
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
      } else if (approval.expiresAt <= Date.now()) {
        add("tool.approval_expired", approval.expiresAt, approval.toolCallId);
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

    return [...events.values()].toSorted(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        (TIMELINE_EVENT_PRIORITY.get(left.event) ?? Number.MAX_SAFE_INTEGER) -
          (TIMELINE_EVENT_PRIORITY.get(right.event) ?? Number.MAX_SAFE_INTEGER) ||
        (left.toolCallId ?? "").localeCompare(right.toolCallId ?? ""),
    );
  }

  #diagnosis(
    admission: StoredRunAdmission,
    run: Run,
    timeline: RunTimelineEvent[],
  ): RunDiagnostic | null {
    if (run.status !== "failed") {
      return null;
    }

    const failure = timeline.findLast((event, index) => {
      if (
        event.event !== "tool.execution_unknown" &&
        event.event !== "tool.provider_failed" &&
        event.event !== "tool.authorization_blocked" &&
        event.event !== "tool.execution_failed"
      ) {
        return false;
      }

      return !timeline
        .slice(index + 1)
        .some(
          (later) =>
            later.toolCallId === event.toolCallId &&
            (later.event === "tool.execution_reconciled_applied" ||
              later.event === "tool.execution_reconciled_not_applied"),
        );
    });

    if (failure?.event === "tool.execution_unknown") {
      return {
        certainty: "confirmed",
        disposition: "verify_effect",
        nextAction: "list_unresolved_effects",
        phase: "tool.execution",
        reason: "tool_effect_unknown",
        ...(failure.toolCallId === undefined ? {} : { toolCallId: failure.toolCallId }),
      };
    }

    if (failure?.event === "tool.provider_failed") {
      return {
        certainty: "confirmed",
        disposition: "inspect_first",
        nextAction: "inspect_run",
        phase: "tool.execution",
        reason: "tool_provider_failed",
        ...(failure.toolCallId === undefined ? {} : { toolCallId: failure.toolCallId }),
      };
    }

    if (failure?.event === "tool.authorization_blocked") {
      const unresolved = failure.reason === "unreconciled_effect";

      return {
        certainty: "confirmed",
        disposition: unresolved ? "verify_effect" : "inspect_first",
        nextAction: unresolved ? "list_unresolved_effects" : "review_configuration",
        phase: "tool.authorization",
        reason: "authorization_blocked",
        toolCallId: failure.toolCallId,
      };
    }

    if (failure?.event === "tool.execution_failed") {
      return {
        certainty: "confirmed",
        disposition: "inspect_first",
        nextAction: "inspect_run",
        phase: "tool.execution",
        reason: "tool_execution_failed",
        ...(failure.toolCallId === undefined ? {} : { toolCallId: failure.toolCallId }),
      };
    }

    const reconciliation = timeline.findLast(
      (event) =>
        event.event === "tool.execution_reconciled_applied" ||
        event.event === "tool.execution_reconciled_not_applied",
    );

    if (reconciliation !== undefined) {
      const applied = reconciliation.event === "tool.execution_reconciled_applied";

      return {
        certainty: "confirmed",
        disposition: applied ? "do_not_retry" : "start_new_run",
        nextAction: applied ? "inspect_run" : "start_new_run",
        phase: "tool.execution",
        reason: applied ? "tool_effect_applied" : "tool_effect_not_applied",
        ...(reconciliation.toolCallId === undefined
          ? {}
          : { toolCallId: reconciliation.toolCallId }),
      };
    }

    if (admission.status === "expired") {
      return {
        certainty: "confirmed",
        disposition: "start_new_run",
        nextAction: "start_new_run",
        phase: "run.admission",
        reason: "admission_expired",
      };
    }

    return {
      certainty: "unknown",
      disposition: "contact_operator",
      nextAction: "contact_operator",
      phase: "run.runtime",
      reason: "runtime_failed",
    };
  }

  #inspection(
    admission: StoredRunAdmission,
    run: Run,
    timeline: RunTimelineEvent[],
    input: { includeUsage: boolean; timelineCursor: number; timelineLimit: number },
  ): Extract<InspectRunResult, { ok: true }> {
    const start = Math.min(input.timelineCursor, timeline.length);
    const page = timeline.slice(start, start + input.timelineLimit);
    const nextCursor = start + page.length < timeline.length ? start + page.length : null;
    const gatewayCalls = input.includeUsage
      ? this.#database
          .select({
            costMicrousd: aiGatewayCalls.costMicrousd,
            inputTokens: aiGatewayCalls.inputTokens,
            outputTokens: aiGatewayCalls.outputTokens,
            reservationMicrousd: aiGatewayCalls.reservationMicrousd,
            status: aiGatewayCalls.status,
          })
          .from(aiGatewayCalls)
          .where(eq(aiGatewayCalls.runId, admission.runId))
          .all()
      : [];
    const pendingUsage = gatewayCalls.some((call) => call.status === "pending");
    const output = run.output ?? "";

    return inspectRunResultSchema.options[0].parse({
      diagnosis: this.#diagnosis(admission, run, timeline),
      ok: true,
      request: { prompt: admission.prompt },
      retention: {
        availableUntil: new Date(admission.cleanupAt).toISOString(),
        output: {
          limitCharacters: MAXIMUM_RUN_OUTPUT_CHARACTERS,
          retainedCharacters: output.length,
          truncated: run.outputTruncated ?? false,
        },
      },
      run,
      timeline: page,
      timelinePage: {
        nextCursor,
        omittedEvents: Math.max(0, timeline.length - page.length),
        startSequence: start,
        totalEvents: timeline.length,
        truncated: nextCursor !== null || start > 0,
      },
      usage: input.includeUsage
        ? {
            ai: {
              calls: gatewayCalls.length,
              costMicrousd: gatewayCalls.reduce(
                (total, call) => total + (call.costMicrousd ?? call.reservationMicrousd),
                0,
              ),
              inputTokens: gatewayCalls.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
              outputTokens: gatewayCalls.reduce(
                (total, call) => total + (call.outputTokens ?? 0),
                0,
              ),
              settlement:
                gatewayCalls.length === 0 ? "not_configured" : pendingUsage ? "pending" : "settled",
            },
            modelCalls: {
              limit: admission.budgetReservation.maxModelCalls,
              used: admission.modelCallsConsumed,
            },
            toolCalls: {
              limit: admission.budgetReservation.maxToolCalls,
              used: admission.toolCallsConsumed,
            },
          }
        : null,
    });
  }

  #authoritativeRun(run: Run, authorizationTrace: RunTimelineEvent[]): Run {
    if (run.status !== "completed") {
      return run;
    }

    const executionStates = this.#database
      .select({
        reconciliation: toolExecutions.reconciliation,
        status: toolExecutions.status,
      })
      .from(toolExecutions)
      .where(eq(toolExecutions.runId, run.runId))
      .all();
    const hasCompletedExecution = executionStates.some(
      (execution) => execution.status === "completed",
    );
    const hasUnresolvedExecution = executionStates.some(
      (execution) => execution.status === "unknown" && execution.reconciliation === null,
    );
    const hasOnlyFailedExecutions =
      !hasCompletedExecution && executionStates.some((execution) => execution.status === "failed");
    const hasAuthorizationBlock = authorizationTrace.some(
      (event) => event.event === "tool.authorization_blocked",
    );

    return hasAuthorizationBlock || hasUnresolvedExecution || hasOnlyFailedExecutions
      ? { ...run, status: "failed" }
      : run;
  }

  async start(
    authority: OwnerAuthority,
    input: unknown,
    trigger: "manual" | "schedule" = "manual",
  ): Promise<StartRunResult> {
    const request = startRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedStartRun("invalid_request");
    }

    const admission = await this.#admissions.create(authority, {
      agentId: request.data.agentId,
      expectedRevision: request.data.expectedRevision,
      idempotencyKey: request.data.idempotencyKey,
      prompt: request.data.prompt,
      promptCharacters: request.data.prompt.length,
      promptDigest: await digestRunPrompt(request.data.prompt),
      trigger,
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
          trigger: storedAdmission.trigger,
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
          trigger: storedAdmission.trigger,
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
      trigger: storedAdmission.trigger,
    };

    this.#toolExecutions.reconcileExpired(Date.now());
    const authoritativeRun = this.#authoritativeRun(run, inspected.trace);
    const timeline = this.#timeline(storedAdmission, authoritativeRun, [], inspected.trace);
    const alignedRun = alignRunCompletion(authoritativeRun, timeline);

    if (alignedRun.status === "failed") {
      this.#inbox.repairFailedRun(alignedRun.runId);
    }

    return startRunResultSchema.parse({
      created: admission.state === "issued" && admission.created,
      ok: true,
      run: alignedRun,
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
        trigger: admission.trigger,
      };

      return this.#inspection(
        admission,
        run,
        this.#timeline(admission, run, [], inspected?.trace ?? []),
        request.data,
      );
    }

    if (admission.status !== "redeemed") {
      const run = {
        agentId: admission.agentId,
        agentRevision: admission.agentRevision,
        createdAt: new Date(admission.createdAt).toISOString(),
        runId: admission.runId,
        status: admission.status === "expired" ? ("failed" as const) : ("queued" as const),
        trigger: admission.trigger,
      };

      return this.#inspection(admission, run, this.#timeline(admission, run), request.data);
    }

    const agent = this.#agent(authority, admission);
    const inspected = await this.#inspectAdmittedRun(authority, admission, agent);

    if (inspected === undefined) {
      return deniedInspectRun("run_unavailable");
    }

    const inspectedRun: Run = {
      ...inspected.run,
      createdAt: new Date(admission.createdAt).toISOString(),
      trigger: admission.trigger,
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
          trigger: admission.trigger,
        }
      : inspectedRun;

    this.#toolExecutions.reconcileExpired(Date.now());
    const authoritativeRun = this.#authoritativeRun(run, inspected.trace);
    const timeline = this.#timeline(
      admission,
      authoritativeRun,
      pending.state === "available" ? pending.approvals : [],
      inspected.trace,
    );
    const alignedRun = alignRunCompletion(authoritativeRun, timeline);

    if (alignedRun.status === "failed") {
      this.#inbox.repairFailedRun(alignedRun.runId);
    }

    return this.#inspection(admission, alignedRun, timeline, request.data);
  }

  async listRuns(_authority: OwnerAuthority, input: unknown): Promise<ListAgentRunsResult> {
    const request = listAgentRunsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedListAgentRuns("invalid_request");
    }

    if (
      request.data.agentId !== undefined &&
      this.#database
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.agentId, request.data.agentId))
        .get() === undefined
    ) {
      return deniedListAgentRuns("run_not_found");
    }

    const page = this.#admissions.list(request.data);

    if (page === undefined) {
      return deniedListAgentRuns("invalid_request");
    }

    return listAgentRunsResultSchema.parse({
      nextCursor: page.nextCursor,
      ok: true,
      runs: page.runs,
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
      await this.#recordCancellationOutcome(
        authority,
        admission,
        new Date(admission.cancelledAt).toISOString(),
      );

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

          await this.#recordCancellationOutcome(authority, admission, new Date().toISOString());

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

    await this.#recordCancellationOutcome(authority, admission, new Date().toISOString());

    return cancelRunResultSchema.parse({
      cancelled: true,
      ok: true,
      runId: admission.runId,
    });
  }

  async #recordCancellationOutcome(
    authority: OwnerAuthority,
    admission: StoredRunAdmission,
    occurredAt: string,
  ): Promise<void> {
    await this.#inbox.recordRun({
      event: {
        approvalCount: 0,
        kind: "outcome",
        occurredAt,
        resultPreview: null,
        runStatus: "cancelled",
      },
      reference: {
        agentId: admission.agentId,
        agentRevision: admission.agentRevision,
        idempotencyKey: admission.idempotencyKey,
        ownerKey: authority.ownerKey,
        promptDigest: admission.promptDigest,
        runId: admission.runId,
      },
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
    const storedApproval = this.#database
      .select({
        expiresAt: toolApprovals.expiresAt,
        runId: toolApprovals.runId,
      })
      .from(toolApprovals)
      .where(eq(toolApprovals.executionId, request.data.executionId))
      .get();

    if (
      storedApproval !== undefined &&
      storedApproval.runId === request.data.runId &&
      storedApproval.expiresAt <= Date.now()
    ) {
      return deniedDecideRunToolApproval("approval_expired");
    }

    const pending = await this.#pendingApprovals(authority, admission, agent);

    if (pending.state === "unavailable") {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const approval =
      pending.state === "available"
        ? pending.approvals.find((candidate) => candidate.executionId === request.data.executionId)
        : undefined;

    if (approval === undefined) {
      return deniedDecideRunToolApproval("approval_not_found");
    }

    if (Date.parse(approval.expiresAt) <= Date.now()) {
      return deniedDecideRunToolApproval("approval_expired");
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
