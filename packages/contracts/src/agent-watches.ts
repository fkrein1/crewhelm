import * as z from "zod";

import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
} from "./control-plane.js";
import {
  MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS,
  MAXIMUM_AGENT_SCHEDULES_PER_AGENT,
  MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS,
  agentScheduleNameSchema,
  agentScheduleTriggerSchema,
  type AgentScheduleTrigger,
} from "./agent-schedules.js";
import { outputContractSchema } from "./output-contracts.js";
import type { OutputContract } from "./output-contracts.js";
import { runIdSchema } from "./capabilities.js";
import { runPromptSchema } from "./run-admission.js";
import { agentScheduleIdSchema, agentScheduleRevisionNumberSchema } from "./schedule-revision.js";
import { connectionIdSchema } from "./connections.js";
import {
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
} from "./integrations.js";

export const MAXIMUM_AGENT_WATCH_HISTORY_ITEMS = 20;
export const MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES = 100;

export type AgentWatchDefinition = {
  instruction: string;
  name: string;
  outputContract?: OutputContract | undefined;
  source:
    | { kind: "scheduled_check"; trigger: AgentScheduleTrigger }
    | {
        configuration: z.infer<typeof integrationToolParameterMapSchema>;
        connectionId: string;
        delivery: "provider_polling" | "realtime";
        integrationSlug: string;
        kind: "connection_event";
        sourceSlug: string;
        sourceVersion: string;
      };
};
export type AgentWatchOccurrence = {
  eventId: string | null;
  occurredAt: string;
  outcome: "pending" | "dispatched" | "skipped";
  reason:
    | "active_run"
    | "agent_changed"
    | "agent_unavailable"
    | "connection_unavailable"
    | "dispatch_exception"
    | "event_too_large"
    | "record_dispatch_conflict"
    | "run_unavailable"
    | "source_mismatch"
    | "watch_deleted"
    | "watch_paused"
    | "watch_queue_full"
    | null;
  runId: string | null;
  scheduledFor: string;
  sourceKind: "connection_event" | "scheduled_check";
  watchRevision: number;
};
export type AgentWatch = {
  agentId: string;
  agentRevision: number;
  createdAt: string;
  definition: AgentWatchDefinition;
  id: string;
  lastOccurrence: AgentWatchOccurrence | null;
  nextCheckAt: string | null;
  revision: number;
  status: "active" | "paused";
};

const connectionEventWatchIdSchema = z
  .string()
  .regex(
    /^watch_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Agent Watch ID.",
  );
export const agentWatchIdSchema = z
  .union([agentScheduleIdSchema, connectionEventWatchIdSchema])
  .describe(
    "Opaque Watch identity. Scheduled-check Watches retain their compatible schedule identity.",
  );
export const agentWatchRevisionNumberSchema = agentScheduleRevisionNumberSchema;

export const agentWatchSourceSchema = z
  .strictObject({
    kind: z.literal("scheduled_check"),
    trigger: agentScheduleTriggerSchema,
  })
  .or(
    z.strictObject({
      configuration: integrationToolParameterMapSchema,
      connectionId: connectionIdSchema,
      delivery: z.enum(["provider_polling", "realtime"]),
      integrationSlug: integrationSlugSchema,
      kind: z.literal("connection_event"),
      sourceSlug: integrationToolSlugSchema,
      sourceVersion: integrationToolkitVersionSchema,
    }),
  );

export const agentWatchDefinitionSchema: z.ZodType<AgentWatchDefinition> = z.strictObject({
  instruction: runPromptSchema.describe(
    "What the Agent should do for each Watch occurrence and what useful outcome it should return.",
  ),
  name: agentScheduleNameSchema,
  outputContract: outputContractSchema
    .describe("Optional deliverable contract frozen for every Watch occurrence.")
    .optional(),
  source: agentWatchSourceSchema,
});

