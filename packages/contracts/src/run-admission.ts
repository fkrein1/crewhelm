import * as z from "zod";

import {
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
  MAXIMUM_FLEET_LIST_ITEMS,
  MAXIMUM_FLEET_RETENTION_SECONDS,
  MINIMUM_FLEET_RETENTION_SECONDS,
} from "./fleet-capacity.js";

import {
  admittedSkillProvenanceSchema,
  agentRuntimePlanSchema,
  crewAgentRuntimeConfigSchema,
} from "./agent-runtime.js";
import {
  composioToolCapabilityGrantSchema,
  runIdSchema,
  sha256DigestSchema,
  toolCallIdSchema,
  toolExecutionEvaluationFailureReasonSchema,
  toolGateDenialReasonSchema,
} from "./capabilities.js";
import {
  agentExecutionLimitsSchema,
  agentIdSchema,
  agentModelSchema,
  agentRevisionNumberSchema,
  ownerClientIdSchema,
  ownerKeySchema,
} from "./control-plane.js";
import { agentScheduleRevisionNumberSchema } from "./schedule-revision.js";
import {
  compactDiagnosticSchema,
  diagnosticCertaintySchema,
  diagnosticNextActionSchema,
  retryDispositionSchema,
} from "./diagnostics.js";
import { runSessionSchema, sessionContinuationSchema } from "./agent-sessions.js";
import {
  DEFAULT_RUNNABLE_AGENT_MODEL,
  RUNNABLE_AGENT_MODELS,
  runnableAgentModelSchema,
} from "./inference.js";

export const RUN_ADMISSION_LIFETIME_MS = 30_000;
export const RUN_ADMISSION_RETENTION_MS = DEFAULT_FLEET_RUN_RETENTION_SECONDS * 1_000;
export const RUN_RECEIVER_CAPABILITY_LIFETIME_MS = 5_000;
export const RUN_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAXIMUM_RUN_ADMISSIONS_PER_OWNER = 1_000;
export const MAXIMUM_RUN_INPUT_CHARACTERS = 24 * 1_024;
export const MAXIMUM_RUN_MODEL_OUTPUT_TOKENS = 16 * 1_024;
export const MAXIMUM_RUN_OUTPUT_CHARACTERS = 64 * 1_024;
export const MAXIMUM_RUN_PROMPT_CHARACTERS = 16 * 1_024;
export const MAXIMUM_RUN_TIMELINE_EVENTS = 1_024;
export const MAXIMUM_RUN_TIMELINE_PAGE_ITEMS = 50;
export const runAdmissionIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque idempotency key.");
export const runAdmissionNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected an opaque run-admission nonce.");
export const toolApprovalExecutionIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._:~-]+$/, "Expected an opaque tool approval execution ID.");
export const runBudgetReservationIdSchema = z
  .string()
  .regex(
    /^budget_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque run-budget reservation ID.",
  );
export const runPromptSchema = z.string().min(1).max(MAXIMUM_RUN_PROMPT_CHARACTERS);
export const runOutputSchema = z.string().max(MAXIMUM_RUN_OUTPUT_CHARACTERS);
export { DEFAULT_RUNNABLE_AGENT_MODEL, RUNNABLE_AGENT_MODELS, runnableAgentModelSchema };
export const runIntegrationLimitsSchema = z.strictObject({
  callsPerDay: z.number().int().min(1).max(1_000_000),
  callsPerThirtyDays: z.number().int().min(1).max(1_000_000),
  duplicateToolCallLimit: z.number().int().min(1).max(100),
  maxCallsPerRun: z.number().int().min(1).max(100),
  maxCallsPerToolPerRun: z.number().int().min(1).max(100),
  maxConcurrencyPerGrant: z.number().int().min(1).max(16),
});

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
]);
export const runTriggerSchema = z.enum(["manual", "schedule"]);

