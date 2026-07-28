import { runIdSchema, toolCallIdSchema } from "@crewhelm/contracts";
import * as z from "zod";

const durationMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60 * 60 * 1_000);
const outputBytesSchema = z.number().int().nonnegative().safe();

const executionEventSchema = z.discriminatedUnion("phase", [
  z
    .object({
      outcome: z.enum(["created", "replayed", "redeemed"]),
      phase: z.literal("run.admission"),
      runId: runIdSchema,
    })
    .strict(),
  z
    .object({
      durationMs: durationMsSchema,
      outcome: z.enum(["accepted", "rejected"]),
      phase: z.literal("run.submission"),
      runId: runIdSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["approved", "rejected"]),
      phase: z.literal("tool.approval"),
      runId: runIdSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["allowed", "approval_required"]),
      phase: z.literal("tool.reservation"),
      runId: runIdSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("claimed"),
      phase: z.literal("tool.dispatch"),
      runId: runIdSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
  z
    .object({
      durationMs: durationMsSchema,
      outcome: z.enum(["completed", "failed"]),
      phase: z.literal("tool.provider"),
      runId: runIdSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.enum(["completed", "failed", "unknown"]),
      outputBytes: outputBytesSchema,
      phase: z.literal("tool.completion"),
      runId: runIdSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
]);

export type ExecutionEvent = z.infer<typeof executionEventSchema>;

function rejectTelemetry(): void {
  try {
    console.warn({ event: "crewhelm.execution.telemetry_rejected" });
  } catch {
    // Diagnostic telemetry must not alter execution.
  }
}

export function recordExecutionEvent(input: unknown): void {
  const event = executionEventSchema.safeParse(input);

  if (!event.success) {
    rejectTelemetry();
    return;
  }

  try {
    console.info({ event: "crewhelm.execution", ...event.data });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}
