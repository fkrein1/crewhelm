import {
  MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM,
  agentScheduleConfigurationSchema,
  agentScheduleSchema,
  configureAgentScheduleInputSchema,
  configureAgentScheduleResultSchema,
  getAgentScheduleInputSchema,
  getAgentScheduleResultSchema,
  type AgentSchedule,
  type ConfigureAgentScheduleResult,
  type FleetConfigurationData,
  type GetAgentScheduleResult,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { and, eq, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentScheduleRevisions,
  agentSchedules,
  agentScheduleUpdates,
  agents,
  auditEvents,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ScheduleFailure = Extract<ConfigureAgentScheduleResult, { ok: false }>;

export type DueAgentSchedule = {
  agentId: string;
  agentRevision: number;
  intervalSeconds: number;
  lastRunId: string | null;
  prompt: string;
  retryAt: number;
  scheduleRevision: number;
  scheduledAt: number;
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestRequest(input: {
  agentId: string;
  expectedAgentRevision: number;
  expectedScheduleRevision: number | null;
  schedule: { intervalSeconds: number; prompt: string } | null;
}): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input))),
  );

  return encodeBase64Url(bytes);
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

    if (
      request.data.schedule !== null &&
      request.data.schedule.intervalSeconds <
        this.#currentFleetConfiguration().schedules.minimumIntervalSeconds
    ) {
      return deniedAgentSchedule("invalid_request");
    }

    const requestDigest = await digestRequest(request.data);
    const configuredAt = Date.now();
    const result = this.#database.transaction((transaction) => {
      const replay = transaction
        .select({
          agentId: agentScheduleRevisions.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          configuration: agentScheduleRevisions.configuration,
          createdAt: agentScheduleRevisions.createdAt,
          requestDigest: agentScheduleUpdates.requestDigest,
          revision: agentScheduleRevisions.revision,
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
          .where(eq(agentSchedules.agentId, replay.agentId))
          .get();

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

      const current = transaction
        .select({
          agentId: agentSchedules.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          configuration: agentScheduleRevisions.configuration,
          createdAt: agentSchedules.createdAt,
          currentRevision: agentSchedules.currentRevision,
          lastDispatchedAt: agentSchedules.lastDispatchedAt,
          lastRunId: agentSchedules.lastRunId,
          nextRunAt: agentSchedules.nextRunAt,
          status: agentSchedules.status,
        })
        .from(agentSchedules)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
            eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
          ),
        )
        .where(eq(agentSchedules.agentId, request.data.agentId))
        .get();

      if (current === undefined && request.data.expectedScheduleRevision !== null) {
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
        current.agentRevision === request.data.expectedAgentRevision &&
        JSON.stringify(current.configuration) === JSON.stringify(request.data.schedule)
      ) {
        return deniedAgentSchedule("no_changes");
      }

      const revision = (current?.currentRevision ?? 0) + 1;
      const nextRunAt =
        request.data.schedule === null
          ? null
          : configuredAt + request.data.schedule.intervalSeconds * 1_000;

      transaction
        .insert(agentScheduleRevisions)
        .values({
          agentId: request.data.agentId,
          agentRevision: request.data.expectedAgentRevision,
          configuration: request.data.schedule,
          createdAt: configuredAt,
          revision,
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
          nextRunAt,
          status: request.data.schedule === null ? "paused" : "active",
        })
        .onConflictDoUpdate({
          target: agentSchedules.agentId,
          set: {
            currentRevision: revision,
            nextRunAt,
            status: request.data.schedule === null ? "paused" : "active",
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
          action:
            request.data.schedule === null ? "agent.schedule_paused" : "agent.schedule_configured",
          clientId: authority.clientId,
          occurredAt: configuredAt,
          subjectId: request.data.agentId,
        })
        .run();

      return configureAgentScheduleResultSchema.parse({
        configured: true,
        ok: true,
        schedule: {
          agentId: request.data.agentId,
          agentRevision: request.data.expectedAgentRevision,
          configuration: request.data.schedule,
          createdAt: new Date(current?.createdAt ?? configuredAt).toISOString(),
          lastDispatchedAt:
            current?.lastDispatchedAt === null || current?.lastDispatchedAt === undefined
              ? null
              : new Date(current.lastDispatchedAt).toISOString(),
          lastRunId: current?.lastRunId ?? null,
          nextRunAt: nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
          revision,
          status: request.data.schedule === null ? "paused" : "active",
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

    const row = this.#database
      .select({
        agentId: agentSchedules.agentId,
        agentRevision: agentScheduleRevisions.agentRevision,
        configuration: agentScheduleRevisions.configuration,
        createdAt: agentSchedules.createdAt,
        currentRevision: agentSchedules.currentRevision,
        lastDispatchedAt: agentSchedules.lastDispatchedAt,
        lastRunId: agentSchedules.lastRunId,
        nextRunAt: agentSchedules.nextRunAt,
        status: agentSchedules.status,
      })
      .from(agentSchedules)
      .innerJoin(
        agentScheduleRevisions,
        and(
          eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
          eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
        ),
      )
      .where(eq(agentSchedules.agentId, request.data.agentId))
      .get();

    return row === undefined
      ? deniedAgentSchedule("schedule_not_found")
      : getAgentScheduleResultSchema.parse({
          ok: true,
          schedule: this.#fromRows(
            {
              agentId: row.agentId,
              agentRevision: row.agentRevision,
              configuration: row.configuration,
              createdAt: row.createdAt,
              revision: row.currentRevision,
            },
            row,
          ),
        });
  }

  claimDue(currentTime: number): DueAgentSchedule[] {
    return this.#database.transaction((transaction) => {
      const rows = transaction
        .select({
          agentId: agentSchedules.agentId,
          agentRevision: agentScheduleRevisions.agentRevision,
          agentStatus: agents.status,
          configuration: agentScheduleRevisions.configuration,
          currentAgentRevision: agents.currentRevision,
          lastRunId: agentSchedules.lastRunId,
          nextRunAt: agentSchedules.nextRunAt,
          scheduleRevision: agentSchedules.currentRevision,
        })
        .from(agentSchedules)
        .innerJoin(
          agentScheduleRevisions,
          and(
            eq(agentScheduleRevisions.agentId, agentSchedules.agentId),
            eq(agentScheduleRevisions.revision, agentSchedules.currentRevision),
          ),
        )
        .innerJoin(agents, eq(agents.agentId, agentSchedules.agentId))
        .where(and(eq(agentSchedules.status, "active"), lte(agentSchedules.nextRunAt, currentTime)))
        .limit(MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM)
        .all();
      const due: DueAgentSchedule[] = [];

      for (const row of rows) {
        const configuration = agentScheduleConfigurationSchema.safeParse(row.configuration);

        if (
          !configuration.success ||
          row.nextRunAt === null ||
          row.agentStatus !== "active" ||
          row.currentAgentRevision !== row.agentRevision
        ) {
          transaction
            .update(agentSchedules)
            .set({ nextRunAt: null, status: "paused" })
            .where(
              and(
                eq(agentSchedules.agentId, row.agentId),
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
              subjectId: row.agentId,
            })
            .run();
          continue;
        }

        const intervalMs = configuration.data.intervalSeconds * 1_000;
        const intervalsElapsed = Math.floor(Math.max(0, currentTime - row.nextRunAt) / intervalMs);
        const nextRunAt = row.nextRunAt + (intervalsElapsed + 1) * intervalMs;
        const claimed = transaction
          .update(agentSchedules)
          .set({ nextRunAt })
          .where(
            and(
              eq(agentSchedules.agentId, row.agentId),
              eq(agentSchedules.currentRevision, row.scheduleRevision),
              eq(agentSchedules.nextRunAt, row.nextRunAt),
            ),
          )
          .returning({ agentId: agentSchedules.agentId })
          .all();

        if (claimed.length === 1) {
          due.push({
            agentId: row.agentId,
            agentRevision: row.agentRevision,
            intervalSeconds: configuration.data.intervalSeconds,
            lastRunId: row.lastRunId,
            prompt: configuration.data.prompt,
            retryAt: nextRunAt,
            scheduleRevision: row.scheduleRevision,
            scheduledAt: row.nextRunAt,
          });
        }
      }

      return due;
    });
  }

  recordDispatch(input: {
    agentId: string;
    dispatchedAt: number;
    runId: string;
    scheduleRevision: number;
  }): boolean {
    return this.#database.transaction((transaction) => {
      const updated = transaction
        .update(agentSchedules)
        .set({
          lastDispatchedAt: input.dispatchedAt,
          lastRunId: input.runId,
        })
        .where(
          and(
            eq(agentSchedules.agentId, input.agentId),
            eq(agentSchedules.currentRevision, input.scheduleRevision),
            eq(agentSchedules.status, "active"),
          ),
        )
        .returning({ agentId: agentSchedules.agentId })
        .all();

      if (updated.length !== 1) {
        return false;
      }

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

  recordSkipped(agentId: string, currentTime: number, reason: "active_run" | "unavailable"): void {
    this.#database
      .insert(auditEvents)
      .values({
        action: `agent.schedule_skipped_${reason}`,
        clientId: "crewhelm:scheduler",
        occurredAt: currentTime,
        subjectId: agentId,
      })
      .run();
  }

  nextAlarmAt(): number | null {
    return (
      this.#database
        .select({ value: min(agentSchedules.nextRunAt) })
        .from(agentSchedules)
        .where(eq(agentSchedules.status, "active"))
        .get()?.value ?? null
    );
  }

  #fromRows(
    revision: {
      agentId: string;
      agentRevision: number;
      configuration: AgentSchedule["configuration"];
      createdAt: number;
      revision: number;
    },
    state:
      | {
          currentRevision: number;
          lastDispatchedAt: number | null;
          lastRunId: string | null;
          nextRunAt: number | null;
          status: "active" | "paused";
        }
      | undefined,
  ): AgentSchedule {
    const isCurrent = state?.currentRevision === revision.revision;

    return agentScheduleSchema.parse({
      agentId: revision.agentId,
      agentRevision: revision.agentRevision,
      configuration: revision.configuration,
      createdAt: new Date(revision.createdAt).toISOString(),
      lastDispatchedAt:
        !isCurrent || state.lastDispatchedAt === null
          ? null
          : new Date(state.lastDispatchedAt).toISOString(),
      lastRunId: isCurrent ? state.lastRunId : null,
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
