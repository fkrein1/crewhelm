import {
  agentIdSchema,
  agentRevisionNumberSchema,
  capabilityEffectSchema,
  capabilityGrantIdSchema,
  connectionIdSchema,
  integrationSlugSchema,
  integrationToolSlugSchema,
  runIdSchema,
  toolAuthorizationFailureReasonSchema,
  toolAuthorizationModeSchema,
  toolCallIdSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

const durationMsSchema = z
  .number()
  .int()
  .nonnegative()
  .max(24 * 60 * 60 * 1_000);
const outputBytesSchema = z.number().int().nonnegative().safe();
const providerStatusSchema = z.number().int().min(100).max(599).nullable();

const toolAuthorizationEventSchema = z
  .object({
    agentId: agentIdSchema.optional(),
    agentRevision: agentRevisionNumberSchema.optional(),
    authorization: toolAuthorizationModeSchema.optional(),
    checkpoint: z.enum(["action_authorization", "pre_execution"]),
    connectionId: connectionIdSchema.optional(),
    durationMs: durationMsSchema,
    effect: capabilityEffectSchema.optional(),
    grantId: capabilityGrantIdSchema.optional(),
    integrationSlug: integrationSlugSchema.optional(),
    outcome: z.enum(["allowed", "approval_required", "blocked"]),
    phase: z.literal("tool.authorization"),
    reason: toolAuthorizationFailureReasonSchema.optional(),
    runId: runIdSchema,
    toolCallId: toolCallIdSchema,
    toolSlug: integrationToolSlugSchema.optional(),
  })
  .strict()
  .refine(
    (event) => (event.outcome === "blocked") === (event.reason !== undefined),
    "Blocked authorization events require one safe reason.",
  )
  .refine(
    (event) =>
      event.outcome === "blocked" ||
      (event.agentId !== undefined &&
        event.agentRevision !== undefined &&
        event.authorization !== undefined &&
        event.connectionId !== undefined &&
        event.effect !== undefined &&
        event.grantId !== undefined &&
        event.integrationSlug !== undefined &&
        event.toolSlug !== undefined),
    "Successful authorization events require grant context.",
  );
const executionEventSchema = z.union([
  toolAuthorizationEventSchema,
  z.discriminatedUnion("phase", [
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
        outcome: z.enum(["requested", "completed"]),
        phase: z.literal("run.cancellation"),
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
  ]),
]);

export type ExecutionEvent = z.infer<typeof executionEventSchema>;
const executionProviderResponseEventSchema = z.discriminatedUnion("operation", [
  z
    .object({
      durationMs: durationMsSchema,
      operation: z.literal("verify"),
      outcome: z.enum([
        "accepted",
        "configuration_unavailable",
        "invalid_response",
        "provider_rejected",
        "provider_unavailable",
        "transport_error",
      ]),
      runId: runIdSchema,
      status: providerStatusSchema,
      toolCallId: toolCallIdSchema,
    })
    .strict(),
  z
    .object({
      durationMs: durationMsSchema,
      operation: z.literal("execute"),
      outcome: z.enum([
        "accepted",
        "invalid_response",
        "provider_rejected",
        "sensitive_response",
        "transport_error",
      ]),
      providerErrorCode: z.number().int().nonnegative().safe().optional(),
      runId: runIdSchema,
      status: providerStatusSchema,
      toolCallId: toolCallIdSchema,
      toolSlug: integrationToolSlugSchema,
    })
    .strict(),
]);

function rejectTelemetry(): void {
  try {
    console.warn({ event: "crewhelm.execution.telemetry_rejected" });
  } catch {
    // Diagnostic telemetry must not alter execution.
  }
}

export function recordExecutionEvent(input: unknown): void {
  let event: ReturnType<typeof executionEventSchema.safeParse> | undefined;
  try {
    event = executionEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    rejectTelemetry();
    return;
  }

  try {
    console.info({
      event: "crewhelm.execution",
      ...("toolCallId" in event.data ? { parentSpanId: event.data.runId } : {}),
      spanId: "toolCallId" in event.data ? event.data.toolCallId : event.data.runId,
      traceId: event.data.runId,
      ...event.data,
    });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}

export function recordExecutionProviderResponse(input: unknown): void {
  let event: ReturnType<typeof executionProviderResponseEventSchema.safeParse> | undefined;
  try {
    event = executionProviderResponseEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    rejectTelemetry();
    return;
  }

  try {
    console.info({
      event: "crewhelm.execution.provider_response",
      parentSpanId: event.data.runId,
      spanId: event.data.toolCallId,
      traceId: event.data.runId,
      ...event.data,
    });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}
