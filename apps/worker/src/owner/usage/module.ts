import { RUN_BUDGET_WINDOW_MS, recordAiGatewayCallInputSchema } from "@crewhelm/contracts";
import { and, eq, gt, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { aiGatewayCalls, runAdmissions, type ControlPlaneDatabaseSchema } from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ReadDatabase = Database | Transaction;
type GatewayLogReader = Pick<ReturnType<Ai["gateway"]>, "getLog">;

interface AiGatewayUsageSource {
  gateway(id: string): GatewayLogReader;
}

const INITIAL_RECONCILIATION_DELAY_MS = 1_000;
const MAXIMUM_RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_RECONCILIATIONS_PER_ALARM = 25;

function reconciliationDelay(attempt: number): number {
  return Math.min(
    INITIAL_RECONCILIATION_DELAY_MS * 2 ** Math.min(attempt, 8),
    MAXIMUM_RECONCILIATION_DELAY_MS,
  );
}

function costMicrousd(costUsd: number): number | null {
  const value = Math.ceil(costUsd * 1_000_000);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function currentFleetAiSpendMicrousd(database: ReadDatabase, currentTime: number): number {
  const admissions = database
    .select({
      budgetReservation: runAdmissions.budgetReservation,
      createdAt: runAdmissions.createdAt,
      runId: runAdmissions.runId,
    })
    .from(runAdmissions)
    .where(gt(runAdmissions.createdAt, currentTime - RUN_BUDGET_WINDOW_MS))
    .all();
  const calls = database
    .select({
      costMicrousd: aiGatewayCalls.costMicrousd,
      reservationMicrousd: aiGatewayCalls.reservationMicrousd,
      runId: aiGatewayCalls.runId,
      status: aiGatewayCalls.status,
    })
    .from(aiGatewayCalls)
    .where(gt(aiGatewayCalls.recordedAt, currentTime - RUN_BUDGET_WINDOW_MS))
    .all();
  const usageByRun = new Map<string, { pendingReservation: number; settled: number }>();

  for (const call of calls) {
    const usage = usageByRun.get(call.runId) ?? { pendingReservation: 0, settled: 0 };
    usage.pendingReservation =
      call.status === "pending"
        ? Math.max(usage.pendingReservation, call.reservationMicrousd)
        : usage.pendingReservation;
    usage.settled += call.costMicrousd ?? 0;
    usageByRun.set(call.runId, usage);
  }

  const admissionRunIds = new Set(admissions.map((admission) => admission.runId));
  const admittedSpend = admissions.reduce((total, admission) => {
    const usage = usageByRun.get(admission.runId) ?? { pendingReservation: 0, settled: 0 };
    const deadline = admission.createdAt + admission.budgetReservation.maxDurationSeconds * 1_000;
    const activeReservation =
      currentTime < deadline
        ? admission.budgetReservation.aiSpendReservationMicrousd
        : usage.pendingReservation;

    return total + Math.max(activeReservation, usage.settled);
  }, 0);
  const orphanedSpend = [...usageByRun.entries()].reduce(
    (total, [runId, usage]) =>
      admissionRunIds.has(runId)
        ? total
        : total + Math.max(usage.pendingReservation, usage.settled),
    0,
  );

  return admittedSpend + orphanedSpend;
}

export class AiGatewayUsage {
  readonly #ai: AiGatewayUsageSource;
  readonly #database: Database;
  readonly #gatewayId: string;
  readonly #storage: DurableObjectStorage;

  constructor(
    database: Database,
    storage: DurableObjectStorage,
    ai: AiGatewayUsageSource,
    gatewayId: string,
  ) {
    this.#ai = ai;
    this.#database = database;
    this.#gatewayId = gatewayId;
    this.#storage = storage;
  }

  async record(input: unknown): Promise<void> {
    const request = recordAiGatewayCallInputSchema.safeParse(input);

    if (!request.success) {
      return;
    }

    const { gatewayLogId, reference } = request.data;
    const recordedAt = Date.now();
    const inserted = this.#database.transaction((transaction) => {
      const admission = transaction
        .select()
        .from(runAdmissions)
        .where(eq(runAdmissions.runId, reference.runId))
        .get();

      if (
        admission === undefined ||
        admission.status !== "redeemed" ||
        admission.agentId !== reference.agentId ||
        admission.agentRevision !== reference.agentRevision ||
        admission.clientId !== reference.clientId ||
        admission.idempotencyKey !== reference.idempotencyKey ||
        admission.promptDigest !== reference.promptDigest ||
        JSON.stringify(admission.budgetReservation) !== JSON.stringify(reference.budgetReservation)
      ) {
        return false;
      }

      return (
        transaction
          .insert(aiGatewayCalls)
          .values({
            agentId: reference.agentId,
            gatewayLogId,
            nextReconciliationAt: recordedAt,
            recordedAt,
            reservationMicrousd: reference.budgetReservation.aiSpendReservationMicrousd,
            runId: reference.runId,
            status: "pending",
          })
          .onConflictDoNothing()
          .returning({ gatewayLogId: aiGatewayCalls.gatewayLogId })
          .all().length === 1
      );
    });

    if (!inserted) {
      return;
    }

    await this.#reconcile(gatewayLogId, recordedAt);
  }

  async reconcilePending(currentTime: number): Promise<void> {
    this.#database
      .delete(aiGatewayCalls)
      .where(lte(aiGatewayCalls.recordedAt, currentTime - RUN_BUDGET_WINDOW_MS))
      .run();

    const pending = this.#database
      .select({ gatewayLogId: aiGatewayCalls.gatewayLogId })
      .from(aiGatewayCalls)
      .where(
        and(
          eq(aiGatewayCalls.status, "pending"),
          lte(aiGatewayCalls.nextReconciliationAt, currentTime),
        ),
      )
      .limit(MAXIMUM_RECONCILIATIONS_PER_ALARM)
      .all();

    for (const call of pending) {
      await this.#reconcile(call.gatewayLogId, currentTime);
    }
  }

  nextReconciliationAt(): number | null {
    return (
      this.#database
        .select({ value: min(aiGatewayCalls.nextReconciliationAt) })
        .from(aiGatewayCalls)
        .where(eq(aiGatewayCalls.status, "pending"))
        .get()?.value ?? null
    );
  }

  async #reconcile(gatewayLogId: string, currentTime: number): Promise<void> {
    const row = this.#database
      .select({
        agentId: aiGatewayCalls.agentId,
        reconciliationAttempts: aiGatewayCalls.reconciliationAttempts,
        runId: aiGatewayCalls.runId,
        status: aiGatewayCalls.status,
      })
      .from(aiGatewayCalls)
      .where(eq(aiGatewayCalls.gatewayLogId, gatewayLogId))
      .get();

    if (row === undefined || row.status !== "pending") {
      return;
    }

    try {
      const log = await this.#ai.gateway(this.#gatewayId).getLog(gatewayLogId);
      const cost =
        typeof log.cost === "number" && Number.isFinite(log.cost) ? costMicrousd(log.cost) : null;

      if (
        log.id !== gatewayLogId ||
        log.metadata?.crewhelm_run !== row.runId ||
        log.metadata?.crewhelm_agent !== row.agentId ||
        cost === null
      ) {
        throw new Error("AI Gateway log is not ready.");
      }

      this.#database
        .update(aiGatewayCalls)
        .set({
          costMicrousd: cost,
          inputTokens: log.tokens_in ?? null,
          outputTokens: log.tokens_out ?? null,
          settledAt: currentTime,
          status: "settled",
        })
        .where(
          and(eq(aiGatewayCalls.gatewayLogId, gatewayLogId), eq(aiGatewayCalls.status, "pending")),
        )
        .run();
    } catch {
      const nextReconciliationAt = currentTime + reconciliationDelay(row.reconciliationAttempts);
      this.#database
        .update(aiGatewayCalls)
        .set({
          nextReconciliationAt,
          reconciliationAttempts: row.reconciliationAttempts + 1,
        })
        .where(
          and(eq(aiGatewayCalls.gatewayLogId, gatewayLogId), eq(aiGatewayCalls.status, "pending")),
        )
        .run();
      await this.#schedule(nextReconciliationAt);
    }
  }

  async #schedule(reconcileAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || reconcileAt < scheduledAlarm) {
      await this.#storage.setAlarm(reconcileAt);
    }
  }
}
