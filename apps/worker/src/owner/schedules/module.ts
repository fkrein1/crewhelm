import {
  MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT,
  MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM,
  MAXIMUM_RETAINED_AGENT_SCHEDULE_OCCURRENCES,
  agentScheduleConfigurationSchema,
  agentScheduleIdSchema,
  agentScheduleSchema,
  configureAgentScheduleInputSchema,
  configureAgentScheduleResultSchema,
  getAgentScheduleInputSchema,
  getAgentScheduleResultSchema,
  listAgentSchedulesInputSchema,
  listAgentSchedulesResultSchema,
  type AgentSchedule,
  type AgentScheduleConfiguration,
  type ConfigureAgentScheduleResult,
  type FleetConfigurationData,
  type GetAgentScheduleResult,
  type ListAgentSchedulesResult,
  type OwnerAuthority,
  type OutputContract,
} from "@crewhelm/contracts";
import { and, asc, count, desc, eq, lte, max, min, ne, notExists, notInArray } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentInboxItems,
  agentEventTriggers,
  agentScheduleOccurrences,
  agentScheduleRevisions,
  agentSchedules,
  agentScheduleUpdates,
  agents,
  auditEvents,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import {
  minimumAgentScheduleIntervalSeconds,
  nextAgentScheduleOccurrence,
  nextAgentScheduleOccurrenceAfterClaim,
} from "./recurrence.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type ScheduleFailure = Extract<ConfigureAgentScheduleResult, { ok: false }>;
type ScheduleRevisionRow = {
  agentId: string;
  agentRevision: number;
  configuration: AgentSchedule["configuration"];
  createdAt: number;
  name: string;
  revision: number;
  scheduleId: string;
};
type ScheduleStateRow = {
  createdAt: number;
  currentRevision: number;
  lastDispatchedAt: number | null;
  lastRunId: string | null;
  nextRunAt: number | null;
  scheduleId: string;
  status: "active" | "deleted" | "paused";
};

export type DueAgentSchedule = {
  agentId: string;
  agentRevision: number;
  lastRunId: string | null;
  name: string;
  outputContract: OutputContract | undefined;
  prompt: string;
  retryAt: number;
  scheduleId: string;
  scheduleRevision: number;
  scheduledAt: number;
};

const SCHEDULE_OCCURRENCE_RECOVERY_DELAY_MS = 60_000;
const MAXIMUM_SCHEDULE_OCCURRENCE_ATTEMPTS = 5;

function pruneOccurrenceHistory(transaction: DatabaseTransaction, scheduleId: string): void {
  const stale = transaction
    .select({
      scheduleRevision: agentScheduleOccurrences.scheduleRevision,
      scheduledAt: agentScheduleOccurrences.scheduledAt,
    })
    .from(agentScheduleOccurrences)
    .where(
      and(
        eq(agentScheduleOccurrences.scheduleId, scheduleId),
        ne(agentScheduleOccurrences.status, "pending"),
      ),
    )
    .orderBy(
      desc(agentScheduleOccurrences.occurredAt),
      desc(agentScheduleOccurrences.scheduledAt),
      desc(agentScheduleOccurrences.scheduleRevision),
    )
    .limit(MAXIMUM_RETAINED_AGENT_SCHEDULE_OCCURRENCES)
    .offset(MAXIMUM_RETAINED_AGENT_SCHEDULE_OCCURRENCES)
    .all();

  for (const occurrence of stale) {
    transaction
      .delete(agentScheduleOccurrences)
      .where(
        and(
          eq(agentScheduleOccurrences.scheduleId, scheduleId),
          eq(agentScheduleOccurrences.scheduleRevision, occurrence.scheduleRevision),
          eq(agentScheduleOccurrences.scheduledAt, occurrence.scheduledAt),
        ),
      )
      .run();
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestRequest(input: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input))),
  );

  return encodeBase64Url(bytes);
}

