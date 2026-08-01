import {
  RUNTIME_TOOL_EXECUTION_PERMIT_LIFETIME_MS,
  RUNTIME_TOOL_LATE_OPEN_CLEANUP_HORIZON_MS,
  completeRuntimeToolExecutionInputSchema,
  completeRuntimeToolExecutionResultSchema,
  dispatchRuntimeToolExecutionInputSchema,
  dispatchRuntimeToolExecutionResultSchema,
  reserveRuntimeToolExecutionInputSchema,
  reserveRuntimeToolExecutionResultSchema,
  runAdmissionNonceSchema,
  runtimeToolExecutionPermitSchema,
  type CompleteRuntimeToolExecutionResult,
  type DispatchRuntimeToolExecutionResult,
  type FleetConfiguration,
  type ReserveRuntimeToolExecutionResult,
  type RuntimeToolExecutionPermit,
} from "@crewhelm/contracts";
import { and, count, eq, gt, isNull, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { recordExecutionEvent } from "../../observability/execution.js";
import type { CrewhelmSandbox } from "../../sandbox.js";
import {
  agents,
  auditEvents,
  runAdmissions,
  runtimeToolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

const INVALID_RUNTIME_TOOL_EXECUTION = {
  error: {
    code: "invalid_execution",
    message: "Runtime tool execution denied.",
  },
  ok: false,
} as const;
const MAXIMUM_RUNTIME_TOOL_EXECUTION_MS = 30_000;
const RUNTIME_TOOL_COMPLETION_GRACE_MS = 5_000;
const RUNTIME_TOOL_CLEANUP_GRACE_MS = 30_000;
const RUNTIME_TOOL_CLEANUP_RETRY_MS = 30_000;
const RUNTIME_TOOL_CLEANUP_TIMEOUT_MS = 5_000;

type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ControlPlaneTransaction = Parameters<Parameters<ControlPlaneDatabase["transaction"]>[0]>[0];
type RuntimeToolExecutionDatabase = ControlPlaneDatabase | ControlPlaneTransaction;
type RuntimeToolExecutionRequest = ReturnType<typeof reserveRuntimeToolExecutionInputSchema.parse>;

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

async function digestHex(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestPermit(
  permit: RuntimeToolExecutionPermit,
  state: "reserved" | "dispatched",
): Promise<string> {
  return digestBase64Url(JSON.stringify({ permit, state }));
}

function createNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
}

export class RuntimeToolExecutions {
  readonly #currentFleetConfiguration: () => FleetConfiguration;
  readonly #database: ControlPlaneDatabase;
  readonly #objectName: string | undefined;
  readonly #sandbox: DurableObjectNamespace<CrewhelmSandbox> | undefined;
  readonly #storage: DurableObjectStorage;

  constructor(
    objectName: string | undefined,
    database: ControlPlaneDatabase,
    storage: DurableObjectStorage,
    currentFleetConfiguration: () => FleetConfiguration,
    sandbox?: DurableObjectNamespace<CrewhelmSandbox>,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#objectName = objectName;
    this.#sandbox = sandbox;
    this.#storage = storage;
  }

  async reserve(input: unknown): Promise<ReserveRuntimeToolExecutionResult> {
    const request = reserveRuntimeToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUNTIME_TOOL_EXECUTION;
    }

    const evaluatedAt = Date.now();
    const validated = this.#validate(this.#database, request.data, evaluatedAt);

    if (!validated.ok) {
      return INVALID_RUNTIME_TOOL_EXECUTION;
    }

    const actionDigest = await digestHex({ schemaVersion: 1, ...request.data.action });
    const nonce = createNonce();
    const permit = runtimeToolExecutionPermitSchema.parse({
      action: request.data.action,
      actionDigest,
      audience: "crew_session_runtime_tool",
      constraints: {
        decisionExpiresAt: new Date(
          evaluatedAt + RUNTIME_TOOL_EXECUTION_PERMIT_LIFETIME_MS,
        ).toISOString(),
        maxDurationMs: validated.maxDurationMs,
        maxOutputBytes: request.data.action.tool.limits.maxOutputBytes,
      },
      nonce,
    });
    const permitDigest = await digestPermit(permit, "reserved");
    // The adapter enforces maxDurationMs around stream open/read. This later deadline is only for
    // durable completion reporting and never extends the permit's execution or dispatch limits.
    const completionDeadline =
      evaluatedAt + validated.maxDurationMs + RUNTIME_TOOL_COMPLETION_GRACE_MS;
    const result = this.#database.transaction((transaction) => {
      const current = this.#validate(transaction, request.data, evaluatedAt);

      if (
        !current.ok ||
        current.maxDurationMs !== validated.maxDurationMs ||
        transaction
          .select({ toolCallId: runtimeToolExecutions.toolCallId })
          .from(runtimeToolExecutions)
          .where(eq(runtimeToolExecutions.toolCallId, request.data.action.toolCallId))
          .get() !== undefined
      ) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      const claimed = transaction
        .update(runAdmissions)
        .set({ toolCallsConsumed: current.toolCallsConsumed + 1 })
        .where(
          and(
            eq(runAdmissions.runId, request.data.runId),
            eq(runAdmissions.toolCallsConsumed, current.toolCallsConsumed),
          ),
        )
        .returning({ runId: runAdmissions.runId })
        .all();

      if (claimed.length !== 1) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      transaction
        .insert(runtimeToolExecutions)
        .values({
          actionDigest,
          expiresAt: completionDeadline,
          cleanupRetryAt: completionDeadline + RUNTIME_TOOL_CLEANUP_GRACE_MS,
          inputDigest: request.data.action.codeDigest,
          nonceDigest: permitDigest,
          runId: request.data.runId,
          startedAt: evaluatedAt,
          status: "reserved",
          toolCallId: request.data.action.toolCallId,
          toolId: request.data.action.tool.id,
        })
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

      return reserveRuntimeToolExecutionResultSchema.parse({ ok: true, permit });
    });

    if (result.ok) {
      recordExecutionEvent({
        outcome: "allowed",
        phase: "tool.reservation",
        runId: request.data.runId,
        toolCallId: request.data.action.toolCallId,
      });
      await this.#scheduleReconciliation(completionDeadline);
    }

    return result;
  }

  async dispatch(input: unknown): Promise<DispatchRuntimeToolExecutionResult> {
    const request = dispatchRuntimeToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUNTIME_TOOL_EXECUTION;
    }

    const permit = request.data.permit;
    const currentTime = Date.now();

    if (Date.parse(permit.constraints.decisionExpiresAt) <= currentTime) {
      return INVALID_RUNTIME_TOOL_EXECUTION;
    }

    const reservedDigest = await digestPermit(permit, "reserved");
    const dispatchedDigest = await digestPermit(permit, "dispatched");
    const result = this.#database.transaction((transaction) => {
      const row = transaction
        .select()
        .from(runtimeToolExecutions)
        .where(eq(runtimeToolExecutions.toolCallId, permit.action.toolCallId))
        .get();

      if (
        row === undefined ||
        row.status !== "reserved" ||
        row.dispatchedAt !== null ||
        row.nonceDigest !== reservedDigest ||
        row.actionDigest !== permit.actionDigest ||
        row.runId !== permit.action.runId ||
        row.startedAt + permit.constraints.maxDurationMs <= currentTime ||
        row.expiresAt <= currentTime
      ) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      const admission = transaction
        .select({
          agentId: runAdmissions.agentId,
          agentRevision: runAdmissions.agentRevision,
          agentStatus: agents.status,
          budgetReservation: runAdmissions.budgetReservation,
          cancellationRequestedAt: runAdmissions.cancellationRequestedAt,
          cleanupAt: runAdmissions.cleanupAt,
          clientId: runAdmissions.clientId,
          currentAgentRevision: agents.currentRevision,
          status: runAdmissions.status,
        })
        .from(runAdmissions)
        .innerJoin(agents, eq(agents.agentId, runAdmissions.agentId))
        .where(eq(runAdmissions.runId, row.runId))
        .get();

      const admittedTool = admission?.budgetReservation.runtimePlan.tools.find(
        (tool) => tool.id === permit.action.tool.id,
      );

      if (
        admission === undefined ||
        admission.status !== "redeemed" ||
        admission.cancellationRequestedAt !== null ||
        admission.cleanupAt <= currentTime ||
        admission.agentId !== permit.action.agentId ||
        admission.agentRevision !== permit.action.agentRevision ||
        admission.agentStatus !== "active" ||
        admission.currentAgentRevision !== permit.action.agentRevision ||
        admission.budgetReservation.fleetConfigurationRevision !==
          this.#currentFleetConfiguration().revision ||
        admittedTool === undefined ||
        JSON.stringify(admittedTool) !== JSON.stringify(permit.action.tool)
      ) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      transaction
        .update(runtimeToolExecutions)
        .set({ dispatchedAt: currentTime, nonceDigest: dispatchedDigest })
        .where(
          and(
            eq(runtimeToolExecutions.toolCallId, row.toolCallId),
            eq(runtimeToolExecutions.nonceDigest, reservedDigest),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "tool.execution_dispatched",
          clientId: admission.clientId,
          occurredAt: currentTime,
          subjectId: row.toolCallId,
        })
        .run();

      return dispatchRuntimeToolExecutionResultSchema.parse({ dispatched: true, ok: true });
    });

    if (result.ok && result.dispatched) {
      recordExecutionEvent({
        outcome: "claimed",
        phase: "tool.dispatch",
        runId: permit.action.runId,
        toolCallId: permit.action.toolCallId,
      });
    }

    return result;
  }

  async complete(input: unknown): Promise<CompleteRuntimeToolExecutionResult> {
    const request = completeRuntimeToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUNTIME_TOOL_EXECUTION;
    }

    const reservedDigest = await digestPermit(request.data.permit, "reserved");
    const dispatchedDigest = await digestPermit(request.data.permit, "dispatched");
    const currentTime = Date.now();
    let completedStatus: "completed" | "failed" | "unknown" | undefined;
    const result = this.#database.transaction((transaction) => {
      const row = transaction
        .select()
        .from(runtimeToolExecutions)
        .where(eq(runtimeToolExecutions.toolCallId, request.data.permit.action.toolCallId))
        .get();

      if (
        row === undefined ||
        row.runId !== request.data.permit.action.runId ||
        row.actionDigest !== request.data.permit.actionDigest ||
        !(
          row.nonceDigest === dispatchedDigest ||
          (row.nonceDigest === reservedDigest && request.data.outcome.status !== "completed")
        )
      ) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      if (row.status !== "reserved") {
        return completeRuntimeToolExecutionResultSchema.parse({ completed: false, ok: true });
      }

      const admission = transaction
        .select({ clientId: runAdmissions.clientId })
        .from(runAdmissions)
        .where(eq(runAdmissions.runId, row.runId))
        .get();

      if (admission === undefined) {
        return INVALID_RUNTIME_TOOL_EXECUTION;
      }

      const status =
        currentTime > row.expiresAt ||
        request.data.outcome.outputBytes > request.data.permit.constraints.maxOutputBytes
          ? "unknown"
          : request.data.outcome.status;
      completedStatus = status;
      transaction
        .update(runtimeToolExecutions)
        .set({
          completedAt: currentTime,
          outputBytes: Math.min(
            request.data.outcome.outputBytes,
            request.data.permit.constraints.maxOutputBytes,
          ),
          status,
        })
        .where(
          and(
            eq(runtimeToolExecutions.toolCallId, row.toolCallId),
            eq(runtimeToolExecutions.status, "reserved"),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: `tool.execution_${status}`,
          clientId: admission.clientId,
          occurredAt: currentTime,
          subjectId: row.toolCallId,
        })
        .run();
      return completeRuntimeToolExecutionResultSchema.parse({ completed: true, ok: true });
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

  reconcileExpired(currentTime: number): string[] {
    const reconciled = this.#database.transaction((transaction) => {
      const expired = transaction
        .select({
          clientId: runAdmissions.clientId,
          dispatchedAt: runtimeToolExecutions.dispatchedAt,
          runId: runtimeToolExecutions.runId,
          toolCallId: runtimeToolExecutions.toolCallId,
        })
        .from(runtimeToolExecutions)
        .innerJoin(runAdmissions, eq(runAdmissions.runId, runtimeToolExecutions.runId))
        .where(
          and(
            eq(runtimeToolExecutions.status, "reserved"),
            lte(runtimeToolExecutions.expiresAt, currentTime),
          ),
        )
        .all();

      for (const execution of expired) {
        const status = execution.dispatchedAt === null ? "failed" : "unknown";
        transaction
          .update(runtimeToolExecutions)
          .set({ completedAt: currentTime, outputBytes: 0, status })
          .where(
            and(
              eq(runtimeToolExecutions.toolCallId, execution.toolCallId),
              eq(runtimeToolExecutions.status, "reserved"),
            ),
          )
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: `tool.execution_${status}`,
            clientId: execution.clientId,
            occurredAt: currentTime,
            subjectId: execution.toolCallId,
          })
          .run();
      }

      return expired;
    });

    for (const execution of reconciled) {
      recordExecutionEvent({
        outcome: execution.dispatchedAt === null ? "failed" : "unknown",
        outputBytes: 0,
        phase: "tool.completion",
        runId: execution.runId,
        toolCallId: execution.toolCallId,
      });
    }

    return [...new Set(reconciled.map((execution) => execution.runId))];
  }

  async reconcileCleanup(currentTime: number): Promise<void> {
    const pending = this.#database
      .select({
        cleanupRetryAt: runtimeToolExecutions.cleanupRetryAt,
        expiresAt: runtimeToolExecutions.expiresAt,
        toolCallId: runtimeToolExecutions.toolCallId,
      })
      .from(runtimeToolExecutions)
      .where(
        and(
          isNull(runtimeToolExecutions.cleanupAt),
          lte(runtimeToolExecutions.cleanupRetryAt, currentTime),
        ),
      )
      .limit(16)
      .all();

    for (const execution of pending) {
      let cleaned = false;

      if (this.#sandbox !== undefined) {
        let timeout: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            this.#sandbox.getByName(execution.toolCallId).destroyAndPurge(),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Sandbox cleanup timed out.")),
                RUNTIME_TOOL_CLEANUP_TIMEOUT_MS,
              );
            }),
          ]);
          cleaned = true;
        } catch {
          // The exact Sandbox ID remains in the owner ledger for the next bounded retry.
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      }

      this.#database
        .update(runtimeToolExecutions)
        .set(
          cleaned && currentTime >= execution.expiresAt + RUNTIME_TOOL_LATE_OPEN_CLEANUP_HORIZON_MS
            ? { cleanupAt: currentTime }
            : { cleanupRetryAt: currentTime + RUNTIME_TOOL_CLEANUP_RETRY_MS },
        )
        .where(
          and(
            eq(runtimeToolExecutions.toolCallId, execution.toolCallId),
            isNull(runtimeToolExecutions.cleanupAt),
            eq(runtimeToolExecutions.cleanupRetryAt, execution.cleanupRetryAt),
          ),
        )
        .run();
    }
  }

  nextReconciliationAt(): number | null {
    const executionAt =
      this.#database
        .select({ value: min(runtimeToolExecutions.expiresAt) })
        .from(runtimeToolExecutions)
        .where(eq(runtimeToolExecutions.status, "reserved"))
        .get()?.value ?? null;
    const cleanupAt =
      this.#database
        .select({ value: min(runtimeToolExecutions.cleanupRetryAt) })
        .from(runtimeToolExecutions)
        .where(isNull(runtimeToolExecutions.cleanupAt))
        .get()?.value ?? null;

    return executionAt === null
      ? cleanupAt
      : cleanupAt === null
        ? executionAt
        : Math.min(executionAt, cleanupAt);
  }

  async #scheduleReconciliation(reconcileAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || reconcileAt < scheduledAlarm) {
      await this.#storage.setAlarm(reconcileAt);
    }
  }

  #validate(
    database: RuntimeToolExecutionDatabase,
    request: RuntimeToolExecutionRequest,
    evaluatedAt: number,
  ): { maxDurationMs: number; ok: true; toolCallsConsumed: number } | { ok: false } {
    if (
      request.ownerKey !== this.#objectName ||
      request.action.ownerKey !== request.ownerKey ||
      request.action.agentId !== request.agentId ||
      request.action.agentRevision !== request.agentRevision ||
      request.action.runId !== request.runId
    ) {
      return { ok: false };
    }

    const admission = database
      .select()
      .from(runAdmissions)
      .where(eq(runAdmissions.runId, request.runId))
      .get();
    const currentAgent = database
      .select({ currentRevision: agents.currentRevision, status: agents.status })
      .from(agents)
      .where(eq(agents.agentId, request.agentId))
      .get();
    const admittedTool = request.budgetReservation.runtimePlan.tools?.find(
      (tool) => tool.id === request.action.tool.id,
    );

    if (
      admission === undefined ||
      currentAgent === undefined ||
      admission.status !== "redeemed" ||
      admission.cancellationRequestedAt !== null ||
      admission.cleanupAt <= evaluatedAt ||
      admission.agentId !== request.agentId ||
      admission.agentRevision !== request.agentRevision ||
      admission.clientId !== request.clientId ||
      admission.idempotencyKey !== request.idempotencyKey ||
      admission.promptDigest !== request.promptDigest ||
      admission.scheduleRevision !== request.scheduleRevision ||
      JSON.stringify(admission.briefContext) !== JSON.stringify(request.briefContext ?? null) ||
      JSON.stringify(admission.budgetReservation) !== JSON.stringify(request.budgetReservation) ||
      admission.budgetReservation.fleetConfigurationRevision !==
        this.#currentFleetConfiguration().revision ||
      currentAgent.currentRevision !== request.agentRevision ||
      currentAgent.status !== "active" ||
      admittedTool === undefined ||
      JSON.stringify(admittedTool) !== JSON.stringify(request.action.tool) ||
      !request.action.tool.languages.includes(request.action.language) ||
      admission.toolCallsConsumed >= request.budgetReservation.maxToolCalls
    ) {
      return { ok: false };
    }

    const duplicateCalls =
      database
        .select({ value: count() })
        .from(runtimeToolExecutions)
        .where(
          and(
            eq(runtimeToolExecutions.runId, request.runId),
            eq(runtimeToolExecutions.toolId, request.action.tool.id),
            eq(runtimeToolExecutions.inputDigest, request.action.codeDigest),
          ),
        )
        .get()?.value ?? 0;
    const activeCalls =
      database
        .select({ value: count() })
        .from(runtimeToolExecutions)
        .where(
          and(
            eq(runtimeToolExecutions.runId, request.runId),
            eq(runtimeToolExecutions.toolId, request.action.tool.id),
            eq(runtimeToolExecutions.status, "reserved"),
            gt(runtimeToolExecutions.expiresAt, evaluatedAt),
          ),
        )
        .get()?.value ?? 0;

    if (
      activeCalls > 0 ||
      duplicateCalls >= request.budgetReservation.integrationLimits.duplicateToolCallLimit
    ) {
      return { ok: false };
    }

    const runDeadline = admission.createdAt + request.budgetReservation.maxDurationSeconds * 1_000;
    const maxDurationMs = Math.min(
      request.action.tool.limits.maxDurationMs,
      MAXIMUM_RUNTIME_TOOL_EXECUTION_MS,
      runDeadline - evaluatedAt,
    );

    return maxDurationMs > 0
      ? { maxDurationMs, ok: true, toolCallsConsumed: admission.toolCallsConsumed }
      : { ok: false };
  }
}
