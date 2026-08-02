import {
  CONNECTIONS_READ_SCOPE,
  agentWatchesInputSchema,
  agentWatchesResultSchema,
  type AgentSchedule,
  type AgentWatch,
  type AgentWatchDefinition,
  type AgentWatchesResult,
  type OwnerAuthority,
} from "@crewhelm/contracts";

import type { AgentSchedules } from "../schedules/index.js";
import type { AgentEventWatches } from "./event-module.js";

type AgentWatchFailure = Extract<AgentWatchesResult, { ok: false }>;

export function deniedAgentWatch(code: AgentWatchFailure["error"]["code"]): AgentWatchFailure {
  return { error: { code, message: "Agent Watch request denied." }, ok: false };
}

function watchFailureFromSchedule(
  code:
    | "agent_not_found"
    | "agent_unavailable"
    | "idempotency_conflict"
    | "incompatible_schema"
    | "insufficient_scope"
    | "invalid_authority"
    | "invalid_request"
    | "no_changes"
    | "owner_mismatch"
    | "revision_conflict"
    | "schedule_busy"
    | "schedule_limit_exceeded"
    | "schedule_not_found"
    | "schedule_selection_required",
): AgentWatchFailure {
  switch (code) {
    case "schedule_busy":
      return deniedAgentWatch("watch_busy");
    case "schedule_limit_exceeded":
      return deniedAgentWatch("watch_limit_exceeded");
    case "schedule_not_found":
    case "schedule_selection_required":
      return deniedAgentWatch("watch_not_found");
    case "agent_not_found":
    case "agent_unavailable":
    case "idempotency_conflict":
    case "incompatible_schema":
    case "insufficient_scope":
    case "invalid_authority":
    case "invalid_request":
    case "no_changes":
    case "owner_mismatch":
    case "revision_conflict":
      return deniedAgentWatch(code);
    default:
      return deniedAgentWatch(code);
  }
}

function scheduleDefinition(definition: AgentWatchDefinition) {
  if (definition.source.kind !== "scheduled_check") {
    throw new TypeError("Expected a scheduled-check Watch definition.");
  }

  return {
    name: definition.name,
    ...(definition.outputContract === undefined
      ? {}
      : { outputContract: definition.outputContract }),
    prompt: definition.instruction,
    trigger: definition.source.trigger,
  };
}

export class AgentWatches {
  readonly #events: AgentEventWatches;
  readonly #schedules: AgentSchedules;

  constructor(schedules: AgentSchedules, events: AgentEventWatches) {
    this.#events = events;
    this.#schedules = schedules;
  }

  async execute(authority: OwnerAuthority, input: unknown): Promise<AgentWatchesResult> {
    const request = agentWatchesInputSchema.safeParse(input);

    if (!request.success) {
      return deniedAgentWatch("invalid_request");
    }

    switch (request.data.action) {
      case "sources":
        return request.data.connectionId === undefined
          ? agentWatchesResultSchema.parse({
              action: "sources",
              ok: true,
              sources: [
                {
                  description:
                    "Crewhelm asks the Agent on this schedule. A check may find nothing; no webhook or bearer token is required.",
                  id: "scheduled_check",
                  kind: "scheduled_check",
                  limits: this.#schedules.watchSourceLimits(),
                  name: "Scheduled check",
                },
              ],
            })
          : this.#events.sources(request.data.connectionId);
      case "create":
        if (request.data.watch.source.kind === "connection_event") {
          return this.#events.create(authority, request.data);
        }
        return this.#configure(authority, "create", {
          agentId: request.data.agentId,
          expectedAgentRevision: request.data.expectedAgentRevision,
          expectedScheduleRevision: null,
          idempotencyKey: request.data.idempotencyKey,
          schedule: scheduleDefinition(request.data.watch),
          scheduleId: null,
        });
      case "update":
        if (request.data.watchId.startsWith("watch_")) {
          return request.data.watch.source.kind === "connection_event"
            ? this.#events.update(authority, request.data)
            : deniedAgentWatch("invalid_request");
        }