const scheduledWatchToolDefinitionSchema = z.strictObject({
  everyMinutes: z
    .number()
    .int()
    .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS / 60)
    .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS / 60)
    .describe("How often Crewhelm should ask the Agent to check. A check may find nothing."),
  instruction: runPromptSchema.describe(
    "What the Agent should check and what useful outcome it should return.",
  ),
  name: agentScheduleNameSchema,
  outputContract: outputContractSchema
    .describe("Optional deliverable contract frozen for every Watch occurrence.")
    .optional(),
});

const eventWatchFiltersSchema = z
  .record(
    z.string().min(1).max(128),
    z.union([z.boolean(), z.number().finite(), z.string().max(2_048)]),
  )
  .superRefine((filters, context) => {
    if (Object.keys(filters).length > 32) {
      context.addIssue({
        code: "custom",
        message: "A connected-event Watch has too many filters.",
      });
    }
  });

const eventWatchToolDefinitionSchema = z.strictObject({
  connectionId: connectionIdSchema.describe("Connected account returned by sources."),
  delivery: z.enum(["provider_polling", "realtime"]).describe("Delivery returned by sources."),
  eventSlug: integrationToolSlugSchema.describe("Event slug returned by sources."),
  eventVersion: integrationToolkitVersionSchema.describe("Event version returned by sources."),
  filters: eventWatchFiltersSchema.describe("Event filters described by the source."),
  integrationSlug: integrationSlugSchema.describe("Integration returned by sources."),
  instruction: runPromptSchema.describe("The Agent's responsibility for each matching event."),
  name: agentScheduleNameSchema,
  outputContract: outputContractSchema
    .describe("Optional output contract for each event Run.")
    .optional(),
});

export const agentWatchToolDefinitionSchema = z.union([
  scheduledWatchToolDefinitionSchema,
  eventWatchToolDefinitionSchema,
]);

export const agentWatchOccurrenceSchema: z.ZodType<AgentWatchOccurrence> = z.strictObject({
  eventId: z.string().min(1).max(256).nullable(),
  occurredAt: z.iso.datetime(),
  outcome: z.enum(["pending", "dispatched", "skipped"]),
  reason: z
    .enum([
      "active_run",
      "agent_changed",
      "agent_unavailable",
      "dispatch_exception",
      "connection_unavailable",
      "record_dispatch_conflict",
      "run_unavailable",
      "watch_deleted",
      "watch_paused",
      "watch_queue_full",
      "source_mismatch",
      "event_too_large",
    ])
    .nullable(),
  runId: runIdSchema.nullable(),
  scheduledFor: z.iso.datetime(),
  sourceKind: z.enum(["connection_event", "scheduled_check"]),
  watchRevision: agentWatchRevisionNumberSchema,
});

export const agentWatchSchema: z.ZodType<AgentWatch> = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  createdAt: z.iso.datetime(),
  definition: agentWatchDefinitionSchema,
  id: agentWatchIdSchema,
  lastOccurrence: agentWatchOccurrenceSchema.nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  revision: agentWatchRevisionNumberSchema,
  status: z.enum(["active", "paused"]),
});

const watchMutationBase = {
  agentId: agentIdSchema,
  expectedAgentRevision: agentRevisionNumberSchema,
  idempotencyKey: agentMutationIdempotencyKeySchema,
};

