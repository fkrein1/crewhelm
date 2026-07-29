import {
  TOOL_EXECUTION_PERMIT_LIFETIME_MS,
  completeToolExecutionInputSchema,
  completeToolExecutionResultSchema,
  composioToolCapabilityGrantSchema,
  evaluateToolExecutionInputSchema,
  evaluateToolExecutionResultSchema,
  reserveToolExecutionInputSchema,
  reserveToolExecutionResultSchema,
  reconcileToolExecutionInputSchema,
  reconcileToolExecutionResultSchema,
  resolveToolExecutionConnectionResultSchema,
  runAdmissionNonceSchema,
  toolExecutionPermitSchema,
  type CompleteToolExecutionResult,
  type ComposioToolGateInput,
  type EvaluateToolExecutionResult,
  type ReserveToolExecutionResult,
  type ReconcileToolExecutionResult,
  type ResolveToolExecutionConnectionResult,
  type ToolExecutionPermit,
  type FleetConfiguration,
  type OwnerAuthority,
  type ToolExecutionEvaluationFailureReason,
} from "@crewhelm/contracts";
import { and, count, eq, gt, isNotNull, isNull, lte, min, or } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { recordExecutionEvent } from "../../observability/execution.js";
import { recordRecoveryEvent } from "../../observability/recovery.js";
import {
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  integrationUsageEvents,
  runAdmissions,
  toolApprovals,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import { evaluateApprovedComposioToolAction, evaluateComposioToolAction } from "./policy.js";

const INTEGRATION_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const INVALID_TOOL_EXECUTION = {
  error: {
    code: "invalid_execution",
    message: "Tool execution denied.",
  },
  ok: false,
} as const;

export function deniedToolExecutionEvaluation(
  reason: ToolExecutionEvaluationFailureReason,
): EvaluateToolExecutionResult {
  return evaluateToolExecutionResultSchema.parse({
    error: {
      ...INVALID_TOOL_EXECUTION.error,
      reason,
    },
    ok: false,
  });
}

type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ControlPlaneTransaction = Parameters<Parameters<ControlPlaneDatabase["transaction"]>[0]>[0];
type ToolExecutionDatabase = ControlPlaneDatabase | ControlPlaneTransaction;
type ToolExecutionRequest = ReturnType<typeof evaluateToolExecutionInputSchema.parse>;
type GateInputResult =
  | { input: ComposioToolGateInput; ok: true }
  | { ok: false; reason: ToolExecutionEvaluationFailureReason };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestBase64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

async function digestToolExecutionPermit(
  permit: ToolExecutionPermit,
  state: "reserved" | "dispatched",
): Promise<string> {
  return digestBase64Url(JSON.stringify({ permit, state }));
}

export async function digestExternalEffect(
  action: ToolExecutionRequest["action"],
): Promise<string> {
  const canonicalEffect = JSON.stringify({
    schemaVersion: 1,
    connectionId: action.connectionId,
    inputDigest: action.inputDigest,
    integrationSlug: action.integrationSlug,
    toolkitVersion: action.toolkitVersion,
    toolSlug: action.toolSlug,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalEffect));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ReconciliationFailure = Extract<ReconcileToolExecutionResult, { ok: false }>;

export function deniedToolExecutionReconciliation(
  code: ReconciliationFailure["error"]["code"],
): ReconciliationFailure {
  return {
    error: {
      code,
      message: "Tool execution reconciliation denied.",
    },
    ok: false,
  };
}

function createNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
}

export class ToolExecutions {
  readonly #currentFleetConfiguration: () => FleetConfiguration;
  readonly #database: ControlPlaneDatabase;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;

  constructor(
    objectName: string | undefined,
    database: ControlPlaneDatabase,
    storage: DurableObjectStorage,
    currentFleetConfiguration: () => FleetConfiguration,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#objectName = objectName;
    this.#storage = storage;
  }

  async evaluate(input: unknown): Promise<EvaluateToolExecutionResult> {
    const request = evaluateToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedToolExecutionEvaluation("invalid_request");
    }

    const effectDigest = await digestExternalEffect(request.data.action);

    if (
      request.data.action.effect !== "read" &&
      this.#hasUnreconciledEffect(this.#database, effectDigest)
    ) {
      return deniedToolExecutionEvaluation("unreconciled_effect");
    }

    const gate = this.#gateInput(this.#database, request.data, Date.now());

    if (!gate.ok) {
      return deniedToolExecutionEvaluation(gate.reason);
    }

    return evaluateToolExecutionResultSchema.parse({
      decision: await evaluateComposioToolAction(gate.input),
      ok: true,
    });
  }

  async reserve(input: unknown): Promise<ReserveToolExecutionResult> {
    const request = reserveToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_TOOL_EXECUTION;
    }

    const evaluatedAt = Date.now();
    const effectDigest = await digestExternalEffect(request.data.action);
    const existingExecution = this.#database
      .select()
      .from(toolExecutions)
      .where(eq(toolExecutions.toolCallId, request.data.action.toolCallId))
      .get();

    if (existingExecution !== undefined) {
      return INVALID_TOOL_EXECUTION;
    }

    if (
      request.data.action.effect !== "read" &&
      this.#hasUnreconciledEffect(this.#database, effectDigest)
    ) {
      return INVALID_TOOL_EXECUTION;
    }

    const gate = this.#gateInput(this.#database, request.data, evaluatedAt);

    if (!gate.ok) {
      return INVALID_TOOL_EXECUTION;
    }
    const gateInput = gate.input;

    const approval = this.#database
      .select({
        actionDigest: toolApprovals.actionDigest,
        decision: toolApprovals.decision,
        expiresAt: toolApprovals.expiresAt,
      })
      .from(toolApprovals)
      .where(eq(toolApprovals.toolCallId, request.data.action.toolCallId))
      .get();
    const approvedDigest =
      approval?.decision === "approved" && approval.expiresAt > evaluatedAt
        ? approval.actionDigest
        : undefined;
    const decision =
      approvedDigest === undefined
        ? await evaluateComposioToolAction(gateInput)
        : await evaluateApprovedComposioToolAction(gateInput, approvedDigest);

    if (decision.decision === "deny") {
      return INVALID_TOOL_EXECUTION;
    }

    if (decision.decision === "requires_approval") {
      recordExecutionEvent({
        outcome: "approval_required",
        phase: "tool.reservation",
        runId: request.data.runId,
        toolCallId: request.data.action.toolCallId,
      });
      return reserveToolExecutionResultSchema.parse({
        actionDigest: decision.actionDigest,
        effect: decision.effect,
        ok: true,
        state: "requires_approval",
      });
    }

    const nonce = createNonce();
    const permit = toolExecutionPermitSchema.parse({
      action: request.data.action,
      actionDigest: decision.actionDigest,
      audience: "composio_adapter",
      constraints: {
        ...decision.constraints,
        decisionExpiresAt: new Date(
          Math.min(
            Date.parse(decision.constraints.decisionExpiresAt),
            evaluatedAt + TOOL_EXECUTION_PERMIT_LIFETIME_MS,
          ),
        ).toISOString(),
      },
      nonce,
    });
    const permitDigest = await digestToolExecutionPermit(permit, "reserved");
    const executionDeadline =
      evaluatedAt + Math.min(decision.constraints.maxDurationMs, 5 * 60 * 1_000);
    const result = this.#database.transaction((transaction) => {
      const currentGate = this.#gateInput(transaction, request.data, evaluatedAt);

      if (
        !currentGate.ok ||
        JSON.stringify(currentGate.input) !== JSON.stringify(gateInput) ||
        (request.data.action.effect !== "read" &&
          this.#hasUnreconciledEffect(transaction, effectDigest))
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      if (
        transaction
          .select({ toolCallId: toolExecutions.toolCallId })
          .from(toolExecutions)
          .where(eq(toolExecutions.toolCallId, request.data.action.toolCallId))
          .get() !== undefined
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      const expectedConsumed =
        request.data.budgetReservation.maxToolCalls - gateInput.policy.remainingToolCalls;
      const claimed = transaction
        .update(runAdmissions)
        .set({
          toolCallsConsumed: expectedConsumed + 1,
        })
        .where(
          and(
            eq(runAdmissions.runId, request.data.runId),
            eq(runAdmissions.toolCallsConsumed, expectedConsumed),
          ),
        )
        .returning({ runId: runAdmissions.runId })
        .all();

      if (claimed.length !== 1) {
        return INVALID_TOOL_EXECUTION;
      }

      transaction
        .insert(toolExecutions)
        .values({
          actionDigest: decision.actionDigest,
          costMicrousd: request.data.action.estimatedCostMicrousd ?? 0,
          effectDigest,
          expiresAt: executionDeadline,
          grantId: request.data.action.grantId,
          inputDigest: request.data.action.inputDigest,
          nonceDigest: permitDigest,
          runId: request.data.runId,
          startedAt: evaluatedAt,
          status: "reserved",
          toolCallId: request.data.action.toolCallId,
        })
        .run();
      transaction
        .insert(integrationUsageEvents)
        .values({
          agentId: request.data.agentId,
          grantId: request.data.action.grantId,
          recordedAt: evaluatedAt,
          runId: request.data.runId,
          toolCallId: request.data.action.toolCallId,
        })
        .run();
      transaction
        .delete(integrationUsageEvents)
        .where(lte(integrationUsageEvents.recordedAt, evaluatedAt - INTEGRATION_USAGE_WINDOW_MS))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "tool.execution_reserved",
          clientId: request.data.clientId,
          occurredAt: evaluatedAt,
          subjectId: request.data.action.toolCallId,
        })
        .run();

      return reserveToolExecutionResultSchema.parse({
        ok: true,
        permit,
        state: "allowed",
      });
    });

    if (result.ok && result.state === "allowed") {
      recordExecutionEvent({
        outcome: "allowed",
        phase: "tool.reservation",
        runId: request.data.runId,
        toolCallId: request.data.action.toolCallId,
      });
      await this.#scheduleReconciliation(executionDeadline);
    }

    return result;
  }

  reconcileExpired(currentTime: number): void {
    const reconciled = this.#database.transaction((transaction) => {
      const expired = transaction
        .select({
          clientId: runAdmissions.clientId,
          runId: toolExecutions.runId,
          toolCallId: toolExecutions.toolCallId,
        })
        .from(toolExecutions)
        .innerJoin(runAdmissions, eq(runAdmissions.runId, toolExecutions.runId))
        .where(
          and(
            eq(toolExecutions.status, "reserved"),
            isNotNull(toolExecutions.dispatchedAt),
            lte(toolExecutions.expiresAt, currentTime),
          ),
        )
        .all();
      const completed: typeof expired = [];

      for (const execution of expired) {
        const updated = transaction
          .update(toolExecutions)
          .set({
            completedAt: currentTime,
            outputBytes: 0,
            status: "unknown",
          })
          .where(
            and(
              eq(toolExecutions.toolCallId, execution.toolCallId),
              eq(toolExecutions.status, "reserved"),
              isNotNull(toolExecutions.dispatchedAt),
              lte(toolExecutions.expiresAt, currentTime),
            ),
          )
          .returning({ toolCallId: toolExecutions.toolCallId })
          .all();

        if (updated.length !== 1) {
          continue;
        }

        transaction
          .insert(auditEvents)
          .values({
            action: "tool.execution_unknown",
            clientId: execution.clientId,
            occurredAt: currentTime,
            subjectId: execution.toolCallId,
          })
          .run();
        completed.push(execution);
      }

      return completed;
    });

    for (const execution of reconciled) {
      recordExecutionEvent({
        outcome: "unknown",
        outputBytes: 0,
        phase: "tool.completion",
        runId: execution.runId,
        toolCallId: execution.toolCallId,
      });
    }
  }

  nextReconciliationAt(): number | null {
    return (
      this.#database
        .select({ value: min(toolExecutions.expiresAt) })
        .from(toolExecutions)
        .where(and(eq(toolExecutions.status, "reserved"), isNotNull(toolExecutions.dispatchedAt)))
        .get()?.value ?? null
    );
  }

  async complete(input: unknown): Promise<CompleteToolExecutionResult> {
    const request = completeToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_TOOL_EXECUTION;
    }

    const reservedPermitDigest = await digestToolExecutionPermit(request.data.permit, "reserved");
    const dispatchedPermitDigest = await digestToolExecutionPermit(
      request.data.permit,
      "dispatched",
    );
    const currentTime = Date.now();

    let completedStatus: "completed" | "failed" | "unknown" | undefined;
    const result = this.#database.transaction((transaction) => {
      const row = transaction
        .select()
        .from(toolExecutions)
        .where(eq(toolExecutions.toolCallId, request.data.permit.action.toolCallId))
        .get();

      if (
        row === undefined ||
        !(
          row.nonceDigest === dispatchedPermitDigest ||
          (row.nonceDigest === reservedPermitDigest && request.data.outcome.status !== "completed")
        ) ||
        row.runId !== request.data.permit.action.runId ||
        row.grantId !== request.data.permit.action.grantId ||
        row.actionDigest !== request.data.permit.actionDigest
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      if (row.status !== "reserved") {
        return completeToolExecutionResultSchema.parse({
          completed: false,
          ok: true,
        });
      }

      const status =
        currentTime > row.expiresAt ||
        request.data.outcome.outputBytes > request.data.permit.constraints.maxOutputBytes
          ? "unknown"
          : request.data.outcome.status;
      completedStatus = status;

      transaction
        .update(toolExecutions)
        .set({
          completedAt: currentTime,
          outputBytes: Math.min(
            request.data.outcome.outputBytes,
            request.data.permit.constraints.maxOutputBytes,
          ),
          status,
        })
        .where(
          and(eq(toolExecutions.toolCallId, row.toolCallId), eq(toolExecutions.status, "reserved")),
        )
        .run();
      const admission = transaction
        .select({ clientId: runAdmissions.clientId })
        .from(runAdmissions)
        .where(eq(runAdmissions.runId, row.runId))
        .get();

      if (admission === undefined) {
        return INVALID_TOOL_EXECUTION;
      }

      transaction
        .insert(auditEvents)
        .values({
          action: `tool.execution_${status}`,
          clientId: admission.clientId,
          occurredAt: currentTime,
          subjectId: row.toolCallId,
        })
        .run();

      return completeToolExecutionResultSchema.parse({
        completed: true,
        ok: true,
      });
    });

    if (result.ok && result.completed && completedStatus !== undefined) {
      recordExecutionEvent({
        outcome: completedStatus,
        outputBytes: Math.min(
          request.data.outcome.outputBytes,
          request.data.permit.constraints.maxOutputBytes,
        ),
        phase: "tool.completion",
        runId: request.data.permit.action.runId,
        toolCallId: request.data.permit.action.toolCallId,
      });
    }

    return result;
  }

  reconcile(authority: OwnerAuthority, input: unknown): ReconcileToolExecutionResult {
    const request = reconcileToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedToolExecutionReconciliation("invalid_request");
    }

    const reconciledAt = Date.now();
    const result = this.#database.transaction((transaction) => {
      const row = transaction
        .select({
          reconciliation: toolExecutions.reconciliation,
          runId: toolExecutions.runId,
          status: toolExecutions.status,
        })
        .from(toolExecutions)
        .where(eq(toolExecutions.toolCallId, request.data.toolCallId))
        .get();

      if (row === undefined) {
        return deniedToolExecutionReconciliation("execution_not_found");
      }

      if (
        row.reconciliation === request.data.resolution &&
        ((row.status === "completed" && request.data.resolution === "applied") ||
          (row.status === "failed" && request.data.resolution === "not_applied"))
      ) {
        return reconcileToolExecutionResultSchema.parse({
          ok: true,
          reconciled: false,
          resolution: request.data.resolution,
          runId: row.runId,
          toolCallId: request.data.toolCallId,
        });
      }

      if (row.status !== "unknown" || row.reconciliation !== null) {
        return deniedToolExecutionReconciliation("execution_not_reconcilable");
      }

      const status = request.data.resolution === "applied" ? "completed" : "failed";
      const updated = transaction
        .update(toolExecutions)
        .set({
          reconciliation: request.data.resolution,
          reconciledAt,
          status,
        })
        .where(
          and(
            eq(toolExecutions.toolCallId, request.data.toolCallId),
            eq(toolExecutions.status, "unknown"),
            isNull(toolExecutions.reconciliation),
          ),
        )
        .returning({ toolCallId: toolExecutions.toolCallId })
        .all();

      if (updated.length !== 1) {
        return deniedToolExecutionReconciliation("execution_not_reconcilable");
      }

      transaction
        .insert(auditEvents)
        .values({
          action: `tool.execution_reconciled_${request.data.resolution}`,
          clientId: authority.clientId,
          occurredAt: reconciledAt,
          subjectId: request.data.toolCallId,
        })
        .run();

      return reconcileToolExecutionResultSchema.parse({
        ok: true,
        reconciled: true,
        resolution: request.data.resolution,
        runId: row.runId,
        toolCallId: request.data.toolCallId,
      });
    });

    if (result.ok) {
      recordRecoveryEvent({
        operation: "tool.reconcile",
        outcome: result.reconciled ? "changed" : "replayed",
        resolution: result.resolution,
        runId: result.runId,
        toolCallId: result.toolCallId,
      });
    }

    return result;
  }

  async resolveConnection(input: unknown): Promise<ResolveToolExecutionConnectionResult> {
    const permit = toolExecutionPermitSchema.safeParse(input);

    if (
      !permit.success ||
      permit.data.action.ownerKey !== this.#objectName ||
      Date.parse(permit.data.constraints.decisionExpiresAt) <= Date.now()
    ) {
      return INVALID_TOOL_EXECUTION;
    }

    const reservedPermitDigest = await digestToolExecutionPermit(permit.data, "reserved");
    const dispatchedPermitDigest = await digestToolExecutionPermit(permit.data, "dispatched");
    const dispatchedAt = Date.now();

    const result = this.#database.transaction((transaction) => {
      const row = transaction
        .select({
          actionDigest: toolExecutions.actionDigest,
          agentStatus: agents.status,
          cancellationRequestedAt: runAdmissions.cancellationRequestedAt,
          budgetReservation: runAdmissions.budgetReservation,
          clientId: runAdmissions.clientId,
          connectionId: capabilityGrants.connectionId,
          connectionStatus: connections.status,
          expiresAt: toolExecutions.expiresAt,
          grant: capabilityGrants.grant,
          grantId: toolExecutions.grantId,
          grantStatus: capabilityGrants.status,
          nonceDigest: toolExecutions.nonceDigest,
          providerConnectionId: connections.providerConnectionId,
          currentAgentRevision: agents.currentRevision,
          runId: toolExecutions.runId,
          status: toolExecutions.status,
        })
        .from(toolExecutions)
        .innerJoin(capabilityGrants, eq(capabilityGrants.grantId, toolExecutions.grantId))
        .innerJoin(connections, eq(connections.connectionId, capabilityGrants.connectionId))
        .innerJoin(runAdmissions, eq(runAdmissions.runId, toolExecutions.runId))
        .innerJoin(agents, eq(agents.agentId, runAdmissions.agentId))
        .where(eq(toolExecutions.toolCallId, permit.data.action.toolCallId))
        .get();
      const grant = composioToolCapabilityGrantSchema.safeParse(row?.grant);

      if (
        row === undefined ||
        !grant.success ||
        row.status !== "reserved" ||
        row.expiresAt <= dispatchedAt ||
        row.cancellationRequestedAt !== null ||
        row.budgetReservation.fleetConfigurationRevision !==
          this.#currentFleetConfiguration().revision ||
        row.agentStatus !== "active" ||
        row.currentAgentRevision !== permit.data.action.agentRevision ||
        row.connectionStatus !== "active" ||
        row.grantStatus !== "active" ||
        row.nonceDigest !== reservedPermitDigest ||
        row.actionDigest !== permit.data.actionDigest ||
        row.runId !== permit.data.action.runId ||
        row.grantId !== permit.data.action.grantId ||
        row.connectionId !== permit.data.action.connectionId ||
        grant.data.toolSlug !== permit.data.action.toolSlug ||
        grant.data.toolkitVersion !== permit.data.action.toolkitVersion
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      const claimed = transaction
        .update(toolExecutions)
        .set({ dispatchedAt, nonceDigest: dispatchedPermitDigest })
        .where(
          and(
            eq(toolExecutions.toolCallId, permit.data.action.toolCallId),
            eq(toolExecutions.status, "reserved"),
            eq(toolExecutions.nonceDigest, reservedPermitDigest),
          ),
        )
        .returning({ toolCallId: toolExecutions.toolCallId })
        .all();

      if (claimed.length !== 1) {
        return INVALID_TOOL_EXECUTION;
      }

      transaction
        .insert(auditEvents)
        .values({
          action: "tool.execution_dispatched",
          clientId: row.clientId,
          occurredAt: dispatchedAt,
          subjectId: permit.data.action.toolCallId,
        })
        .run();

      return resolveToolExecutionConnectionResultSchema.parse({
        ok: true,
        providerConnectionId: row.providerConnectionId,
      });
    });

    if (result.ok) {
      recordExecutionEvent({
        outcome: "claimed",
        phase: "tool.dispatch",
        runId: permit.data.action.runId,
        toolCallId: permit.data.action.toolCallId,
      });
    }

    return result;
  }

  async #scheduleReconciliation(reconcileAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || reconcileAt < scheduledAlarm) {
      await this.#storage.setAlarm(reconcileAt);
    }
  }

  #gateInput(
    database: ToolExecutionDatabase,
    request: ToolExecutionRequest,
    evaluatedAt: number,
  ): GateInputResult {
    if (request.ownerKey !== this.#objectName) {
      return { ok: false, reason: "admission_mismatch" };
    }

    const admission = database
      .select()
      .from(runAdmissions)
      .where(eq(runAdmissions.runId, request.runId))
      .get();

    if (
      admission === undefined ||
      admission.status !== "redeemed" ||
      admission.cancellationRequestedAt !== null ||
      admission.cleanupAt <= evaluatedAt ||
      admission.budgetReservation.fleetConfigurationRevision !==
        this.#currentFleetConfiguration().revision
    ) {
      return { ok: false, reason: "admission_unavailable" };
    }

    if (
      admission.agentId !== request.agentId ||
      admission.agentRevision !== request.agentRevision ||
      admission.clientId !== request.clientId ||
      admission.idempotencyKey !== request.idempotencyKey ||
      admission.promptDigest !== request.promptDigest ||
      JSON.stringify(admission.budgetReservation) !== JSON.stringify(request.budgetReservation)
    ) {
      return { ok: false, reason: "admission_mismatch" };
    }

    if (
      request.action.ownerKey !== request.ownerKey ||
      request.action.agentId !== request.agentId ||
      request.action.agentRevision !== request.agentRevision ||
      request.action.runId !== request.runId
    ) {
      return { ok: false, reason: "action_mismatch" };
    }

    const grantRow = database
      .select({
        agentId: capabilityGrants.agentId,
        agentRevision: capabilityGrants.agentRevision,
        connectionId: capabilityGrants.connectionId,
        connectionStatus: connections.status,
        grant: capabilityGrants.grant,
        grantStatus: capabilityGrants.status,
      })
      .from(capabilityGrants)
      .innerJoin(connections, eq(connections.connectionId, capabilityGrants.connectionId))
      .where(eq(capabilityGrants.grantId, request.action.grantId))
      .get();
    const grant = composioToolCapabilityGrantSchema.safeParse(grantRow?.grant);
    const reservedGrant = request.budgetReservation.toolGrants.find(
      (candidate) => candidate.grantId === request.action.grantId,
    );

    if (grantRow === undefined || !grant.success) {
      return { ok: false, reason: "grant_unavailable" };
    }

    if (reservedGrant === undefined) {
      return { ok: false, reason: "grant_snapshot_mismatch" };
    }

    if (
      grantRow.agentId !== request.agentId ||
      grantRow.agentRevision !== request.agentRevision ||
      grantRow.connectionId !== grant.data.connectionId
    ) {
      return { ok: false, reason: "grant_mismatch" };
    }

    if (JSON.stringify(grant.data) !== JSON.stringify(reservedGrant)) {
      return { ok: false, reason: "grant_snapshot_mismatch" };
    }

    const currentAgent = database
      .select({ currentRevision: agents.currentRevision, status: agents.status })
      .from(agents)
      .where(eq(agents.agentId, request.agentId))
      .get();

    if (currentAgent === undefined) {
      return { ok: false, reason: "admission_unavailable" };
    }
    const grantCallsUsed =
      database
        .select({ value: count() })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.runId, request.runId),
            eq(toolExecutions.grantId, request.action.grantId),
          ),
        )
        .get()?.value ?? 0;
    const activeGrantCalls =
      database
        .select({ value: count() })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.grantId, request.action.grantId),
            eq(toolExecutions.status, "reserved"),
            gt(toolExecutions.expiresAt, evaluatedAt),
          ),
        )
        .get()?.value ?? 0;
    const sameToolInputCallsUsed =
      database
        .select({ value: count() })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.runId, request.runId),
            eq(toolExecutions.grantId, request.action.grantId),
            eq(toolExecutions.inputDigest, request.action.inputDigest),
          ),
        )
        .get()?.value ?? 0;
    const fleetCallsPerDayUsed =
      database
        .select({ value: count() })
        .from(integrationUsageEvents)
        .where(gt(integrationUsageEvents.recordedAt, evaluatedAt - 24 * 60 * 60 * 1_000))
        .get()?.value ?? 0;
    const fleetCallsPerThirtyDaysUsed =
      database
        .select({ value: count() })
        .from(integrationUsageEvents)
        .where(gt(integrationUsageEvents.recordedAt, evaluatedAt - INTEGRATION_USAGE_WINDOW_MS))
        .get()?.value ?? 0;
    const deadlineAt = admission.createdAt + request.budgetReservation.maxDurationSeconds * 1_000;

    return {
      input: {
        action: request.action,
        grant: grant.data,
        policy: {
          activeGrantCalls,
          agentId: request.agentId,
          agentStatus:
            currentAgent.currentRevision !== request.agentRevision
              ? ("revoked" as const)
              : currentAgent.status,
          capabilityId: request.action.capabilityId,
          connectionId: request.action.connectionId,
          connectionStatus:
            grantRow?.connectionStatus === "active"
              ? ("active" as const)
              : grantRow?.connectionStatus === "revoked"
                ? ("revoked" as const)
                : ("unavailable" as const),
          currentAgentRevision: currentAgent.currentRevision,
          evaluatedAt: new Date(evaluatedAt).toISOString(),
          fleetCallsPerDayUsed,
          fleetCallsPerThirtyDaysUsed,
          grantCallsUsed,
          grantId: request.action.grantId,
          grantStatus: grantRow?.grantStatus ?? "revoked",
          killSwitchActive: false,
          limits: {
            callsPerDay: request.budgetReservation.integrationLimits.callsPerDay,
            callsPerThirtyDays: request.budgetReservation.integrationLimits.callsPerThirtyDays,
            duplicateToolCallLimit:
              request.budgetReservation.integrationLimits.duplicateToolCallLimit,
            maxCallsPerToolPerRun:
              request.budgetReservation.integrationLimits.maxCallsPerToolPerRun,
            maxConcurrencyPerGrant:
              request.budgetReservation.integrationLimits.maxConcurrencyPerGrant,
          },
          ownerKey: request.ownerKey,
          remainingCostMicrousd: grant.data.limits.maxCostMicrousdPerCall,
          remainingDurationMs: Math.max(0, deadlineAt - evaluatedAt),
          remainingOutputBytes: grant.data.limits.maxOutputBytes,
          remainingToolCalls: Math.max(
            0,
            request.budgetReservation.maxToolCalls - admission.toolCallsConsumed,
          ),
          runId: request.runId,
          sameToolInputCallsUsed,
        },
      },
      ok: true,
    };
  }

  #hasUnreconciledEffect(database: ToolExecutionDatabase, effectDigest: string): boolean {
    return (
      database
        .select({ toolCallId: toolExecutions.toolCallId })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.status, "unknown"),
            or(
              eq(toolExecutions.effectDigest, effectDigest),
              eq(toolExecutions.effectDigest, "0".repeat(64)),
            ),
          ),
        )
        .get() !== undefined
    );
  }
}