        if (request.data.watch.source.kind !== "scheduled_check") {
          return deniedAgentWatch("invalid_request");
        }
        return this.#configure(authority, "update", {
          agentId: request.data.agentId,
          expectedAgentRevision: request.data.expectedAgentRevision,
          expectedScheduleRevision: request.data.expectedWatchRevision,
          idempotencyKey: request.data.idempotencyKey,
          schedule: scheduleDefinition(request.data.watch),
          scheduleId: request.data.watchId,
        });
      case "pause":
        if (request.data.watchId.startsWith("watch_")) {
          return this.#events.lifecycle(authority, request.data);
        }
        return this.#configure(authority, "pause", {
          agentId: request.data.agentId,
          expectedAgentRevision: request.data.expectedAgentRevision,
          expectedScheduleRevision: request.data.expectedWatchRevision,
          idempotencyKey: request.data.idempotencyKey,
          schedule: null,
          scheduleId: request.data.watchId,
        });
      case "resume": {
        if (request.data.watchId.startsWith("watch_")) {
          return this.#events.lifecycle(authority, request.data);
        }
        const definition = this.#schedules.resumableWatchDefinition(
          request.data.agentId,
          request.data.watchId,
        );

        return definition === null
          ? deniedAgentWatch("watch_not_found")
          : this.#configure(authority, "resume", {
              agentId: request.data.agentId,
              expectedAgentRevision: request.data.expectedAgentRevision,
              expectedScheduleRevision: request.data.expectedWatchRevision,
              idempotencyKey: request.data.idempotencyKey,
              schedule: scheduleDefinition(definition),
              scheduleId: request.data.watchId,
            });
      }
      case "delete": {
        if (request.data.watchId.startsWith("watch_")) {
          return this.#events.lifecycle(authority, request.data);
        }
        const result = await this.#schedules.deleteWatch(authority, request.data);

        return result.ok
          ? agentWatchesResultSchema.parse({ action: "delete", ...result })
          : watchFailureFromSchedule(result.error.code);
      }
      case "inspect": {
        if (request.data.watchId.startsWith("watch_")) {
          return this.#events.inspect(request.data.agentId, request.data.watchId);
        }
        const result = this.#schedules.get({
          agentId: request.data.agentId,
          scheduleId: request.data.watchId,
        });

        return result.ok
          ? agentWatchesResultSchema.parse({
              action: "inspect",
              ok: true,
              watch: this.#watchFromSchedule(result.schedule),
            })
          : watchFailureFromSchedule(result.error.code);
      }
      case "list": {
        const result = this.#schedules.list({ agentId: request.data.agentId });

        return result.ok
          ? agentWatchesResultSchema.parse({
              action: "list",
              ok: true,
              watches: [
                ...result.schedules.map((schedule) => this.#watchFromSchedule(schedule)),
                ...(authority.scopes.includes(CONNECTIONS_READ_SCOPE)
                  ? this.#events.list(request.data.agentId)
                  : []),
              ].toSorted((left, right) => left.id.localeCompare(right.id)),
            })
          : watchFailureFromSchedule(result.error.code);
      }
      case "history": {
        if (request.data.watchId.startsWith("watch_")) {
          const occurrences = this.#events.history(
            request.data.agentId,
            request.data.watchId,
            request.data.limit,
          );

          return occurrences === null
            ? deniedAgentWatch("watch_not_found")
            : agentWatchesResultSchema.parse({
                action: "history",
                occurrences,
                ok: true,
                watchId: request.data.watchId,
              });
        }
        const occurrences = this.#schedules.watchHistory(
          request.data.agentId,
          request.data.watchId,
          request.data.limit,
        );

        return occurrences === null
          ? deniedAgentWatch("watch_not_found")
          : agentWatchesResultSchema.parse({
              action: "history",
              occurrences,
              ok: true,
              watchId: request.data.watchId,
            });
      }
    }

    return deniedAgentWatch("invalid_request");
  }

  async #configure(
    authority: OwnerAuthority,
    action: "create" | "pause" | "resume" | "update",
    input: Parameters<AgentSchedules["configure"]>[1],
  ): Promise<AgentWatchesResult> {
    const result = await this.#schedules.configure(authority, input);

    return result.ok
      ? agentWatchesResultSchema.parse({
          action,
          changed: result.configured,
          ok: true,
          watch: this.#watchFromSchedule(result.schedule),
        })
      : watchFailureFromSchedule(result.error.code);
  }

  #watchFromSchedule(schedule: AgentSchedule): AgentWatch {
    const definition =
      schedule.configuration === null
        ? this.#schedules.resumableWatchDefinition(schedule.agentId, schedule.id)
        : {
            instruction: schedule.configuration.prompt,
            name: schedule.name,
            ...("outputContract" in schedule.configuration &&
            schedule.configuration.outputContract !== undefined
              ? { outputContract: schedule.configuration.outputContract }
              : {}),
            source: {
              kind: "scheduled_check" as const,
              trigger:
                "trigger" in schedule.configuration
                  ? schedule.configuration.trigger
                  : {
                      intervalSeconds: schedule.configuration.intervalSeconds,
                      type: "interval" as const,
                    },
            },
          };

    if (definition === null) {
      throw new Error("Agent Watch lost its last active definition.");
    }

    return {
      agentId: schedule.agentId,
      agentRevision: schedule.agentRevision,
      createdAt: schedule.createdAt,
      definition,
      id: schedule.id,
      lastOccurrence: this.#schedules.watchHistory(schedule.agentId, schedule.id, 1)?.[0] ?? null,
      nextCheckAt: schedule.nextRunAt,
      revision: schedule.revision,
      status: schedule.status,
    };
  }
}
