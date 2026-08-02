import { RUN_BUDGET_WINDOW_MS, recordAiGatewayCallInputSchema } from "@crewhelm/contracts";
import { and, eq, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { aiGatewayCalls, runAdmissions, type ControlPlaneDatabaseSchema } from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type GatewayLogReader = Pick<ReturnType<Ai["gateway"]>, "getLog">;

interface AiGatewayUsageSource {
  gateway(id: string): GatewayLogReader;
}

type GatewayLogState =
  | {
      costMicrousd: number;
      inputTokens: number | null;
      outputTokens: number | null;
      state: "ready";
    }
  | { state: "not_ready" }
  | { state: "unavailable" };

const INITIAL_RECONCILIATION_DELAY_MS = 1_000;
const MAXIMUM_RECONCILIATION_DELAY_MS = 5 * 60 * 1_000;
const MAXIMUM_RECONCILIATIONS_PER_ALARM = 25;
const DEFAULT_AI_GATEWAY_COST_ESTIMATE_MICROUSD = 50_000;

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

function tokenCount(value: number | undefined): number | null | undefined {
  if (value === undefined) {
    return null;
  }

  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export class AiGatewayUsage {
  readonly #ai: AiGatewayUsageSource;
  readonly #database: Database;
  readonly #gatewayId: string | undefined;
  readonly #storage: DurableObjectStorage;

  constructor(
    database: Database,
    storage: DurableObjectStorage,
    ai: AiGatewayUsageSource,
    gatewayId?: string,
  ) {
    this.#ai = ai;
    this.#database = database;
    this.#gatewayId = gatewayId;
    this.#storage = storage;
  }

  async record(input: unknown): Promise<void> {
    if (this.#gatewayId === undefined) {
      return;
    }

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
            reservationMicrousd: DEFAULT_AI_GATEWAY_COST_ESTIMATE_MICROUSD,
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
    if (this.#gatewayId === undefined) {
      return;
    }

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
    if (this.#gatewayId === undefined) {
      return null;
    }

    return (
      this.#database
        .select({ value: min(aiGatewayCalls.nextReconciliationAt) })
        .from(aiGatewayCalls)
        .where(eq(aiGatewayCalls.status, "pending"))
        .get()?.value ?? null
    );
  }

  async #reconcile(gatewayLogId: string, currentTime: number): Promise<void> {
    const gatewayId = this.#gatewayId;

    if (gatewayId === undefined) {
      return;
    }

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

    const log = await this.#readGatewayLog(gatewayId, gatewayLogId, row.runId, row.agentId);

    switch (log.state) {
      case "ready":
        this.#database
          .update(aiGatewayCalls)
          .set({
            costMicrousd: log.costMicrousd,
            inputTokens: log.inputTokens,
            outputTokens: log.outputTokens,
            settledAt: currentTime,
            status: "settled",
          })
          .where(
            and(
              eq(aiGatewayCalls.gatewayLogId, gatewayLogId),
              eq(aiGatewayCalls.status, "pending"),
            ),
          )
          .run();
        return;
      case "not_ready":
      case "unavailable": {
        const nextReconciliationAt = currentTime + reconciliationDelay(row.reconciliationAttempts);
        this.#database
          .update(aiGatewayCalls)
          .set({
            nextReconciliationAt,
            reconciliationAttempts: row.reconciliationAttempts + 1,
          })
          .where(
            and(
              eq(aiGatewayCalls.gatewayLogId, gatewayLogId),
              eq(aiGatewayCalls.status, "pending"),
            ),
          )
          .run();
        await this.#schedule(nextReconciliationAt);
      }
    }
  }

  async #readGatewayLog(
    gatewayId: string,
    gatewayLogId: string,
    runId: string,
    agentId: string,
  ): Promise<GatewayLogState> {
    let log: AiGatewayLog;

    try {
      log = await this.#ai.gateway(gatewayId).getLog(gatewayLogId);
    } catch {
      return { state: "unavailable" };
    }

    const cost =
      typeof log.cost === "number" && Number.isFinite(log.cost) ? costMicrousd(log.cost) : null;
    const inputTokens = tokenCount(log.tokens_in);
    const outputTokens = tokenCount(log.tokens_out);

    if (
      log.id !== gatewayLogId ||
      log.metadata?.crewhelm_run !== runId ||
      log.metadata?.crewhelm_agent !== agentId ||
      cost === null ||
      inputTokens === undefined ||
      outputTokens === undefined
    ) {
      return { state: "not_ready" };
    }

    return {
      costMicrousd: cost,
      inputTokens,
      outputTokens,
      state: "ready",
    };
  }

  async #schedule(reconcileAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || reconcileAt < scheduledAlarm) {
      await this.#storage.setAlarm(reconcileAt);
    }
  }
}