function newScheduleId(): string {
  return agentScheduleIdSchema.parse(`schedule_${crypto.randomUUID()}`);
}

function activeDefinition(
  input: Exclude<ReturnType<typeof configureAgentScheduleInputSchema.parse>["schedule"], null>,
): { configuration: AgentScheduleConfiguration; name: string | null } {
  return "name" in input
    ? {
        configuration: {
          ...(input.outputContract === undefined ? {} : { outputContract: input.outputContract }),
          prompt: input.prompt,
          trigger: input.trigger,
        },
        name: input.name,
      }
    : { configuration: input, name: null };
}

export function deniedAgentSchedule(code: ScheduleFailure["error"]["code"]): ScheduleFailure {
  return {
    error: {
      code,
      message: "Agent schedule request denied.",
    },
    ok: false,
  };
}

export class AgentSchedules {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: Database;
  readonly #storage: DurableObjectStorage;

  constructor(
    database: Database,
    storage: DurableObjectStorage,
    currentFleetConfiguration: () => FleetConfigurationData,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#storage = storage;
  }

  async configure(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ConfigureAgentScheduleResult> {
    const request = configureAgentScheduleInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentSchedule("invalid_request");
    }

    const configuredAt = Date.now();
    const definition =
      request.data.schedule === null ? null : activeDefinition(request.data.schedule);
    const minimumInterval =
      definition === null
        ? null
        : minimumAgentScheduleIntervalSeconds(definition.configuration, configuredAt);
    const nextOccurrence =
      definition === null
        ? null
        : nextAgentScheduleOccurrence(definition.configuration, configuredAt);

    if (
      definition !== null &&
      (minimumInterval === null ||
        nextOccurrence === null ||
        minimumInterval < this.#currentFleetConfiguration().schedules.minimumIntervalSeconds)
    ) {
      return deniedAgentSchedule("invalid_request");
    }

    const requestDigest = await digestRequest(request.data);
    const result = this.#database.transaction((transaction) => {
      const replay = transaction
        .select({
          agentId: agentScheduleRevisions.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          configuration: agentScheduleRevisions.configuration,
          createdAt: agentScheduleRevisions.createdAt,
          name: agentScheduleRevisions.name,
          requestDigest: agentScheduleUpdates.requestDigest,
          revision: agentScheduleRevisions.revision,
          scheduleId: agentScheduleRevisions.scheduleId,
        })
        .from(agentScheduleUpdates)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.agentId, agentScheduleUpdates.agentId),
            eq(agentScheduleRevisions.revision, agentScheduleUpdates.revision),
          ),
        )
        .where(
          and(
            eq(agentScheduleUpdates.clientId, authority.clientId),
            eq(agentScheduleUpdates.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .get();

      if (replay !== undefined) {
        if (replay.requestDigest !== requestDigest || replay.agentId !== request.data.agentId) {
          return deniedAgentSchedule("idempotency_conflict");
        }

        const current = transaction
          .select()
          .from(agentSchedules)
          .where(eq(agentSchedules.scheduleId, replay.scheduleId))
          .get();

        if (current?.status === "deleted") {
          return deniedAgentSchedule("schedule_not_found");
        }

        return configureAgentScheduleResultSchema.parse({
          configured: false,
          ok: true,
          schedule: this.#fromRows(replay, current),
        });
      }

      const agent = transaction
        .select({
          currentRevision: agents.currentRevision,
          status: agents.status,
        })
        .from(agents)
        .where(eq(agents.agentId, request.data.agentId))
        .get();

      if (agent === undefined) {
        return deniedAgentSchedule("agent_not_found");
      }

      if (agent.status !== "active") {
        return deniedAgentSchedule("agent_unavailable");
      }

      if (agent.currentRevision !== request.data.expectedAgentRevision) {
        return deniedAgentSchedule("revision_conflict");
      }

      const schedules = transaction
        .select({
          agentId: agentSchedules.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          configuration: agentScheduleRevisions.configuration,
          createdAt: agentSchedules.createdAt,
          currentRevision: agentSchedules.currentRevision,
          lastDispatchedAt: agentSchedules.lastDispatchedAt,
          lastRunId: agentSchedules.lastRunId,
          name: agentScheduleRevisions.name,
          nextRunAt: agentSchedules.nextRunAt,
          scheduleId: agentSchedules.scheduleId,
          status: agentSchedules.status,
        })
        .from(agentSchedules)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.scheduleId, agentSchedules.scheduleId),
            eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
            eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
          ),
        )
        .where(
          and(
            eq(agentSchedules.agentId, request.data.agentId),
            ne(agentSchedules.status, "deleted"),
          ),
        )
        .orderBy(asc(agentSchedules.scheduleId))
        .all();
      const current =
        typeof request.data.scheduleId === "string"
          ? schedules.find((schedule) => schedule.scheduleId === request.data.scheduleId)
          : request.data.scheduleId === null
            ? undefined
            : schedules.length === 1
              ? schedules[0]
              : undefined;

      if (request.data.scheduleId === undefined && schedules.length > 1) {
        return deniedAgentSchedule("schedule_selection_required");
      }

      if (
        (typeof request.data.scheduleId === "string" ||
          request.data.expectedScheduleRevision !== null) &&
        current === undefined
      ) {
        return deniedAgentSchedule("schedule_not_found");
      }

      if (
        current !== undefined &&
        current.currentRevision !== request.data.expectedScheduleRevision
      ) {
        return deniedAgentSchedule("revision_conflict");
      }

      if (
        current !== undefined &&
        transaction
          .select({ scheduleId: agentScheduleOccurrences.scheduleId })
          .from(agentScheduleOccurrences)
          .where(
            and(
              eq(agentScheduleOccurrences.scheduleId, current.scheduleId),
              eq(agentScheduleOccurrences.status, "pending"),
            ),
          )
          .limit(1)
          .get() !== undefined
      ) {
        return deniedAgentSchedule("schedule_busy");
      }

      const eventTriggerCount =
        transaction
          .select({ value: count() })
          .from(agentEventTriggers)
          .where(
            and(
              eq(agentEventTriggers.agentId, request.data.agentId),
              ne(agentEventTriggers.status, "deleted"),
            ),
          )
          .get()?.value ?? 0;

      if (
        current === undefined &&
        schedules.length + eventTriggerCount >= MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT
      ) {
        return deniedAgentSchedule("schedule_limit_exceeded");
      }

      const name =
        request.data.schedule === null
          ? current?.name
          : (definition?.name ?? current?.name ?? "Recurring schedule");
      const configuration = definition?.configuration ?? null;

      if (name === undefined) {
        return deniedAgentSchedule("schedule_not_found");
      }

      if (
        current !== undefined &&
        current.agentRevision === request.data.expectedAgentRevision &&
        current.name === name &&
        JSON.stringify(current.configuration) === JSON.stringify(configuration)
      ) {
        return deniedAgentSchedule("no_changes");
      }

      const revision =
        (transaction
          .select({ value: max(agentScheduleRevisions.revision) })
          .from(agentScheduleRevisions)
          .where(eq(agentScheduleRevisions.agentId, request.data.agentId))
          .get()?.value ?? 0) + 1;
      const scheduleId = current?.scheduleId ?? newScheduleId();

      transaction
        .insert(agentScheduleRevisions)
        .values({
          agentId: request.data.agentId,
          agentRevision: request.data.expectedAgentRevision,
          configuration,
          createdAt: configuredAt,
          name,
          revision,
          scheduleId,
        })
        .run();
      transaction
        .insert(agentSchedules)
        .values({
          agentId: request.data.agentId,
          createdAt: current?.createdAt ?? configuredAt,
          currentRevision: revision,
          lastDispatchedAt: current?.lastDispatchedAt ?? null,
          lastRunId: current?.lastRunId ?? null,
          nextRunAt: configuration === null ? null : nextOccurrence,
          scheduleId,
          status: configuration === null ? "paused" : "active",
        })
        .onConflictDoUpdate({
          target: agentSchedules.scheduleId,
          set: {
            currentRevision: revision,
            nextRunAt: configuration === null ? null : nextOccurrence,
            status: configuration === null ? "paused" : "active",
          },
        })
        .run();
      transaction
        .insert(agentScheduleUpdates)
        .values({
          agentId: request.data.agentId,
          clientId: authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: configuration === null ? "agent.schedule_paused" : "agent.schedule_configured",
          clientId: authority.clientId,
          occurredAt: configuredAt,
          subjectId: scheduleId,
        })
        .run();

      return configureAgentScheduleResultSchema.parse({
        configured: true,
        ok: true,
        schedule: {
          agentId: request.data.agentId,
          agentRevision: request.data.expectedAgentRevision,
          configuration,
          createdAt: new Date(current?.createdAt ?? configuredAt).toISOString(),
          id: scheduleId,
          lastDispatchedAt:
            current?.lastDispatchedAt === null || current?.lastDispatchedAt === undefined
              ? null
              : new Date(current.lastDispatchedAt).toISOString(),
          lastAttempt: null,
          lastRunId: current?.lastRunId ?? null,
          name,
          nextRunAt:
            configuration === null || nextOccurrence === null
              ? null
              : new Date(nextOccurrence).toISOString(),
          revision,
          status: configuration === null ? "paused" : "active",
        },
      });
    });

    if (result.ok && result.schedule.nextRunAt !== null) {
      await this.#scheduleAlarm(Date.parse(result.schedule.nextRunAt));
    }

    return result;
  }

  get(input: unknown): GetAgentScheduleResult {
    const request = getAgentScheduleInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentSchedule("invalid_request");
    }

    const rows = this.#currentRows(request.data.agentId).filter(
      (row) => request.data.scheduleId === undefined || row.scheduleId === request.data.scheduleId,
    );

    if (rows.length === 0) {
      return deniedAgentSchedule("schedule_not_found");
    }

    if (rows.length > 1) {
      return deniedAgentSchedule("schedule_selection_required");
    }

    const row = rows[0];

    return row === undefined
      ? deniedAgentSchedule("schedule_not_found")
      : getAgentScheduleResultSchema.parse({
          ok: true,
          schedule: this.#fromRows(row, row),
        });
  }

  list(input: unknown): ListAgentSchedulesResult {
    const request = listAgentSchedulesInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentSchedule("invalid_request");
    }

    const agent = this.#database
      .select({ id: agents.agentId })
      .from(agents)
      .where(eq(agents.agentId, request.data.agentId))
      .get();

    return agent === undefined
      ? deniedAgentSchedule("agent_not_found")
      : listAgentSchedulesResultSchema.parse({
          ok: true,
          schedules: this.#currentRows(request.data.agentId).map((row) => this.#fromRows(row, row)),
        });
  }

  claimDue(currentTime: number): DueAgentSchedule[] {
    return this.#database.transaction((transaction) => {
      const due: DueAgentSchedule[] = [];
      const handledScheduleIds = new Set<string>();
      const recoverable = transaction
        .select({
          agentId: agentScheduleOccurrences.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          attempts: agentScheduleOccurrences.attempts,
          configuration: agentScheduleRevisions.configuration,
          lastRunId: agentSchedules.lastRunId,
          name: agentScheduleRevisions.name,
          scheduledAt: agentScheduleOccurrences.scheduledAt,
          scheduleId: agentScheduleOccurrences.scheduleId,
          scheduleRevision: agentScheduleOccurrences.scheduleRevision,
        })
        .from(agentScheduleOccurrences)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.scheduleId, agentScheduleOccurrences.scheduleId),
            eq(agentScheduleRevisions.agentId, agentScheduleOccurrences.agentId),
            eq(agentScheduleRevisions.revision, agentScheduleOccurrences.scheduleRevision),
          ),
        )
        .innerJoin(
          agentSchedules,
          and(
            eq(agentSchedules.scheduleId, agentScheduleOccurrences.scheduleId),
            eq(agentSchedules.currentRevision, agentScheduleOccurrences.scheduleRevision),
            eq(agentSchedules.status, "active"),
          ),
        )
        .where(
          and(
            eq(agentScheduleOccurrences.status, "pending"),
            lte(agentScheduleOccurrences.nextAttemptAt, currentTime),
          ),
        )
        .orderBy(asc(agentScheduleOccurrences.nextAttemptAt))
        .limit(MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM)
        .all();

      for (const row of recoverable) {
        if (handledScheduleIds.has(row.scheduleId)) continue;
        handledScheduleIds.add(row.scheduleId);
        const configuration = agentScheduleConfigurationSchema.safeParse(row.configuration);

        if (!configuration.success || row.attempts >= MAXIMUM_SCHEDULE_OCCURRENCE_ATTEMPTS) {
          transaction
            .update(agentScheduleOccurrences)
            .set({
              nextAttemptAt: null,
              reason: configuration.success ? "dispatch_exception" : "agent_changed",
              status: "skipped",
            })
            .where(
              and(
                eq(agentScheduleOccurrences.scheduleId, row.scheduleId),
                eq(agentScheduleOccurrences.scheduleRevision, row.scheduleRevision),
                eq(agentScheduleOccurrences.scheduledAt, row.scheduledAt),
                eq(agentScheduleOccurrences.status, "pending"),
              ),
            )
            .run();
          pruneOccurrenceHistory(transaction, row.scheduleId);
          continue;
        }

        transaction
          .update(agentScheduleOccurrences)
          .set({
            attempts: row.attempts + 1,
            nextAttemptAt: currentTime + SCHEDULE_OCCURRENCE_RECOVERY_DELAY_MS,
          })
          .where(
            and(
              eq(agentScheduleOccurrences.scheduleId, row.scheduleId),
              eq(agentScheduleOccurrences.scheduleRevision, row.scheduleRevision),
              eq(agentScheduleOccurrences.scheduledAt, row.scheduledAt),
              eq(agentScheduleOccurrences.status, "pending"),
            ),
          )
          .run();
        due.push({
          agentId: row.agentId,
          agentRevision: row.agentRevision,
          lastRunId: row.lastRunId,
          name: row.name,
          outputContract:
            "outputContract" in configuration.data ? configuration.data.outputContract : undefined,
          prompt: configuration.data.prompt,
          retryAt: currentTime + SCHEDULE_OCCURRENCE_RECOVERY_DELAY_MS,
          scheduleId: row.scheduleId,
          scheduleRevision: row.scheduleRevision,
          scheduledAt: row.scheduledAt,
        });
      }

      const rows = transaction
        .select({
          agentId: agentSchedules.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          agentStatus: agents.status,
          configuration: agentScheduleRevisions.configuration,
          currentAgentRevision: agents.currentRevision,
          lastRunId: agentSchedules.lastRunId,
          name: agentScheduleRevisions.name,
          nextRunAt: agentSchedules.nextRunAt,
          scheduleId: agentSchedules.scheduleId,
          scheduleRevision: agentSchedules.currentRevision,
        })
        .from(agentSchedules)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.scheduleId, agentSchedules.scheduleId),
            eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
            eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
          ),
        )
        .innerJoin(agents, eq(agents.agentId, agentSchedules.agentId))
        .where(
          and(
            eq(agentSchedules.status, "active"),
            lte(agentSchedules.nextRunAt, currentTime),
            handledScheduleIds.size === 0
              ? undefined
              : notInArray(agentSchedules.scheduleId, [...handledScheduleIds]),
            notExists(
              transaction
                .select({ scheduleId: agentScheduleOccurrences.scheduleId })
                .from(agentScheduleOccurrences)
                .where(
                  and(
                    eq(agentScheduleOccurrences.scheduleId, agentSchedules.scheduleId),
                    eq(agentScheduleOccurrences.status, "pending"),
                  ),
                ),
            ),
          ),
        )
        .limit(Math.max(0, MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM - due.length))
        .all();

      for (const row of rows) {
        const configuration = agentScheduleConfigurationSchema.safeParse(row.configuration);
        const nextRunAt =
          configuration.success && row.nextRunAt !== null
            ? nextAgentScheduleOccurrenceAfterClaim(configuration.data, row.nextRunAt, currentTime)
            : null;

        if (
          !configuration.success ||
          row.nextRunAt === null ||
          nextRunAt === null ||
          row.agentStatus !== "active" ||
          row.currentAgentRevision !== row.agentRevision
        ) {
          transaction
            .update(agentSchedules)
            .set({ nextRunAt: null, status: "paused" })
            .where(
              and(
                eq(agentSchedules.scheduleId, row.scheduleId),
                eq(agentSchedules.currentRevision, row.scheduleRevision),
              ),
            )
            .run();
          transaction
            .insert(auditEvents)
            .values({
              action: "agent.schedule_paused_stale",
              clientId: "crewhelm:scheduler",
              occurredAt: currentTime,
              subjectId: row.scheduleId,
            })
            .run();
          continue;
        }

        const claimed = transaction
          .update(agentSchedules)
          .set({ nextRunAt })
          .where(
            and(
              eq(agentSchedules.scheduleId, row.scheduleId),
              eq(agentSchedules.currentRevision, row.scheduleRevision),
              eq(agentSchedules.nextRunAt, row.nextRunAt),
            ),
          )
          .returning({ scheduleId: agentSchedules.scheduleId })
          .all();

        if (claimed.length === 1) {
          transaction
            .insert(agentScheduleOccurrences)
            .values({
              agentId: row.agentId,
              attempts: 1,
              nextAttemptAt: currentTime + SCHEDULE_OCCURRENCE_RECOVERY_DELAY_MS,
              occurredAt: currentTime,
              reason: null,
              runId: null,
              scheduledAt: row.nextRunAt,
              scheduleId: row.scheduleId,
              scheduleRevision: row.scheduleRevision,
              status: "pending",
            })
            .onConflictDoNothing()
            .run();
          due.push({
            agentId: row.agentId,
            agentRevision: row.agentRevision,
            lastRunId: row.lastRunId,
            name: row.name,
            outputContract:
              "outputContract" in configuration.data
                ? configuration.data.outputContract
                : undefined,
            prompt: configuration.data.prompt,
            retryAt: nextRunAt,
            scheduleId: row.scheduleId,
            scheduleRevision: row.scheduleRevision,
            scheduledAt: row.nextRunAt,
          });
        }
      }

      return due;
    });
  }

  recordDispatch(input: {
    dispatchedAt: number;
    runId: string;
    scheduleId: string;
    scheduleRevision: number;
    scheduledAt: number;
  }): boolean {
    return this.#database.transaction((transaction) => {
      const pending = transaction
        .select({ scheduleId: agentScheduleOccurrences.scheduleId })
        .from(agentScheduleOccurrences)
        .where(
          and(
            eq(agentScheduleOccurrences.scheduleId, input.scheduleId),
            eq(agentScheduleOccurrences.scheduleRevision, input.scheduleRevision),
            eq(agentScheduleOccurrences.scheduledAt, input.scheduledAt),
            eq(agentScheduleOccurrences.status, "pending"),
          ),
        )
        .get();

      if (pending === undefined) {
        return false;
      }

      const updated = transaction
        .update(agentSchedules)
        .set({
          lastDispatchedAt: input.dispatchedAt,
          lastRunId: input.runId,
        })
        .where(
          and(
            eq(agentSchedules.scheduleId, input.scheduleId),
            eq(agentSchedules.currentRevision, input.scheduleRevision),
            eq(agentSchedules.status, "active"),
          ),
        )
        .returning({ scheduleId: agentSchedules.scheduleId })
        .all();

      if (updated.length !== 1) {
        return false;
      }

      const occurrence = transaction
        .update(agentScheduleOccurrences)
        .set({
          nextAttemptAt: null,
          reason: null,
          runId: input.runId,
          status: "dispatched",
        })
        .where(
          and(
            eq(agentScheduleOccurrences.scheduleId, input.scheduleId),
            eq(agentScheduleOccurrences.scheduleRevision, input.scheduleRevision),
            eq(agentScheduleOccurrences.scheduledAt, input.scheduledAt),
            eq(agentScheduleOccurrences.status, "pending"),
          ),
        )
        .returning({ scheduleId: agentScheduleOccurrences.scheduleId })
        .all();

      if (occurrence.length !== 1) {
        return false;
      }

      pruneOccurrenceHistory(transaction, input.scheduleId);

      transaction
        .insert(auditEvents)
        .values({
          action: "agent.schedule_dispatched",
          clientId: "crewhelm:scheduler",
          occurredAt: input.dispatchedAt,
          subjectId: input.runId,
        })
        .run();
      return true;
    });
  }

  recordSkipped(
    schedule: Pick<DueAgentSchedule, "scheduleId" | "scheduleRevision" | "scheduledAt">,
    currentTime: number,
    reason:
      | "active_run"
      | "agent_unavailable"
      | "dispatch_exception"
      | "record_dispatch_conflict"
      | "run_unavailable",
  ): void {
    this.#database.transaction((transaction) => {
      transaction
        .update(agentScheduleOccurrences)
        .set({ nextAttemptAt: null, reason, status: "skipped" })
        .where(
          and(
            eq(agentScheduleOccurrences.scheduleId, schedule.scheduleId),
            eq(agentScheduleOccurrences.scheduleRevision, schedule.scheduleRevision),
            eq(agentScheduleOccurrences.scheduledAt, schedule.scheduledAt),
            eq(agentScheduleOccurrences.status, "pending"),
          ),
        )
        .run();
      pruneOccurrenceHistory(transaction, schedule.scheduleId);
      transaction
        .insert(auditEvents)
        .values({
          action: `agent.schedule_skipped_${reason}`,
          clientId: "crewhelm:scheduler",
          occurredAt: currentTime,
          subjectId: schedule.scheduleId,
        })
        .run();
    });
  }

  recordPendingRetry(
    schedule: Pick<DueAgentSchedule, "scheduleId">,
    currentTime: number,
    reason: "dispatch_exception",
  ): void {
    this.#database
      .insert(auditEvents)
      .values({
        action: `agent.schedule_retry_${reason}`,
        clientId: "crewhelm:scheduler",
        occurredAt: currentTime,
        subjectId: schedule.scheduleId,
      })
      .run();
  }

  nextAlarmAt(): number | null {
    const nextSchedule =
      this.#database
        .select({ value: min(agentSchedules.nextRunAt) })
        .from(agentSchedules)
        .where(eq(agentSchedules.status, "active"))
        .get()?.value ?? null;
    const nextRecovery =
      this.#database
        .select({ value: min(agentScheduleOccurrences.nextAttemptAt) })
        .from(agentScheduleOccurrences)
        .where(eq(agentScheduleOccurrences.status, "pending"))
        .get()?.value ?? null;

    return (
      [nextSchedule, nextRecovery]
        .filter((candidate): candidate is number => candidate !== null)
        .toSorted((left, right) => left - right)[0] ?? null
    );
  }

  #currentRows(agentId: string) {
    return this.#database
      .select({
        agentId: agentSchedules.agentId,
        agentRevision: agentScheduleRevisions.agentRevision,
        configuration: agentScheduleRevisions.configuration,
        createdAt: agentSchedules.createdAt,
        currentRevision: agentSchedules.currentRevision,
        lastDispatchedAt: agentSchedules.lastDispatchedAt,
        lastRunId: agentSchedules.lastRunId,
        name: agentScheduleRevisions.name,
        nextRunAt: agentSchedules.nextRunAt,
        revision: agentScheduleRevisions.revision,
        scheduleId: agentSchedules.scheduleId,
        status: agentSchedules.status,
      })
      .from(agentSchedules)
      .innerJoin(
        agentScheduleRevisions,
        and(
          eq(agentScheduleRevisions.scheduleId, agentSchedules.scheduleId),
          eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
          eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
        ),
      )
      .where(and(eq(agentSchedules.agentId, agentId), ne(agentSchedules.status, "deleted")))
      .orderBy(asc(agentSchedules.createdAt), asc(agentSchedules.scheduleId))
      .all();
  }

  #fromRows(revision: ScheduleRevisionRow, state: ScheduleStateRow | undefined): AgentSchedule {
    const isCurrent =
      state?.scheduleId === revision.scheduleId && state.currentRevision === revision.revision;
    const deferred = isCurrent
      ? this.#database
          .select({
            occurredAt: agentInboxItems.occurredAt,
            reason: agentInboxItems.reason,
            retryAt: agentInboxItems.retryAt,
          })
          .from(agentInboxItems)
          .where(
            and(
              eq(agentInboxItems.agentId, revision.agentId),
              eq(agentInboxItems.kind, "deferred"),
              eq(agentInboxItems.scheduleRevision, revision.revision),
            ),
          )
          .orderBy(desc(agentInboxItems.occurredAt))
          .limit(1)
          .get()
      : undefined;
    const lastDispatchedAt = isCurrent && state !== undefined ? state.lastDispatchedAt : null;
    const lastAttempt =
      deferred !== undefined &&
      (lastDispatchedAt === null || deferred.occurredAt > lastDispatchedAt)
        ? {
            occurredAt: new Date(deferred.occurredAt).toISOString(),
            outcome: "deferred" as const,
            reason: deferred.reason,
            retryAt: deferred.retryAt === null ? null : new Date(deferred.retryAt).toISOString(),
            runId: null,
          }
        : lastDispatchedAt === null
          ? null
          : {
              occurredAt: new Date(lastDispatchedAt).toISOString(),
              outcome: "dispatched" as const,
              reason: null,
              retryAt: null,
              runId: state?.lastRunId ?? null,
            };

    return agentScheduleSchema.parse({
      agentId: revision.agentId,
      agentRevision: revision.agentRevision,
      configuration: revision.configuration,
      createdAt: new Date(state?.createdAt ?? revision.createdAt).toISOString(),
      id: revision.scheduleId,
      lastDispatchedAt:
        !isCurrent || state.lastDispatchedAt === null
          ? null
          : new Date(state.lastDispatchedAt).toISOString(),
      lastAttempt,
      lastRunId: isCurrent ? state.lastRunId : null,
      name: revision.name,
      nextRunAt:
        !isCurrent || state.nextRunAt === null ? null : new Date(state.nextRunAt).toISOString(),
      revision: revision.revision,
      status: isCurrent ? state.status : revision.configuration === null ? "paused" : "active",
    });
  }

  async #scheduleAlarm(scheduleAt: number): Promise<void> {
    const current = await this.#storage.getAlarm();

    if (current === null || scheduleAt < current) {
      await this.#storage.setAlarm(scheduleAt);
    }
  }
}
