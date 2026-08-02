import * as z from "zod";

import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
} from "./control-plane.js";
import { runIdSchema } from "./capabilities.js";
import { agentInboxDeferredReasonSchema } from "./diagnostics.js";
import { runPromptSchema } from "./run-admission.js";
import { agentScheduleIdSchema, agentScheduleRevisionNumberSchema } from "./schedule-revision.js";
import { outputContractSchema } from "./output-contracts.js";

export const MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS = 60;
export const MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
export const MAXIMUM_AGENT_SCHEDULES_PER_AGENT = 8;
export const MAXIMUM_AGENT_SCHEDULE_NAME_CHARACTERS = 80;
export const MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM = 25;

export const agentScheduleNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAXIMUM_AGENT_SCHEDULE_NAME_CHARACTERS)
  .describe("Short owner-facing name for this scheduled responsibility.");

const agentScheduleTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour local time in HH:mm form.")
  .describe("Local wall-clock time in 24-hour HH:mm form.");
const agentScheduleTimeZoneSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(?:UTC|[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+)$/,
    "Expected an IANA time zone such as America/Sao_Paulo.",
  )
  .describe("IANA time zone used to preserve local wall-clock time across offset changes.");

export const agentScheduleWeekdaySchema = z.enum([
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);
const AGENT_SCHEDULE_WEEKDAYS = agentScheduleWeekdaySchema.options;

const agentScheduleIntervalTriggerSchema = z.strictObject({
  intervalSeconds: z
    .number()
    .int()
    .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
    .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
    .describe("Elapsed seconds between Runs; the first Run occurs one interval after creation."),
  type: z.literal("interval"),
});
const agentScheduleDailyTriggerSchema = z.strictObject({
  at: agentScheduleTimeSchema,
  frequency: z.literal("daily"),
  timeZone: agentScheduleTimeZoneSchema,
  type: z.literal("calendar"),
});
const agentScheduleWeeklyTriggerSchema = z.strictObject({
  at: agentScheduleTimeSchema,
  daysOfWeek: z
    .array(agentScheduleWeekdaySchema)
    .min(1)
    .max(AGENT_SCHEDULE_WEEKDAYS.length)
    .refine(
      (days) =>
        days.every(
          (day, index) =>
            index === 0 ||
            AGENT_SCHEDULE_WEEKDAYS.indexOf(days[index - 1] ?? "monday") <
              AGENT_SCHEDULE_WEEKDAYS.indexOf(day),
        ),
      "Expected unique weekdays in Monday-to-Sunday order.",
    )
    .describe("Execution weekdays, unique and ordered Monday through Sunday."),
  frequency: z.literal("weekly"),
  timeZone: agentScheduleTimeZoneSchema,
  type: z.literal("calendar"),
});
const agentScheduleMonthlyTriggerSchema = z.strictObject({
  at: agentScheduleTimeSchema,
  dayOfMonth: z
    .number()
    .int()
    .min(1)
    .max(31)
    .describe("Local calendar day; months without this day are skipped."),
  frequency: z.literal("monthly"),
  timeZone: agentScheduleTimeZoneSchema,
  type: z.literal("calendar"),
});

export const agentScheduleTriggerSchema = z.union([
  agentScheduleIntervalTriggerSchema,
  agentScheduleDailyTriggerSchema,
  agentScheduleWeeklyTriggerSchema,
  agentScheduleMonthlyTriggerSchema,
]);

const legacyAgentScheduleConfigurationSchema = z
  .strictObject({
    intervalSeconds: z
      .number()
      .int()
      .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
      .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS),
    prompt: runPromptSchema,
  })
  .describe("Legacy interval schedule retained for compatible upgrades.");

export const agentScheduleConfigurationSchema = z.union([
  z.strictObject({
    outputContract: outputContractSchema.optional(),
    prompt: runPromptSchema.describe("Bounded Run instruction used for every occurrence."),
    trigger: agentScheduleTriggerSchema,
  }),
  legacyAgentScheduleConfigurationSchema,
]);

export const agentScheduleDefinitionSchema = z.strictObject({
  name: agentScheduleNameSchema,
  outputContract: outputContractSchema
    .describe("Optional deliverable contract frozen for every scheduled Run.")
    .optional(),
  prompt: runPromptSchema.describe("Bounded Run instruction used for every occurrence."),
  trigger: agentScheduleTriggerSchema,
});

