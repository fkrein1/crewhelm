import * as z from "zod";

import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
} from "./control-plane.js";
import { runIdSchema } from "./capabilities.js";
import { runPromptSchema } from "./run-admission.js";

export const MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS = 60;
export const MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
export const MAXIMUM_DUE_AGENT_SCHEDULES_PER_ALARM = 25;

export const agentScheduleRevisionNumberSchema = z.number().int().positive().safe();
export const agentScheduleConfigurationSchema = z.strictObject({
  intervalSeconds: z
    .number()
    .int()
    .min(MINIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS)
    .max(MAXIMUM_AGENT_SCHEDULE_INTERVAL_SECONDS),
  prompt: runPromptSchema,
});
export const agentScheduleSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  configuration: agentScheduleConfigurationSchema.nullable(),
  createdAt: z.iso.datetime(),
  lastDispatchedAt: z.iso.datetime().nullable(),
  lastRunId: runIdSchema.nullable(),
  nextRunAt: z.iso.datetime().nullable(),
  revision: agentScheduleRevisionNumberSchema,
  status: z.enum(["active", "paused"]),
});

export const configureAgentScheduleInputSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedAgentRevision: agentRevisionNumberSchema,
  expectedScheduleRevision: agentScheduleRevisionNumberSchema.nullable(),
  idempotencyKey: agentMutationIdempotencyKeySchema,
  schedule: agentScheduleConfigurationSchema.nullable(),
});
export const getAgentScheduleInputSchema = z.strictObject({
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
    "schedule_not_found",
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

export type AgentSchedule = z.infer<typeof agentScheduleSchema>;
export type AgentScheduleConfiguration = z.infer<typeof agentScheduleConfigurationSchema>;
export type ConfigureAgentScheduleResult = z.infer<typeof configureAgentScheduleResultSchema>;
export type GetAgentScheduleResult = z.infer<typeof getAgentScheduleResultSchema>;