export const createRunAdmissionInputSchema = z
  .strictObject({
    agentId: agentIdSchema,
    continuation: sessionContinuationSchema.optional(),
    expectedRevision: agentRevisionNumberSchema,
    idempotencyKey: runAdmissionIdempotencyKeySchema,
    prompt: runPromptSchema.optional(),
    promptCharacters: z.number().int().min(1).max(MAXIMUM_RUN_PROMPT_CHARACTERS),
    promptDigest: sha256DigestSchema,
    scheduleRevision: agentScheduleRevisionNumberSchema.nullable().default(null),
    trigger: runTriggerSchema.default("manual"),
  })
  .superRefine((input, context) => {
    if (input.prompt !== undefined && input.prompt.length !== input.promptCharacters) {
      context.addIssue({
        code: "custom",
        message: "Prompt character count must match the admitted prompt.",
        path: ["promptCharacters"],
      });
    }

    if (
      (input.trigger === "manual" && input.scheduleRevision !== null) ||
      (input.trigger === "schedule" && input.scheduleRevision === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Schedule revision must match the run trigger.",
        path: ["scheduleRevision"],
      });
    }
  });

export const runBudgetReservationSchema = z.strictObject({
  fleetConfigurationRevision: z.number().int().positive().safe(),
  integrationLimits: runIntegrationLimitsSchema,
  maxDurationSeconds: agentExecutionLimitsSchema.shape.maxDurationSeconds,
  maxInputCharacters: z.number().int().min(1).max(MAXIMUM_RUN_INPUT_CHARACTERS),
  maxModelCalls: z.number().int().min(1).max(100),
  runtimePlan: agentRuntimePlanSchema,
  maxOutputTokens: z.number().int().min(1).max(MAXIMUM_RUN_MODEL_OUTPUT_TOKENS),
  maxToolCalls: agentExecutionLimitsSchema.shape.maxToolCalls,
  maxTurns: agentExecutionLimitsSchema.shape.maxTurns,
  reservationId: runBudgetReservationIdSchema,
  retentionSeconds: z
    .number()
    .int()
    .min(MINIMUM_FLEET_RETENTION_SECONDS)
    .max(MAXIMUM_FLEET_RETENTION_SECONDS)
    .default(DEFAULT_FLEET_RUN_RETENTION_SECONDS),
  toolGrants: z
    .array(composioToolCapabilityGrantSchema)
    .max(100)
    .refine(
      (grants) =>
        grants.every(
          (grant, index) => index === 0 || (grants[index - 1]?.grantId ?? "") < grant.grantId,
        ),
      "Expected unique tool grants in canonical order.",
    ),
});

export const runAdmissionPermitSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  budgetReservation: runBudgetReservationSchema,
  clientId: ownerClientIdSchema,
  expiresAt: z.iso.datetime(),
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  nonce: runAdmissionNonceSchema,
  ownerKey: ownerKeySchema,
  promptDigest: sha256DigestSchema,
  runId: runIdSchema,
  scheduleRevision: agentScheduleRevisionNumberSchema.nullable().default(null),
});

export const aiGatewayLogIdSchema = z.string().trim().min(1).max(255);
export const runUsageReferenceSchema = runAdmissionPermitSchema.omit({
  expiresAt: true,
  nonce: true,
});
export const recordAiGatewayCallInputSchema = z.strictObject({
  gatewayLogId: aiGatewayLogIdSchema,
  reference: runUsageReferenceSchema,
});

export const runAdmissionSummarySchema = runAdmissionPermitSchema
  .omit({
    budgetReservation: true,
    clientId: true,
    idempotencyKey: true,
    nonce: true,
    ownerKey: true,
    promptDigest: true,
  })
  .extend({
    status: z.enum(["expired", "redeemed"]),
  });

const runAdmissionRequestErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_unavailable",
    "admission_limit_exceeded",
    "budget_exhausted",
    "capability_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "model_unavailable",
    "owner_mismatch",
    "revision_conflict",
  ]),
  message: z.literal("Run admission denied."),
});

const invalidRunAdmissionSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("invalid_admission"),
    message: z.literal("Run admission denied."),
  }),
  ok: z.literal(false),
});

