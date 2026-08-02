import { agentIdSchema, runIdSchema, type StartRunResult } from "@crewhelm/contracts";
import * as z from "zod";

type RunFailureCode = Extract<StartRunResult, { ok: false }>["error"]["code"];
type ScheduleFailureReason = RunFailureCode | "dispatch_exception" | "record_dispatch_conflict";

const SCHEDULE_FAILURE_REASON = {
  admission_limit_exceeded: "admission_limit_exceeded",
  agent_not_found: "agent_not_found",
  agent_unavailable: "agent_unavailable",
  branch_revision_conflict: "branch_revision_conflict",
  brief_context_too_large: "brief_context_too_large",
  brief_unavailable: "brief_unavailable",
  budget_exhausted: "budget_exhausted",
  capability_unavailable: "capability_unavailable",
  dispatch_exception: "dispatch_exception",
  idempotency_conflict: "idempotency_conflict",
  incompatible_schema: "incompatible_schema",
  insufficient_scope: "insufficient_scope",
  invalid_authority: "invalid_authority",
  invalid_request: "invalid_request",
  model_unavailable: "model_unavailable",
  owner_mismatch: "owner_mismatch",
  record_dispatch_conflict: "record_dispatch_conflict",
  revision_conflict: "revision_conflict",
  run_unavailable: "run_unavailable",
  session_busy: "session_busy",
  session_not_found: "session_not_found",
} as const satisfies Record<ScheduleFailureReason, ScheduleFailureReason>;

const scheduleEventSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    agentId: agentIdSchema,
    outcome: z.literal("dispatched"),
    runId: runIdSchema,
  }),
  z.strictObject({
    agentId: agentIdSchema,
    outcome: z.enum(["skipped_active", "skipped_unavailable"]),
  }),
  z.strictObject({
    agentId: agentIdSchema,
    outcome: z.literal("failed"),
    reason: z.enum(Object.values(SCHEDULE_FAILURE_REASON)),
  }),
]);

export function recordScheduleEvent(input: unknown): void {
  let event: ReturnType<typeof scheduleEventSchema.safeParse> | undefined;
  try {
    event = scheduleEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    try {
      console.warn({ event: "crewhelm.schedule.telemetry_rejected" });
    } catch {
      // Diagnostic telemetry must not alter scheduling.
    }
    return;
  }

  try {
    console.info({ event: "crewhelm.schedule", ...event.data });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}
