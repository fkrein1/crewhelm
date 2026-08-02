import {
  agentIdSchema,
  capabilityGrantIdSchema,
  connectionIdSchema,
  runIdSchema,
  toolCallIdSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

const recoveryEventSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    agentId: agentIdSchema,
    operation: z.literal("agent.disable"),
    outcome: z.enum(["changed", "replayed"]),
  }),
  z.strictObject({
    connectionId: connectionIdSchema,
    operation: z.literal("connection.revoke"),
    outcome: z.enum(["changed", "replayed"]),
  }),
  z.strictObject({
    grantId: capabilityGrantIdSchema,
    operation: z.literal("capability.revoke"),
    outcome: z.enum(["changed", "replayed"]),
  }),
  z.strictObject({
    operation: z.literal("tool.reconcile"),
    outcome: z.enum(["changed", "replayed"]),
    resolution: z.enum(["applied", "not_applied"]),
    runId: runIdSchema,
    toolCallId: toolCallIdSchema,
  }),
]);

export function recordRecoveryEvent(input: unknown): void {
  let event: ReturnType<typeof recoveryEventSchema.safeParse> | undefined;
  try {
    event = recoveryEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    try {
      console.warn({ event: "crewhelm.recovery.telemetry_rejected" });
    } catch {
      // Diagnostic telemetry must not alter recovery.
    }
    return;
  }

  try {
    console.info({ event: "crewhelm.recovery", ...event.data });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}
