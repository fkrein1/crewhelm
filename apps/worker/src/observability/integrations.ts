import { connectionLinkReservationIdSchema, integrationSlugSchema } from "@crewhelm/contracts";
import * as z from "zod";

const durationMsSchema = z.number().int().nonnegative().max(30_000);
const providerStatusSchema = z.number().int().min(100).max(599);
const integrationProviderResponseEventSchema = z.discriminatedUnion("operation", [
  z
    .object({
      durationMs: durationMsSchema,
      integrationSlug: integrationSlugSchema,
      operation: z.enum(["create", "inspect_toolkit", "list", "recovery"]),
      status: providerStatusSchema,
    })
    .strict(),
  z
    .object({
      durationMs: durationMsSchema,
      operation: z.literal("link"),
      outcome: z.enum([
        "accepted",
        "invalid_connected_account_id",
        "invalid_expires_at",
        "invalid_link_token",
        "invalid_redirect_url",
        "invalid_response",
        "policy_rejected",
        "provider_rejected",
      ]),
      status: providerStatusSchema,
    })
    .strict(),
]);
const connectionLinkCompletionEventSchema = z
  .object({
    correlationId: connectionLinkReservationIdSchema.optional(),
    outcome: z.enum([
      "accepted",
      "invalid_reservation",
      "invalid_schema",
      "invalid_state",
      "invalid_url",
      "replayed",
    ]),
  })
  .strict();

export function recordIntegrationProviderResponse(input: unknown): void {
  let event: ReturnType<typeof integrationProviderResponseEventSchema.safeParse> | undefined;
  try {
    event = integrationProviderResponseEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    try {
      console.warn({ event: "crewhelm.integration.provider_response.telemetry_rejected" });
    } catch {
      // Diagnostic telemetry must not alter integration onboarding.
    }
    return;
  }

  try {
    console.info({
      event: "crewhelm.integration.provider_response",
      ...event.data,
    });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}

export function recordConnectionLinkCompletion(input: unknown): void {
  let event: ReturnType<typeof connectionLinkCompletionEventSchema.safeParse> | undefined;
  try {
    event = connectionLinkCompletionEventSchema.safeParse(input);
  } catch {
    event = undefined;
  }

  if (event === undefined || !event.success) {
    try {
      console.warn({ event: "crewhelm.integration.connection_link_completion.telemetry_rejected" });
    } catch {
      // Diagnostic telemetry must not alter integration onboarding.
    }
    return;
  }

  try {
    console.info({
      event: "crewhelm.integration.connection_link_completion",
      ...event.data,
    });
  } catch {
    // Durable audit remains authoritative if diagnostic logging is unavailable.
  }
}