const agentScheduleShape = {
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  configuration: agentScheduleConfigurationSchema.nullable(),
  createdAt: z.iso.datetime(),
  id: agentScheduleIdSchema.describe(
    "Opaque identity for exact reads, updates, and independent pause operations.",
  ),
  lastDispatchedAt: z.iso.datetime().nullable(),
  lastAttempt: z
    .strictObject({
      occurredAt: z.iso.datetime(),
      outcome: z.enum(["deferred", "dispatched"]),
      reason: agentInboxDeferredReasonSchema.nullable(),
      retryAt: z.iso.datetime().nullable(),
      runId: runIdSchema.nullable(),
    })
    .nullable(),
  lastRunId: runIdSchema.nullable(),
  name: agentScheduleNameSchema,
  nextRunAt: z.iso.datetime().nullable(),
  revision: agentScheduleRevisionNumberSchema,
  status: z.enum(["active", "paused"]),
};

export const agentScheduleSchema = z.strictObject(agentScheduleShape);
export const upgradeCompatibleAgentScheduleSchema = z.strictObject({
  ...agentScheduleShape,
  id: agentScheduleShape.id.optional(),
  name: agentScheduleShape.name.optional(),
});

export const configureAgentScheduleInputSchema = z
  .strictObject({
    agentId: agentIdSchema,
    expectedAgentRevision: agentRevisionNumberSchema,
    expectedScheduleRevision: agentScheduleRevisionNumberSchema.nullable(),
    idempotencyKey: agentMutationIdempotencyKeySchema,
    schedule: z
      .union([agentScheduleDefinitionSchema, legacyAgentScheduleConfigurationSchema])
      .nullable(),
    scheduleId: agentScheduleIdSchema
      .nullable()
      .optional()
      .describe(
        "Use null to create another schedule, an exact ID to update or pause it, or omit only for legacy singleton behavior.",
      ),
  })
  .superRefine((input, context) => {
    if (input.scheduleId === null && input.expectedScheduleRevision !== null) {
      context.addIssue({
        code: "custom",
        message: "A new schedule cannot have an expected schedule revision.",
        path: ["expectedScheduleRevision"],
      });
    }

    if (typeof input.scheduleId === "string" && input.expectedScheduleRevision === null) {
      context.addIssue({
        code: "custom",
        message: "An exact schedule update requires its expected revision.",
        path: ["expectedScheduleRevision"],
      });
    }

    if (input.schedule === null && input.expectedScheduleRevision === null) {
      context.addIssue({
        code: "custom",
        message: "Pausing a schedule requires its expected revision.",
        path: ["schedule"],
      });
    }
  });

export const getAgentScheduleInputSchema = z.strictObject({
  agentId: agentIdSchema,
  scheduleId: agentScheduleIdSchema
    .optional()
    .describe("Exact schedule identity. Omit only when the Agent has at most one schedule."),
});
export const listAgentSchedulesInputSchema = z.strictObject({
  agentId: agentIdSchema,
});

const agentScheduleErrorSchema = z.strictObject({
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
    "schedule_limit_exceeded",
    "schedule_not_found",
    "schedule_selection_required",
  ]),
  message: z.literal("Agent schedule request denied."),
});

export const configureAgentScheduleResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    configured: z.boolean(),
    ok: z.literal(true),
    schedule: agentScheduleSchema,
  }),
  z.strictObject({
    error: agentScheduleErrorSchema,
    ok: z.literal(false),
  }),
]);
export const getAgentScheduleResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    schedule: agentScheduleSchema,
  }),
  z.strictObject({
    error: agentScheduleErrorSchema,
    ok: z.literal(false),
  }),
]);
export const listAgentSchedulesResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    schedules: z.array(agentScheduleSchema).max(MAXIMUM_AGENT_SCHEDULES_PER_AGENT),
  }),
  z.strictObject({
    error: agentScheduleErrorSchema,
    ok: z.literal(false),
  }),
]);

export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
export type AgentScheduleConfiguration = z.infer<typeof agentScheduleConfigurationSchema>;
export type AgentScheduleDefinition = z.infer<typeof agentScheduleDefinitionSchema>;
export type AgentScheduleId = z.infer<typeof agentScheduleIdSchema>;
export type AgentScheduleTrigger = z.infer<typeof agentScheduleTriggerSchema>;
export type ConfigureAgentScheduleResult = z.infer<typeof configureAgentScheduleResultSchema>;
export type GetAgentScheduleResult = z.infer<typeof getAgentScheduleResultSchema>;
export type ListAgentSchedulesResult = z.infer<typeof listAgentSchedulesResultSchema>;
