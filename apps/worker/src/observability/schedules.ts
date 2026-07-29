import { agentIdSchema, runIdSchema } from "@crewhelm/contracts";
import * as z from "zod";

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
    reason: z.enum([
      "admission_limit_exceeded",
      "agent_not_found",
      "agent_unavailable",
      "budget_exhausted",
      "capability_unavailable",
      "dispatch_exception",
      "idempotency_conflict",
      "incompatible_schema",
      "insufficient_scope",
      "invalid_authority",
      "invalid_request",
      "model_unavailable",
      "owner_mismatch",
      "record_dispatch_conflict",
      "revision_conflict",
      "run_unavailable",
    ]),
  }),
]);

export function recordScheduleEvent(input: unknown): void {
  const event = scheduleEventSchema.safeParse(input);

  if (!event.success) {
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