export const agentWatchesInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("sources"), connectionId: connectionIdSchema.optional() }),
  z.strictObject({
    action: z.literal("create"),
    ...watchMutationBase,
    watch: agentWatchDefinitionSchema,
  }),
  z.strictObject({
    action: z.literal("update"),
    ...watchMutationBase,
    expectedWatchRevision: agentWatchRevisionNumberSchema,
    watch: agentWatchDefinitionSchema,
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({
    action: z.literal("pause"),
    ...watchMutationBase,
    expectedWatchRevision: agentWatchRevisionNumberSchema,
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({
    action: z.literal("resume"),
    ...watchMutationBase,
    expectedWatchRevision: agentWatchRevisionNumberSchema,
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    ...watchMutationBase,
    expectedWatchRevision: agentWatchRevisionNumberSchema,
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({
    action: z.literal("inspect"),
    agentId: agentIdSchema,
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({
    action: z.literal("list"),
    agentId: agentIdSchema,
  }),
  z.strictObject({
    action: z.literal("history"),
    agentId: agentIdSchema,
    limit: z.number().int().min(1).max(MAXIMUM_AGENT_WATCH_HISTORY_ITEMS).default(10),
    watchId: agentWatchIdSchema,
  }),
]);

export const agentWatchesToolInputSchema = z
  .strictObject({
    action: z
      .enum([
        "sources",
        "create",
        "update",
        "pause",
        "resume",
        "delete",
        "inspect",
        "list",
        "history",
      ])
      .describe(
        "Send only fields for the action: sources(connectionId?); create(agentId,expectedAgentRevision,idempotencyKey,watch); update(create fields plus watchId,expectedWatchRevision); pause|resume|delete(agentId,expectedAgentRevision,expectedWatchRevision,idempotencyKey,watchId); inspect(agentId,watchId); list(agentId); history(agentId,watchId,limit?).",
      ),
    agentId: agentIdSchema.optional(),
    connectionId: connectionIdSchema.optional(),
    expectedAgentRevision: agentRevisionNumberSchema.optional(),
    expectedWatchRevision: agentWatchRevisionNumberSchema.optional(),
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_AGENT_WATCH_HISTORY_ITEMS).optional(),
    watch: agentWatchToolDefinitionSchema.optional(),
    watchId: agentWatchIdSchema.optional(),
  })
  .superRefine((input, context) => {
    const allowed = {
      sources: ["action", "connectionId"],
      create: ["action", "agentId", "expectedAgentRevision", "idempotencyKey", "watch"],
      update: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedWatchRevision",
        "idempotencyKey",
        "watch",
        "watchId",
      ],
      pause: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedWatchRevision",
        "idempotencyKey",
        "watchId",
      ],
      resume: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedWatchRevision",
        "idempotencyKey",
        "watchId",
      ],
      delete: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedWatchRevision",
        "idempotencyKey",
        "watchId",
      ],
      inspect: ["action", "agentId", "watchId"],
      list: ["action", "agentId"],
      history: ["action", "agentId", "limit", "watchId"],
    } as const;
    const required = allowed[input.action].filter(
      (field) => field !== "action" && !(input.action === "history" && field === "limit"),
    );

    for (const field of required) {
      if (input[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${input.action} requires ${field}.`,
          path: [field],
        });
      }
    }

    for (const field of [
      "agentId",
      "connectionId",
      "expectedAgentRevision",
      "expectedWatchRevision",
      "idempotencyKey",
      "limit",
      "watch",
      "watchId",
    ] as const) {
      if (
        input[field] !== undefined &&
        !allowed[input.action].some((allowedField) => allowedField === field)
      ) {
        context.addIssue({
          code: "custom",
          message: `${input.action} does not accept ${field}.`,
          path: [field],
        });
      }
    }
  });

const agentWatchErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_unavailable",
    "connection_not_found",
    "connection_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "no_changes",
    "owner_mismatch",
    "revision_conflict",
    "watch_busy",
    "watch_limit_exceeded",
    "watch_not_found",
    "watch_operation_unknown",
    "watch_source_unavailable",
  ]),
  message: z.literal("Agent Watch request denied."),
});

const successfulWatchMutationSchema = z.strictObject({
  action: z.enum(["create", "update", "pause", "resume"]),
  changed: z.boolean(),
  ok: z.literal(true),
  watch: agentWatchSchema,
});

export type AgentWatchesInput = z.infer<typeof agentWatchesInputSchema>;
export type AgentWatchesResult =
  | {
      action: "sources";
      ok: true;
      sources: Array<
        | {
            description: string;
            id: "scheduled_check";
            kind: "scheduled_check";
            limits: {
              maximumEveryMinutes: number;
              maximumWatchesPerAgent: number;
              minimumEveryMinutes: number;
              retainedOccurrences: number;
            };
            name: "Scheduled check";
          }
        | {
            configuration: Array<{
              description: string | null;
              id: string;
              label: string;
              options: Array<boolean | number | string>;
              required: boolean;
              type: "boolean" | "number" | "select" | "string";
            }>;
            connectionId: string;
            delivery: "provider_polling" | "realtime";
            description: string | null;
            id: string;
            integration: { name: string; slug: string };
            kind: "connection_event";
            name: string;
            sourceSlug: string;
            sourceVersion: string;
          }
      >;
    }
  | {
      action: "create" | "pause" | "resume" | "update";
      changed: boolean;
      ok: true;
      watch: AgentWatch;
    }
  | { action: "delete"; deleted: boolean; ok: true; watchId: string }
  | { action: "inspect"; ok: true; watch: AgentWatch }
  | { action: "list"; ok: true; watches: AgentWatch[] }
  | {
      action: "history";
      occurrences: AgentWatchOccurrence[];
      ok: true;
      watchId: string;
    }
  | {
      error: {
        code:
          | "agent_not_found"
          | "agent_unavailable"
          | "connection_not_found"
          | "connection_unavailable"
          | "idempotency_conflict"
          | "incompatible_schema"
          | "insufficient_scope"
          | "invalid_authority"
          | "invalid_request"
          | "no_changes"
          | "owner_mismatch"
          | "revision_conflict"
          | "watch_busy"
          | "watch_limit_exceeded"
          | "watch_not_found"
          | "watch_operation_unknown"
          | "watch_source_unavailable";
        message: "Agent Watch request denied.";
      };
      ok: false;
    };

export const agentWatchesResultSchema: z.ZodType<AgentWatchesResult> = z.union([
  z.strictObject({
    action: z.literal("sources"),
    ok: z.literal(true),
    sources: z
      .array(
        z.union([
          z.strictObject({
            description: z.string().min(1).max(300),
            id: z.literal("scheduled_check"),
            kind: z.literal("scheduled_check"),
            limits: z.strictObject({
              maximumEveryMinutes: z.literal(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS / 60),
              maximumWatchesPerAgent: z.literal(MAXIMUM_AGENT_SCHEDULES_PER_AGENT),
              minimumEveryMinutes: z
                .number()
                .int()
                .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS / 60)
                .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS / 60),
              retainedOccurrences: z.literal(MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES),
            }),
            name: z.literal("Scheduled check"),
          }),
          z.strictObject({
            configuration: z
              .array(
                z.strictObject({
                  description: z.string().min(1).max(300).nullable(),
                  id: z.string().min(1).max(128),
                  label: z.string().min(1).max(120),
                  options: z.array(z.union([z.boolean(), z.number(), z.string()])).max(50),
                  required: z.boolean(),
                  type: z.enum(["boolean", "number", "select", "string"]),
                }),
              )
              .max(32),
            connectionId: connectionIdSchema,
            delivery: z.enum(["provider_polling", "realtime"]),
            description: z.string().min(1).max(500).nullable(),
            id: z.string().min(1).max(512),
            integration: z.strictObject({
              name: z.string().min(1).max(160),
              slug: integrationSlugSchema,
            }),
            kind: z.literal("connection_event"),
            name: z.string().min(1).max(160),
            sourceSlug: integrationToolSlugSchema,
            sourceVersion: integrationToolkitVersionSchema,
          }),
        ]),
      )
      .max(21),
  }),
  successfulWatchMutationSchema,
  z.strictObject({
    action: z.literal("delete"),
    deleted: z.boolean(),
    ok: z.literal(true),
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({ action: z.literal("inspect"), ok: z.literal(true), watch: agentWatchSchema }),
  z.strictObject({
    action: z.literal("list"),
    ok: z.literal(true),
    watches: z.array(agentWatchSchema).max(MAXIMUM_AGENT_SCHEDULES_PER_AGENT),
  }),
  z.strictObject({
    action: z.literal("history"),
    occurrences: z.array(agentWatchOccurrenceSchema).max(MAXIMUM_AGENT_WATCH_HISTORY_ITEMS),
    ok: z.literal(true),
    watchId: agentWatchIdSchema,
  }),
  z.strictObject({ error: agentWatchErrorSchema, ok: z.literal(false) }),
]);
