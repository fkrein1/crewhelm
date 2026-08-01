import * as z from "zod";

export const diagnosticIdSchema = z
  .string()
  .regex(
    /^diag_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm diagnostic ID.",
  );

export const diagnosticCertaintySchema = z.enum(["confirmed", "projected", "unknown"]);
export const retryDispositionSchema = z.enum([
  "contact_operator",
  "do_not_retry",
  "inspect_first",
  "retry_same_key",
  "start_new_run",
  "verify_effect",
  "wait_then_retry",
]);
export const diagnosticNextActionSchema = z.enum([
  "contact_operator",
  "inspect_connection",
  "inspect_run",
  "list_run_approvals",
  "list_unresolved_effects",
  "none",
  "review_configuration",
  "retry_request",
  "start_new_run",
  "wait",
]);
export const agentInboxDeferredReasonSchema = z.enum([
  "active_run",
  "admission_limit_exceeded",
  "agent_not_found",
  "agent_unavailable",
  "budget_exhausted",
  "brief_context_too_large",
  "brief_unavailable",
  "capability_unavailable",
  "dispatch_exception",
  "idempotency_conflict",
  "model_unavailable",
  "record_dispatch_conflict",
  "revision_conflict",
  "run_unavailable",
]);

export const compactDiagnosticSchema = z.strictObject({
  certainty: diagnosticCertaintySchema,
  disposition: retryDispositionSchema,
  id: diagnosticIdSchema.optional(),
  nextAction: diagnosticNextActionSchema,
  phase: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9._-]+$/),
  reason: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9._-]+$/),
});

export const unavailableMcpToolResultSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum([
      "control_plane_unavailable",
      "integration_provider_unavailable",
      "invalid_control_plane_response",
      "invalid_integration_response",
    ]),
    diagnostic: compactDiagnosticSchema.extend({
      id: diagnosticIdSchema,
    }),
    message: z.literal("Crewhelm request unavailable."),
  }),
  ok: z.literal(false),
});

export type CompactDiagnostic = z.infer<typeof compactDiagnosticSchema>;
export type RetryDisposition = z.infer<typeof retryDispositionSchema>;
export type UnavailableMcpToolResult = z.infer<typeof unavailableMcpToolResultSchema>;