export const createRunAdmissionResultSchema = z.union([
  z.strictObject({
    created: z.boolean(),
    ok: z.literal(true),
    permit: runAdmissionPermitSchema,
    state: z.literal("issued"),
  }),
  z.strictObject({
    admission: runAdmissionSummarySchema,
    created: z.literal(false),
    ok: z.literal(true),
    state: z.enum(["expired", "redeemed"]),
  }),
  z.strictObject({
    error: runAdmissionRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export const verifyRunAdmissionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    configuration: crewAgentRuntimeConfigSchema,
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  invalidRunAdmissionSchema,
]);

const runReceiverCapabilityBaseSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  audience: z.literal("crew_agent"),
  budgetReservation: runBudgetReservationSchema,
  clientId: ownerClientIdSchema,
  connection: z.literal("none"),
  effect: z.literal("none"),
  expiresAt: z.iso.datetime(),
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  nonce: runAdmissionNonceSchema,
  ownerKey: ownerKeySchema,
  promptDigest: sha256DigestSchema,
  runId: runIdSchema,
  scheduleRevision: agentScheduleRevisionNumberSchema.nullable().default(null),
  target: z.literal("none"),
});

export const resumeRunCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("resume"),
  capability: z.literal("run:resume"),
});

export const inspectRunCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("inspect"),
  capability: z.literal("run:inspect"),
});

export const cancelRunCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("cancel"),
  capability: z.literal("run:cancel"),
});

export const listRunApprovalsCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("list_approvals"),
  capability: z.literal("run:approvals:read"),
});

export const approveRunToolCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("approve_tool"),
  capability: z.literal("run:approvals:approve"),
  executionId: toolApprovalExecutionIdSchema,
});

export const rejectRunToolCapabilitySchema = runReceiverCapabilityBaseSchema.extend({
  action: z.literal("reject_tool"),
  capability: z.literal("run:approvals:reject"),
  executionId: toolApprovalExecutionIdSchema,
});

export const runReceiverCapabilitySchema = z.discriminatedUnion("action", [
  resumeRunCapabilitySchema,
  inspectRunCapabilitySchema,
  cancelRunCapabilitySchema,
  listRunApprovalsCapabilitySchema,
  approveRunToolCapabilitySchema,
  rejectRunToolCapabilitySchema,
]);

export const redeemRunReceiverCapabilityResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  invalidRunAdmissionSchema,
]);

export const confirmRunAdmissionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    confirmed: z.boolean(),
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  invalidRunAdmissionSchema,
]);

export const acceptRunAdmissionInputSchema = z.strictObject({
  continuation: sessionContinuationSchema.optional(),
  permit: runAdmissionPermitSchema,
  prompt: runPromptSchema,
  session: runSessionSchema.optional(),
});

export const resumeRunAdmissionInputSchema = z.strictObject({
  capability: resumeRunCapabilitySchema,
  continuation: sessionContinuationSchema.optional(),
  prompt: runPromptSchema,
  session: runSessionSchema.optional(),
});

export const acceptRunAdmissionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    accepted: z.boolean(),
    agentId: agentIdSchema,
    agentRevision: agentRevisionNumberSchema,
    ok: z.literal(true),
    runId: runIdSchema,
    session: runSessionSchema.optional(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "branch_revision_conflict",
        "invalid_admission",
        "session_busy",
        "session_not_found",
      ]),
      message: z.literal("Run admission denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const startRunInputSchema = z.strictObject({
  agentId: agentIdSchema,
  continuation: sessionContinuationSchema
    .describe("Continue one exact durable Agent session. Omit to create a new session.")
    .optional(),
  expectedRevision: agentRevisionNumberSchema,
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  prompt: runPromptSchema,
});

export const inspectRunInputSchema = z.strictObject({
  includeUsage: z
    .boolean()
    .default(true)
    .describe("Include compact admitted and consumed run usage."),
  runId: runIdSchema,
  timelineCursor: z.number().int().nonnegative().safe().default(0),
  timelineLimit: z.number().int().min(1).max(MAXIMUM_RUN_TIMELINE_PAGE_ITEMS).default(20),
});

