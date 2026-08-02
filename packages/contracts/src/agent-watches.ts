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
} from "./agent-schedules.js";
import { outputContractSchema } from "./output-contracts.js";
import { runIdSchema } from "./capabilities.js";
import { runPromptSchema } from "./run-admission.js";
import { agentScheduleIdSchema, agentScheduleRevisionNumberSchema } from "./schedule-revision.js";

export const MAXIMUM_AGENT_WATCH_HISTORY_ITEMS = 20;
export const MAXIMUM_RETAINED_AGENT_WATCH_OCCURRENCES = 100;

export const agentWatchIdSchema = agentScheduleIdSchema.describe(
  "Opaque Watch identity. Scheduled-check Watches retain their compatible schedule identity.",
);
export const agentWatchRevisionNumberSchema = agentScheduleRevisionNumberSchema;

export const agentWatchSourceSchema = z.strictObject({
  kind: z.literal("scheduled_check"),
  trigger: agentScheduleTriggerSchema,
});

export const agentWatchDefinitionSchema = z.strictObject({
  instruction: runPromptSchema.describe(
    "What the Agent should check and what useful outcome it should return.",
  ),
  name: agentScheduleNameSchema,
  outputContract: outputContractSchema
    .describe("Optional deliverable contract frozen for every Watch occurrence.")
    .optional(),
  source: agentWatchSourceSchema,
});

export const agentWatchToolDefinitionSchema = z.strictObject({
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

export const agentWatchOccurrenceSchema = z.strictObject({
  occurredAt: z.iso.datetime(),
  outcome: z.enum(["pending", "dispatched", "skipped"]),
  reason: z
    .enum([
      "active_run",
      "agent_changed",
      "agent_unavailable",
      "dispatch_exception",
      "record_dispatch_conflict",
      "run_unavailable",
      "watch_deleted",
      "watch_paused",
    ])
    .nullable(),
  runId: runIdSchema.nullable(),
  scheduledFor: z.iso.datetime(),
  watchRevision: agentWatchRevisionNumberSchema,
});

export const agentWatchSchema = z.strictObject({
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
  z.strictObject({ action: z.literal("sources") }),
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
        "Choose one action and send only its fields: sources(); create(agentId, expectedAgentRevision, idempotencyKey, watch); update(agentId, expectedAgentRevision, expectedWatchRevision, idempotencyKey, watchId, watch); pause(agentId, expectedAgentRevision, expectedWatchRevision, idempotencyKey, watchId); resume(agentId, expectedAgentRevision, expectedWatchRevision, idempotencyKey, watchId); delete(agentId, expectedAgentRevision, expectedWatchRevision, idempotencyKey, watchId); inspect(agentId, watchId); list(agentId); history(agentId, watchId, limit?).",
      ),
    agentId: agentIdSchema.optional(),
    expectedAgentRevision: agentRevisionNumberSchema.optional(),
    expectedWatchRevision: agentWatchRevisionNumberSchema.optional(),
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_AGENT_WATCH_HISTORY_ITEMS).optional(),
    watch: agentWatchToolDefinitionSchema.optional(),
    watchId: agentWatchIdSchema.optional(),
  })
  .superRefine((input, context) => {
    const allowed = {
      sources: ["action"],
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
  ]),
  message: z.literal("Agent Watch request denied."),
});

const successfulWatchMutationSchema = z.strictObject({
  action: z.enum(["create", "update", "pause", "resume"]),
  changed: z.boolean(),
  ok: z.literal(true),
  watch: agentWatchSchema,
});

export const agentWatchesResultSchema = z.union([
  z.strictObject({
    action: z.literal("sources"),
    ok: z.literal(true),
    sources: z.array(
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
    ),
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

export type AgentWatch = z.infer<typeof agentWatchSchema>;
export type AgentWatchDefinition = z.infer<typeof agentWatchDefinitionSchema>;
export type AgentWatchOccurrence = z.infer<typeof agentWatchOccurrenceSchema>;
export type AgentWatchesInput = z.infer<typeof agentWatchesInputSchema>;
export type AgentWatchesResult = z.infer<typeof agentWatchesResultSchema>;
