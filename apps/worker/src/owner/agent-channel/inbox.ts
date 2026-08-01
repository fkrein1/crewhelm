import {
  AGENT_INBOX_POLL_AFTER_SECONDS,
  MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS,
  agentInboxDeferredReasonSchema,
  agentInboxInputSchema,
  agentInboxItemSchema,
  agentInboxResultSchema,
  recordAgentInboxRunInputSchema,
  recordAgentInboxRunResultSchema,
  type AgentInboxDeferredReason,
  type AgentInboxInput,
  type AgentInboxItem,
  type AgentInboxResult,
  type AgentInboxSeverity,
  type FleetConfigurationData,
  type OwnerAuthority,
  type RecordAgentInboxRunResult,
} from "@crewhelm/contracts";
import { and, count, desc, eq, gt, inArray, isNull, lt, lte, not, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentInboxAcknowledgements,
  agentInboxItems,
  agentRevisions,
  agentScheduleRevisions,
  auditEvents,
  runAdmissions,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type AgentInboxFailure = Extract<AgentInboxResult, { ok: false }>;
type AgentInboxCounts = Extract<AgentInboxResult, { action: "overview"; ok: true }>["counts"];
type StoredInboxItem = typeof agentInboxItems.$inferSelect;

const AGENT_INBOX_CLEANUP_BATCH_SIZE = 100;
const MAXIMUM_STORED_AGENT_INBOX_ITEMS = 10_000;
const MAXIMUM_EVENT_CLOCK_SKEW_MS = 60_000;

function timestampOrNull(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function preview(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return "Task context is unavailable.";
  }

  return normalized.slice(0, MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS);
}

function deferredItemId(scheduleId: string): string {
  return `inbox_deferred_${scheduleId.slice("schedule_".length)}`;
}

function unreachable(_value: never): never {
  throw new Error("Unreachable Agent inbox state.");
}

function deferredWorkPolicy(reason: AgentInboxDeferredReason): {
  layer: "agent" | "fleet" | "integration" | "runtime" | "schedule";
  nextAction: "review_configuration" | "wait_until_retry";
  summary: string;
} {
  switch (reason) {
    case "active_run":
      return {
        layer: "agent",
        nextAction: "wait_until_retry",
        summary: "Scheduled work was deferred because this Agent still had an active run.",
      };
    case "admission_limit_exceeded":
      return {
        layer: "fleet",
        nextAction: "wait_until_retry",
        summary: "Scheduled work was deferred by the fleet's bounded run-admission capacity.",
      };
    case "budget_exhausted":
      return {
        layer: "fleet",
        nextAction: "review_configuration",
        summary: "Scheduled work was deferred because its bounded execution budget was exhausted.",
      };
    case "capability_unavailable":
      return {
        layer: "integration",
        nextAction: "review_configuration",
        summary:
          "Scheduled work was deferred because an attached integration capability was unavailable.",
      };
    case "model_unavailable":
      return {
        layer: "fleet",
        nextAction: "review_configuration",
        summary: "Scheduled work was deferred because its configured model was unavailable.",
      };
    case "agent_not_found":
    case "agent_unavailable":
    case "revision_conflict":
    case "run_unavailable":
      return {
        layer: "agent",
        nextAction: "review_configuration",
        summary: "Scheduled work was deferred because the configured Agent was unavailable.",
      };
    case "idempotency_conflict":
    case "record_dispatch_conflict":
      return {
        layer: "schedule",
        nextAction: "wait_until_retry",
        summary: "Scheduled work was deferred because its dispatch state changed concurrently.",
      };
    case "dispatch_exception":
    case "brief_context_too_large":
    case "brief_unavailable":
      return {
        layer: "runtime",
        nextAction: "wait_until_retry",
        summary: "Scheduled work was deferred because its runtime dispatch failed.",
      };
  }

  return unreachable(reason);
}

const DEFERRED_REASONS_REQUIRING_ACTION = agentInboxDeferredReasonSchema.options.filter(
  (reason) => deferredWorkPolicy(reason).nextAction === "review_configuration",
);

function needsActionCondition(): SQL {
  const condition = or(
    inArray(agentInboxItems.kind, ["action_required", "exception"]),
    and(
      eq(agentInboxItems.kind, "deferred"),
      inArray(agentInboxItems.reason, DEFERRED_REASONS_REQUIRING_ACTION),
    ),
  );

  if (condition === undefined) {
    throw new Error("Agent inbox actionability condition is unavailable.");
  }

  return condition;
}

function warningCondition(): SQL {
  const condition = and(
    eq(agentInboxItems.kind, "deferred"),
    not(inArray(agentInboxItems.reason, DEFERRED_REASONS_REQUIRING_ACTION)),
  );

  if (condition === undefined) {
    throw new Error("Agent inbox warning condition is unavailable.");
  }

  return condition;
}

function severityCondition(severities: AgentInboxSeverity[] | undefined): SQL | undefined {
  if (severities === undefined) {
    return undefined;
  }

  const conditions = severities.map((severity) => {
    switch (severity) {
      case "attention_required":
        return needsActionCondition();
      case "info":
        return eq(agentInboxItems.kind, "outcome");
      case "warning":
        return warningCondition();
    }

    return unreachable(severity);
  });

  return or(...conditions);
}

function runPresentation(item: StoredInboxItem): {
  nextAction: "decide_approval" | "inspect_run" | "review_output";
  summary: string;
} {
  switch (item.kind) {
    case "action_required":
      return {
        nextAction: "decide_approval",
        summary: `${item.approvalCount} tool action${item.approvalCount === 1 ? "" : "s"} waiting for an approval decision.`,
      };
    case "exception":
      return {
        nextAction: "inspect_run",
        summary: "Run failed; inspect its execution timeline to locate the failing phase.",
      };
    case "outcome":
      return {
        nextAction:
          item.runStatus === "cancelled" || item.resultPreview === null
            ? "inspect_run"
            : "review_output",
        summary:
          item.runStatus === "cancelled"
            ? "Run was cancelled before more work could be dispatched."
            : item.resultPreview === null
              ? "Run finished without a retained result preview; inspect it for details."
              : "Run completed and a bounded result preview is ready to review.",
      };
    case "deferred":
      throw new Error("Deferred inbox items do not use run presentation.");
  }

  return unreachable(item.kind);
}

export function deniedAgentInbox(code: AgentInboxFailure["error"]["code"]): AgentInboxFailure {
  return {
    error: { code, message: "Agent inbox request denied." },
    ok: false,
  };
}

export class AgentInbox {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: Database;
  readonly #objectName: string | undefined;

  constructor(
    objectName: string | undefined,
    database: Database,
    currentFleetConfiguration: () => FleetConfigurationData,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#objectName = objectName;
  }

  handle(authority: OwnerAuthority, input: unknown): AgentInboxResult {
    const request = agentInboxInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentInbox("invalid_request");
    }

    const currentTime = Date.now();

    this.#cleanup(currentTime);

    switch (request.data.action) {
      case "acknowledge":
        return this.#acknowledge(authority, request.data, currentTime);
      case "list":
        return this.#list(request.data, currentTime);
      case "overview":
        return this.#overview(request.data, currentTime);
    }

    return unreachable(request.data.action);
  }

  usage(): AgentInboxCounts {
    const currentTime = Date.now();

    return this.#counts({ action: "overview" }, currentTime);
  }

  #acknowledge(
    authority: OwnerAuthority,
    request: AgentInboxInput,
    currentTime: number,
  ): AgentInboxResult {
    if (
      request.itemId === undefined ||
      request.version === undefined ||
      request.agentId !== undefined ||
      request.cursor !== undefined ||
      request.includeAcknowledged !== undefined ||
      request.kinds !== undefined ||
      request.limit !== undefined ||
      request.needsAction !== undefined ||
      request.occurredAfter !== undefined ||
      request.severities !== undefined
    ) {
      return deniedAgentInbox("invalid_request");
    }

    const item = this.#database
      .select({
        cleanupAt: agentInboxItems.cleanupAt,
        itemId: agentInboxItems.itemId,
        kind: agentInboxItems.kind,
        version: agentInboxItems.version,
      })
      .from(agentInboxItems)
      .where(
        and(eq(agentInboxItems.itemId, request.itemId), gt(agentInboxItems.cleanupAt, currentTime)),
      )
      .get();

    if (item === undefined) {
      return deniedAgentInbox("inbox_item_not_found");
    }

    if (item.version !== request.version) {
      return deniedAgentInbox("inbox_item_changed");
    }

    if (item.kind === "action_required") {
      return deniedAgentInbox("inbox_item_not_acknowledgeable");
    }

    const acknowledgedAt = Date.now();

    this.#database.transaction((transaction) => {
      const inserted = transaction
        .insert(agentInboxAcknowledgements)
        .values({
          acknowledgedAt,
          cleanupAt: Math.max(item.cleanupAt, acknowledgedAt + this.#retentionMilliseconds()),
          clientId: authority.clientId,
          itemId: item.itemId,
          version: item.version,
        })
        .onConflictDoNothing()
        .returning({ itemId: agentInboxAcknowledgements.itemId })
        .all();

      if (inserted.length === 1) {
        transaction
          .insert(auditEvents)
          .values({
            action: "agent.inbox_acknowledged",
            clientId: authority.clientId,
            occurredAt: acknowledgedAt,
            subjectId: item.itemId,
          })
          .run();
      }
    });

    return agentInboxResultSchema.parse({
      acknowledged: true,
      action: "acknowledge",
      itemId: item.itemId,
      ok: true,
      version: item.version,
    });
  }

  #list(request: AgentInboxInput, currentTime: number): AgentInboxResult {
    if (request.itemId !== undefined || request.version !== undefined) {
      return deniedAgentInbox("invalid_request");
    }

    const cursor =
      request.cursor === undefined
        ? undefined
        : this.#database
            .select({
              itemId: agentInboxItems.itemId,
              occurredAt: agentInboxItems.occurredAt,
            })
            .from(agentInboxItems)
            .where(
              and(
                eq(agentInboxItems.itemId, request.cursor),
                gt(agentInboxItems.cleanupAt, currentTime),
              ),
            )
            .get();

    if (request.cursor !== undefined && cursor === undefined) {
      return deniedAgentInbox("invalid_request");
    }

    const limit = request.limit ?? 10;
    const rows = this.#database
      .select({
        acknowledgedAt: agentInboxAcknowledgements.acknowledgedAt,
        agentName: agentRevisions.name,
        item: agentInboxItems,
      })
      .from(agentInboxItems)
      .innerJoin(
        agentRevisions,
        and(
          eq(agentRevisions.agentId, agentInboxItems.agentId),
          eq(agentRevisions.revision, agentInboxItems.agentRevision),
        ),
      )
      .leftJoin(
        agentInboxAcknowledgements,
        and(
          eq(agentInboxAcknowledgements.itemId, agentInboxItems.itemId),
          eq(agentInboxAcknowledgements.version, agentInboxItems.version),
        ),
      )
      .where(
        and(
          ...this.#filterConditions(request, currentTime),
          cursor === undefined
            ? undefined
            : or(
                lt(agentInboxItems.occurredAt, cursor.occurredAt),
                and(
                  eq(agentInboxItems.occurredAt, cursor.occurredAt),
                  lt(agentInboxItems.itemId, cursor.itemId),
                ),
              ),
        ),
      )
      .orderBy(desc(agentInboxItems.occurredAt), desc(agentInboxItems.itemId))
      .limit(limit + 1)
      .all();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const items = page.map((row) => this.#item(row.item, row.agentName, row.acknowledgedAt));

    return agentInboxResultSchema.parse({
      action: "list",
      generatedAt: new Date(currentTime).toISOString(),
      items,
      nextCursor: hasMore ? (items.at(-1)?.itemId ?? null) : null,
      ok: true,
      pollAfterSeconds: AGENT_INBOX_POLL_AFTER_SECONDS,
    });
  }

  #overview(request: AgentInboxInput, currentTime: number): AgentInboxResult {
    if (
      request.cursor !== undefined ||
      request.itemId !== undefined ||
      request.limit !== undefined ||
      request.version !== undefined
    ) {
      return deniedAgentInbox("invalid_request");
    }

    const counts = this.#counts(request, currentTime);

    return agentInboxResultSchema.parse({
      action: "overview",
      counts,
      generatedAt: new Date(currentTime).toISOString(),
      ok: true,
      pollAfterSeconds: AGENT_INBOX_POLL_AFTER_SECONDS,
    });
  }

  #counts(request: AgentInboxInput, currentTime: number): AgentInboxCounts {
    const needsAction = needsActionCondition();
    const warning = warningCondition();
    const row = this.#database
      .select({
        actionRequired: sql<number>`count(*) FILTER (
          WHERE ${agentInboxItems.kind} = 'action_required'
        )`,
        deferred: sql<number>`count(*) FILTER (WHERE ${agentInboxItems.kind} = 'deferred')`,
        exceptions: sql<number>`count(*) FILTER (WHERE ${agentInboxItems.kind} = 'exception')`,
        needsAction: sql<number>`count(*) FILTER (WHERE ${needsAction})`,
        oldestNeedsActionAt: sql<number | null>`min(
          CASE WHEN ${needsAction} THEN ${agentInboxItems.occurredAt} END
        )`,
        outcomes: sql<number>`count(*) FILTER (WHERE ${agentInboxItems.kind} = 'outcome')`,
        total: count(),
        warnings: sql<number>`count(*) FILTER (WHERE ${warning})`,
      })
      .from(agentInboxItems)
      .leftJoin(
        agentInboxAcknowledgements,
        and(
          eq(agentInboxAcknowledgements.itemId, agentInboxItems.itemId),
          eq(agentInboxAcknowledgements.version, agentInboxItems.version),
        ),
      )
      .where(and(...this.#filterConditions(request, currentTime)))
      .get();

    return {
      actionRequired: row?.actionRequired ?? 0,
      attention: {
        needsAction: row?.needsAction ?? 0,
        oldestNeedsActionAt: timestampOrNull(row?.oldestNeedsActionAt ?? null),
        warnings: row?.warnings ?? 0,
      },
      deferred: row?.deferred ?? 0,
      exceptions: row?.exceptions ?? 0,
      outcomes: row?.outcomes ?? 0,
      total: row?.total ?? 0,
    };
  }

  #filterConditions(request: AgentInboxInput, currentTime: number): Array<SQL | undefined> {
    return [
      gt(agentInboxItems.cleanupAt, currentTime),
      request.agentId === undefined ? undefined : eq(agentInboxItems.agentId, request.agentId),
      request.includeAcknowledged === true ? undefined : isNull(agentInboxAcknowledgements.itemId),
      request.kinds === undefined ? undefined : inArray(agentInboxItems.kind, request.kinds),
      request.needsAction === undefined
        ? undefined
        : request.needsAction
          ? needsActionCondition()
          : not(needsActionCondition()),
      request.occurredAfter === undefined
        ? undefined
        : gt(agentInboxItems.occurredAt, Date.parse(request.occurredAfter)),
      severityCondition(request.severities),
    ];
  }

  #item(item: StoredInboxItem, agentName: string, acknowledgedAt: number | null): AgentInboxItem {
    const deferred =
      item.kind === "deferred" && item.reason !== null
        ? deferredWorkPolicy(item.reason)
        : undefined;
    const run = deferred === undefined ? runPresentation(item) : undefined;
    const needsAction =
      item.kind === "action_required" ||
      item.kind === "exception" ||
      (item.kind === "deferred" && deferred?.nextAction === "review_configuration");
    const severity = needsAction
      ? "attention_required"
      : item.kind === "deferred"
        ? "warning"
        : "info";

    return agentInboxItemSchema.parse({
      acknowledgedAt: timestampOrNull(acknowledgedAt),
      agentId: item.agentId,
      agentName,
      approvalCount: item.approvalCount,
      configuration: {
        agentRevision: item.agentRevision,
        fleetRevision: item.fleetRevision,
        scheduleId: item.scheduleId,
        scheduleRevision: item.scheduleRevision,
      },
      itemId: item.itemId,
      kind: item.kind,
      needsAction,
      nextAction: deferred?.nextAction ?? run?.nextAction,
      occurredAt: item.version,
      policy:
        deferred === undefined || item.reason === null
          ? null
          : {
              layer: deferred.layer,
              reason: item.reason,
              retryAt: timestampOrNull(item.retryAt),
            },
      requestPreview: item.requestPreview,
      resultPreview: item.resultPreview,
      runId: item.runId,
      runStatus: item.runStatus,
      severity,
      summary: deferred?.summary ?? run?.summary,
      version: item.version,
    });
  }

  async recordRun(input: unknown): Promise<RecordAgentInboxRunResult> {
    const request = recordAgentInboxRunInputSchema.safeParse(input);

    if (!request.success || request.data.reference.ownerKey !== this.#objectName) {
      return this.#deniedProjection();
    }

    const admission = this.#database
      .select()
      .from(runAdmissions)
      .where(eq(runAdmissions.runId, request.data.reference.runId))
      .get();

    if (
      admission === undefined ||
      admission.agentId !== request.data.reference.agentId ||
      admission.agentRevision !== request.data.reference.agentRevision ||
      admission.idempotencyKey !== request.data.reference.idempotencyKey ||
      admission.promptDigest !== request.data.reference.promptDigest ||
      admission.scheduleRevision !== request.data.reference.scheduleRevision ||
      (admission.status !== "redeemed" &&
        !(request.data.event.runStatus === "cancelled" && admission.cancelledAt !== null))
    ) {
      return this.#deniedProjection();
    }

    const schedule =
      admission.scheduleRevision === null
        ? null
        : this.#database
            .select({ scheduleId: agentScheduleRevisions.scheduleId })
            .from(agentScheduleRevisions)
            .where(
              and(
                eq(agentScheduleRevisions.agentId, admission.agentId),
                eq(agentScheduleRevisions.revision, admission.scheduleRevision),
              ),
            )
            .get();

    if (admission.scheduleRevision !== null && schedule === undefined) {
      return this.#deniedProjection();
    }

    const executionStates =
      request.data.event.kind === "outcome" && request.data.event.runStatus === "completed"
        ? this.#database
            .select({
              reconciliation: toolExecutions.reconciliation,
              status: toolExecutions.status,
            })
            .from(toolExecutions)
            .where(eq(toolExecutions.runId, admission.runId))
            .all()
        : [];
    const hasCompletedExecution = executionStates.some(
      (execution) => execution.status === "completed",
    );
    const hasUnresolvedExecution = executionStates.some(
      (execution) => execution.status === "unknown" && execution.reconciliation === null,
    );
    const hasOnlyFailedExecutions =
      !hasCompletedExecution && executionStates.some((execution) => execution.status === "failed");
    const event =
      hasUnresolvedExecution || hasOnlyFailedExecutions
        ? {
            approvalCount: 0,
            kind: "exception" as const,
            occurredAt: request.data.event.occurredAt,
            resultPreview: null,
            runStatus: "failed" as const,
          }
        : request.data.event;
    const occurredAt = Date.parse(event.occurredAt);

    if (occurredAt < admission.createdAt || occurredAt > Date.now() + MAXIMUM_EVENT_CLOCK_SKEW_MS) {
      return this.#deniedProjection();
    }

    const itemId = `inbox_${admission.runId}`;
    const existing = this.#database
      .select()
      .from(agentInboxItems)
      .where(eq(agentInboxItems.itemId, itemId))
      .get();

    if (existing !== undefined && existing.occurredAt >= occurredAt) {
      return recordAgentInboxRunResultSchema.parse({ ok: true, recorded: false });
    }

    const values = {
      agentId: admission.agentId,
      agentRevision: admission.agentRevision,
      approvalCount: event.approvalCount,
      cleanupAt:
        occurredAt + this.#retentionMilliseconds(admission.budgetReservation.retentionSeconds),
      fleetRevision: admission.budgetReservation.fleetConfigurationRevision,
      itemId,
      kind: event.kind,
      occurredAt,
      reason: null,
      requestPreview: preview(admission.prompt ?? ""),
      resultPreview: event.resultPreview,
      retryAt: null,
      runId: admission.runId,
      runStatus: event.runStatus,
      scheduleId: schedule?.scheduleId ?? null,
      scheduleRevision: admission.scheduleRevision,
      scheduledAt: null,
      trigger: admission.trigger,
      version: event.occurredAt,
    } as const;

    if (existing === undefined) {
      this.#database.insert(agentInboxItems).values(values).run();
    } else {
      this.#database.transaction((transaction) => {
        transaction
          .delete(agentInboxAcknowledgements)
          .where(eq(agentInboxAcknowledgements.itemId, itemId))
          .run();
        transaction
          .update(agentInboxItems)
          .set(values)
          .where(eq(agentInboxItems.itemId, itemId))
          .run();
      });
    }

    this.#cleanup(Date.now());
    this.#pruneCapacity();
    return recordAgentInboxRunResultSchema.parse({ ok: true, recorded: true });
  }

  repairFailedRun(runId: string): boolean {
    const item = this.#database
      .select({
        itemId: agentInboxItems.itemId,
      })
      .from(agentInboxItems)
      .where(
        and(
          eq(agentInboxItems.runId, runId),
          eq(agentInboxItems.kind, "outcome"),
          eq(agentInboxItems.runStatus, "completed"),
        ),
      )
      .get();

    if (item === undefined) {
      return false;
    }

    this.#database.transaction((transaction) => {
      transaction
        .delete(agentInboxAcknowledgements)
        .where(eq(agentInboxAcknowledgements.itemId, item.itemId))
        .run();
      transaction
        .update(agentInboxItems)
        .set({
          approvalCount: 0,
          kind: "exception",
          resultPreview: null,
          runStatus: "failed",
        })
        .where(eq(agentInboxItems.itemId, item.itemId))
        .run();
    });

    return true;
  }

  recordDeferral(input: {
    agentId: string;
    agentRevision: number;
    fleetRevision: number;
    occurredAt: number;
    prompt: string;
    reason: AgentInboxDeferredReason;
    retryAt: number | null;
    scheduleId: string;
    scheduleRevision: number;
    scheduledAt: number;
  }): void {
    this.#cleanup(Date.now());
    const itemId = deferredItemId(input.scheduleId);
    const existing = this.#database
      .select({ itemId: agentInboxItems.itemId })
      .from(agentInboxItems)
      .where(eq(agentInboxItems.itemId, itemId))
      .get();
    const values = {
      agentId: input.agentId,
      agentRevision: input.agentRevision,
      approvalCount: 0,
      cleanupAt: input.occurredAt + this.#retentionMilliseconds(),
      fleetRevision: input.fleetRevision,
      itemId,
      kind: "deferred",
      occurredAt: input.occurredAt,
      reason: input.reason,
      requestPreview: preview(input.prompt),
      resultPreview: null,
      retryAt: input.retryAt,
      runId: null,
      runStatus: null,
      scheduleId: input.scheduleId,
      scheduleRevision: input.scheduleRevision,
      scheduledAt: input.scheduledAt,
      trigger: null,
      version: new Date(input.occurredAt).toISOString(),
    } as const;

    this.#database.transaction((transaction) => {
      transaction
        .delete(agentInboxAcknowledgements)
        .where(eq(agentInboxAcknowledgements.itemId, itemId))
        .run();

      if (existing === undefined) {
        transaction.insert(agentInboxItems).values(values).run();
        transaction
          .insert(auditEvents)
          .values({
            action: "agent.work_deferred",
            clientId: "crewhelm:scheduler",
            occurredAt: input.occurredAt,
            subjectId: itemId,
          })
          .run();
      } else {
        transaction
          .update(agentInboxItems)
          .set(values)
          .where(eq(agentInboxItems.itemId, itemId))
          .run();
      }
    });
    this.#pruneCapacity();
  }

  clearDeferral(scheduleId: string): void {
    const itemId = deferredItemId(scheduleId);

    this.#database.transaction((transaction) => {
      transaction
        .delete(agentInboxAcknowledgements)
        .where(eq(agentInboxAcknowledgements.itemId, itemId))
        .run();
      transaction.delete(agentInboxItems).where(eq(agentInboxItems.itemId, itemId)).run();
    });
  }

  #deniedProjection(): RecordAgentInboxRunResult {
    return recordAgentInboxRunResultSchema.parse({
      error: {
        code: "invalid_admission",
        message: "Agent inbox projection denied.",
      },
      ok: false,
    });
  }

  #cleanup(currentTime: number): void {
    const itemIds = this.#database
      .select({ itemId: agentInboxItems.itemId })
      .from(agentInboxItems)
      .where(lte(agentInboxItems.cleanupAt, currentTime))
      .orderBy(agentInboxItems.cleanupAt)
      .limit(AGENT_INBOX_CLEANUP_BATCH_SIZE)
      .all()
      .map((item) => item.itemId);

    this.#deleteItems(itemIds);
  }

  #pruneCapacity(): void {
    const priority = sql<number>`CASE
      WHEN ${needsActionCondition()} THEN 2
      WHEN ${warningCondition()} THEN 1
      ELSE 0
    END`;
    const itemIds = this.#database
      .select({ itemId: agentInboxItems.itemId })
      .from(agentInboxItems)
      .orderBy(desc(priority), desc(agentInboxItems.occurredAt), desc(agentInboxItems.itemId))
      .limit(AGENT_INBOX_CLEANUP_BATCH_SIZE)
      .offset(MAXIMUM_STORED_AGENT_INBOX_ITEMS)
      .all()
      .map((item) => item.itemId);

    this.#deleteItems(itemIds);
  }

  #deleteItems(itemIds: string[]): void {
    if (itemIds.length === 0) {
      return;
    }

    this.#database.transaction((transaction) => {
      transaction
        .delete(agentInboxAcknowledgements)
        .where(inArray(agentInboxAcknowledgements.itemId, itemIds))
        .run();
      transaction.delete(agentInboxItems).where(inArray(agentInboxItems.itemId, itemIds)).run();
    });
  }

  #retentionMilliseconds(minimumSeconds = 0): number {
    return (
      Math.max(this.#currentFleetConfiguration().retention.inboxSeconds, minimumSeconds) * 1_000
    );
  }
}