export const cancelRunInputSchema = z.strictObject({
  runId: runIdSchema,
});

export const inspectAdmittedRunInputSchema = z.strictObject({
  capability: inspectRunCapabilitySchema,
});

export const cancelAdmittedRunInputSchema = z.strictObject({
  capability: cancelRunCapabilitySchema,
});

export const verifyActiveRunAdmissionInputSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  budgetReservation: runBudgetReservationSchema,
  clientId: ownerClientIdSchema,
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  ownerKey: ownerKeySchema,
  promptDigest: sha256DigestSchema,
  runId: runIdSchema,
  scheduleRevision: agentScheduleRevisionNumberSchema.nullable().default(null),
});

export const verifyActiveRunAdmissionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    modelCall: z.number().int().min(1).max(100),
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  invalidRunAdmissionSchema,
]);

export const runSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  completedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  output: runOutputSchema.optional(),
  outputTruncated: z.boolean().optional(),
  runId: runIdSchema,
  session: runSessionSchema.optional(),
  startedAt: z.iso.datetime().optional(),
  status: runStatusSchema,
  trigger: runTriggerSchema.default("manual"),
});

export const runSummarySchema = runSchema.omit({
  output: true,
  outputTruncated: true,
});

export const listAgentRunsInputSchema = z
  .strictObject({
    agentId: agentIdSchema.optional().describe("Return runs for one exact Agent."),
    createdAfter: z.iso
      .datetime()
      .optional()
      .describe("Return runs created at or after this time."),
    createdBefore: z.iso
      .datetime()
      .optional()
      .describe("Return runs created at or before this time."),
    cursor: runIdSchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(10),
    status: runStatusSchema.optional().describe("Return runs in this owner-local projected state."),
    trigger: runTriggerSchema.optional().describe("Return manual or scheduled runs."),
  })
  .refine(
    (input) =>
      input.createdAfter === undefined ||
      input.createdBefore === undefined ||
      Date.parse(input.createdAfter) <= Date.parse(input.createdBefore),
    "createdAfter must not be later than createdBefore.",
  );

export const toolProviderFailureSchema = z.strictObject({
  errorCode: z.number().int().nonnegative().safe().optional(),
  outcome: z.enum([
    "invalid_response",
    "provider_rejected",
    "sensitive_response",
    "transport_error",
  ]),
  status: z.number().int().min(100).max(599).nullable(),
  toolSlug: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Z0-9_]+$/),
});

const runStateTimelineEventSchema = z
  .strictObject({
    event: z.enum([
      "run.admitted",
      "run.started",
      "tool.approval_required",
      "tool.approval_approved",
      "tool.approval_expired",
      "tool.approval_rejected",
      "tool.execution_reserved",
      "tool.execution_dispatched",
      "tool.execution_completed",
      "tool.execution_failed",
      "tool.provider_failed",
      "tool.execution_unknown",
      "tool.execution_reconciled_applied",
      "tool.execution_reconciled_not_applied",
      "run.cancellation_requested",
      "run.cancelled",
      "run.completed",
      "run.failed",
    ]),
    occurredAt: z.iso.datetime(),
    provider: toolProviderFailureSchema.optional(),
    toolCallId: toolCallIdSchema.optional(),
  })
  .superRefine((event, context) => {
    if ((event.event === "tool.provider_failed") !== (event.provider !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Provider failure events require only bounded provider diagnostics.",
        path: ["provider"],
      });
    }
  });
const localToolAuthorizationFailureReasonSchema = z.enum([
  "action_invalid",
  "action_unavailable",
  "policy_decision_mismatch",
  "policy_response_invalid",
  "policy_unavailable",
  "run_unavailable",
]);
export const toolAuthorizationFailureReasonSchema = z.union([
  toolGateDenialReasonSchema,
  toolExecutionEvaluationFailureReasonSchema,
  localToolAuthorizationFailureReasonSchema,
]);
export const toolAuthorizationTimelineEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("tool.authorization_allowed"),
    occurredAt: z.iso.datetime(),
    toolCallId: toolCallIdSchema,
  }),
  z.strictObject({
    event: z.literal("tool.authorization_approval_required"),
    occurredAt: z.iso.datetime(),
    toolCallId: toolCallIdSchema,
  }),
  z.strictObject({
    event: z.literal("tool.authorization_blocked"),
    occurredAt: z.iso.datetime(),
    reason: toolAuthorizationFailureReasonSchema,
    toolCallId: toolCallIdSchema,
  }),
]);
export const inferenceAvailabilityFailureSchema = z.enum([
  "provider_unavailable",
  "rate_limited",
  "timeout",
  "transport_unavailable",
]);
export const inferenceTimelineEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("inference.attempt_failed"),
    model: agentModelSchema,
    modelCall: z.number().int().min(1).max(100),
    occurredAt: z.iso.datetime(),
    reason: inferenceAvailabilityFailureSchema,
  }),
  z.strictObject({
    event: z.literal("inference.model_selected"),
    model: agentModelSchema,
    modelCall: z.number().int().min(1).max(100),
    occurredAt: z.iso.datetime(),
  }),
]);
export const runTimelineEventSchema = z.union([
  inferenceTimelineEventSchema,
  runStateTimelineEventSchema,
  toolAuthorizationTimelineEventSchema,
]);

export const runFailureReasonSchema = z.enum([
  "admission_expired",
  "authorization_blocked",
  "deadline_exceeded",
  "runtime_failed",
  "skill_unavailable",
  "tool_effect_applied",
  "tool_effect_not_applied",
  "tool_effect_unknown",
  "tool_execution_failed",
  "tool_provider_failed",
]);

export const runDiagnosticSchema = compactDiagnosticSchema.extend({
  certainty: diagnosticCertaintySchema,
  disposition: retryDispositionSchema,
  nextAction: diagnosticNextActionSchema,
  phase: z.enum(["run.admission", "run.runtime", "tool.authorization", "tool.execution"]),
  reason: runFailureReasonSchema,
  toolCallId: toolCallIdSchema.optional(),
});

export const runUsageSchema = z.strictObject({
  ai: z.strictObject({
    calls: z.number().int().nonnegative().safe(),
    costMicrousd: z.number().int().nonnegative().safe(),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    settlement: z.enum(["not_configured", "pending", "settled"]),
  }),
  modelCalls: z.strictObject({
    limit: z.number().int().positive().safe(),
    used: z.number().int().nonnegative().safe(),
  }),
  toolCalls: z.strictObject({
    limit: z.number().int().nonnegative().safe(),
    used: z.number().int().nonnegative().safe(),
  }),
});

export const runRetentionSchema = z.strictObject({
  availableUntil: z.iso.datetime(),
  output: z.strictObject({
    limitCharacters: z.number().int().positive().safe(),
    retainedCharacters: z.number().int().nonnegative().safe(),
    truncated: z.boolean(),
  }),
});

const runRequestErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_unavailable",
    "admission_limit_exceeded",
    "budget_exhausted",
    "capability_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "model_unavailable",
    "owner_mismatch",
    "revision_conflict",
    "branch_revision_conflict",
    "session_busy",
    "session_not_found",
    "run_unavailable",
  ]),
  message: z.literal("Run request denied."),
});

const runReadErrorSchema = z.strictObject({
  code: z.enum([
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "run_not_found",
    "run_unavailable",
  ]),
  message: z.literal("Run request denied."),
});

export const startRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    created: z.boolean(),
    ok: z.literal(true),
    run: runSchema,
  }),
  z.strictObject({
    error: runRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export const inspectRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    diagnosis: runDiagnosticSchema.nullable(),
    ok: z.literal(true),
    request: z.strictObject({
      prompt: runPromptSchema.nullable(),
    }),
    retention: runRetentionSchema,
    run: runSchema,
    skills: z.array(admittedSkillProvenanceSchema).max(8).default([]),
    timeline: z.array(runTimelineEventSchema).max(MAXIMUM_RUN_TIMELINE_PAGE_ITEMS),
    timelinePage: z.strictObject({
      nextCursor: z.number().int().nonnegative().safe().nullable(),
      omittedEvents: z.number().int().nonnegative().safe(),
      startSequence: z.number().int().nonnegative().safe(),
      totalEvents: z.number().int().nonnegative().safe(),
      truncated: z.boolean(),
    }),
    usage: runUsageSchema.nullable(),
  }),
  z.strictObject({
    error: runReadErrorSchema,
    ok: z.literal(false),
  }),
]);

export const listAgentRunsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    nextCursor: runIdSchema.nullable(),
    ok: z.literal(true),
    runs: z.array(runSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
  }),
  z.strictObject({
    error: runReadErrorSchema,
    ok: z.literal(false),
  }),
]);

export const cancelRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    cancelled: z.literal(true),
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "run_not_cancellable",
        "run_not_found",
        "run_unavailable",
      ]),
      message: z.literal("Run cancellation denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const cancelAdmittedRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    cancelled: z.boolean(),
    ok: z.literal(true),
  }),
  invalidRunAdmissionSchema,
]);

export const inspectAdmittedRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    run: runSchema,
    trace: z.array(runTimelineEventSchema).max(MAXIMUM_RUN_TIMELINE_EVENTS).default([]),
  }),
  invalidRunAdmissionSchema,
]);

export type AcceptRunAdmissionInput = z.infer<typeof acceptRunAdmissionInputSchema>;
export type AcceptRunAdmissionResult = z.infer<typeof acceptRunAdmissionResultSchema>;
export type CancelRunCapability = z.infer<typeof cancelRunCapabilitySchema>;
export type CancelRunResult = z.infer<typeof cancelRunResultSchema>;
export type ConfirmRunAdmissionResult = z.infer<typeof confirmRunAdmissionResultSchema>;
export type CreateRunAdmissionInput = z.infer<typeof createRunAdmissionInputSchema>;
export type CreateRunAdmissionResult = z.infer<typeof createRunAdmissionResultSchema>;
export type InspectAdmittedRunResult = z.infer<typeof inspectAdmittedRunResultSchema>;
export type InspectRunCapability = z.infer<typeof inspectRunCapabilitySchema>;
export type ListRunApprovalsCapability = z.infer<typeof listRunApprovalsCapabilitySchema>;
export type InspectRunResult = z.infer<typeof inspectRunResultSchema>;
export type ListAgentRunsInput = z.infer<typeof listAgentRunsInputSchema>;
export type ListAgentRunsResult = z.infer<typeof listAgentRunsResultSchema>;
export type RedeemRunReceiverCapabilityResult = z.infer<
  typeof redeemRunReceiverCapabilityResultSchema
>;
export type RecordAiGatewayCallInput = z.infer<typeof recordAiGatewayCallInputSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunDiagnostic = z.infer<typeof runDiagnosticSchema>;
export type RunSummary = z.infer<typeof runSummarySchema>;
export type RunAdmissionPermit = z.infer<typeof runAdmissionPermitSchema>;
export type RunAdmissionSummary = z.infer<typeof runAdmissionSummarySchema>;
export type RunBudgetReservation = z.infer<typeof runBudgetReservationSchema>;
export type RunReceiverCapability = z.infer<typeof runReceiverCapabilitySchema>;
export type RunTrigger = z.infer<typeof runTriggerSchema>;
export type RunTimelineEvent = z.infer<typeof runTimelineEventSchema>;
export type RunUsage = z.infer<typeof runUsageSchema>;
export type ResumeRunAdmissionInput = z.infer<typeof resumeRunAdmissionInputSchema>;
export type ResumeRunCapability = z.infer<typeof resumeRunCapabilitySchema>;
export type StartRunResult = z.infer<typeof startRunResultSchema>;
export type ToolAuthorizationTimelineEvent = z.infer<typeof toolAuthorizationTimelineEventSchema>;
export type VerifyActiveRunAdmissionResult = z.infer<typeof verifyActiveRunAdmissionResultSchema>;
export type VerifyRunAdmissionResult = z.infer<typeof verifyRunAdmissionResultSchema>;
