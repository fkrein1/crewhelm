import * as z from "zod";

import { crewAgentRuntimeConfigSchema } from "./agent-runtime.js";
import { runIdSchema, sha256DigestSchema } from "./capabilities.js";
import {
  agentExecutionLimitsSchema,
  agentIdSchema,
  agentRevisionNumberSchema,
  ownerClientIdSchema,
  ownerKeySchema,
} from "./control-plane.js";

export const RUN_ADMISSION_LIFETIME_MS = 30_000;
export const RUN_ADMISSION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const RUN_RECEIVER_CAPABILITY_LIFETIME_MS = 5_000;
export const RUN_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const MAXIMUM_RUN_ADMISSIONS_PER_OWNER = 1_000;
export const MAXIMUM_RUN_INPUT_CHARACTERS = 24 * 1_024;
export const MAXIMUM_RUN_MODEL_OUTPUT_TOKENS = 16 * 1_024;
export const MAXIMUM_RUN_OUTPUT_CHARACTERS = 64 * 1_024;
export const MAXIMUM_RUN_PROMPT_CHARACTERS = 16 * 1_024;
export const MAXIMUM_OWNER_RUN_INPUT_CHARACTERS_PER_WINDOW = 1_000_000;
export const MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW = 100;
export const MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW = 1_000_000;
export const RUNNABLE_AGENT_MODELS = ["@cf/meta/llama-4-scout-17b-16e-instruct"] as const;

export const runAdmissionIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque idempotency key.");
export const runAdmissionNonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, "Expected an opaque run-admission nonce.");
export const runBudgetReservationIdSchema = z
  .string()
  .regex(
    /^budget_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque run-budget reservation ID.",
  );
export const runPromptSchema = z.string().min(1).max(MAXIMUM_RUN_PROMPT_CHARACTERS);
export const runOutputSchema = z.string().max(MAXIMUM_RUN_OUTPUT_CHARACTERS);
export const runnableAgentModelSchema = z.enum(RUNNABLE_AGENT_MODELS);

export const runStatusSchema = z.enum(["queued", "running", "completed", "cancelled", "failed"]);

export const createRunAdmissionInputSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedRevision: agentRevisionNumberSchema,
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  promptCharacters: z.number().int().min(1).max(MAXIMUM_RUN_PROMPT_CHARACTERS),
  promptDigest: sha256DigestSchema,
});

export const runBudgetReservationSchema = z.strictObject({
  maxDurationSeconds: agentExecutionLimitsSchema.shape.maxDurationSeconds,
  maxInputCharacters: z.number().int().min(1).max(MAXIMUM_RUN_INPUT_CHARACTERS),
  maxModelCalls: z.literal(1),
  model: runnableAgentModelSchema,
  maxOutputTokens: z.number().int().min(1).max(MAXIMUM_RUN_MODEL_OUTPUT_TOKENS),
  maxToolCalls: z.literal(0),
  maxTurns: z.literal(1),
  reservationId: runBudgetReservationIdSchema,
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
    "admission_limit_exceeded",
    "budget_exhausted",
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

export const runReceiverCapabilitySchema = z.discriminatedUnion("action", [
  resumeRunCapabilitySchema,
  inspectRunCapabilitySchema,
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
  permit: runAdmissionPermitSchema,
  prompt: runPromptSchema,
});

export const resumeRunAdmissionInputSchema = z.strictObject({
  capability: resumeRunCapabilitySchema,
  prompt: runPromptSchema,
});

export const acceptRunAdmissionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    accepted: z.boolean(),
    agentId: agentIdSchema,
    agentRevision: agentRevisionNumberSchema,
    ok: z.literal(true),
    runId: runIdSchema,
  }),
  invalidRunAdmissionSchema,
]);

export const startRunInputSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedRevision: agentRevisionNumberSchema,
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  prompt: runPromptSchema,
});

export const inspectRunInputSchema = z.strictObject({
  runId: runIdSchema,
});

export const inspectAdmittedRunInputSchema = z.strictObject({
  capability: inspectRunCapabilitySchema,
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
});

export const verifyActiveRunAdmissionResultSchema = redeemRunReceiverCapabilityResultSchema;

export const runSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  completedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  output: runOutputSchema.optional(),
  outputTruncated: z.boolean().optional(),
  runId: runIdSchema,
  startedAt: z.iso.datetime().optional(),
  status: runStatusSchema,
});

const runRequestErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "admission_limit_exceeded",
    "budget_exhausted",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "model_unavailable",
    "owner_mismatch",
    "revision_conflict",
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
    ok: z.literal(true),
    run: runSchema,
  }),
  z.strictObject({
    error: runReadErrorSchema,
    ok: z.literal(false),
  }),
]);

export const inspectAdmittedRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    run: runSchema,
  }),
  invalidRunAdmissionSchema,
]);

export type AcceptRunAdmissionInput = z.infer<typeof acceptRunAdmissionInputSchema>;
export type AcceptRunAdmissionResult = z.infer<typeof acceptRunAdmissionResultSchema>;
export type ConfirmRunAdmissionResult = z.infer<typeof confirmRunAdmissionResultSchema>;
export type CreateRunAdmissionInput = z.infer<typeof createRunAdmissionInputSchema>;
export type CreateRunAdmissionResult = z.infer<typeof createRunAdmissionResultSchema>;
export type InspectAdmittedRunResult = z.infer<typeof inspectAdmittedRunResultSchema>;
export type InspectRunCapability = z.infer<typeof inspectRunCapabilitySchema>;
export type InspectRunResult = z.infer<typeof inspectRunResultSchema>;
export type RedeemRunReceiverCapabilityResult = z.infer<
  typeof redeemRunReceiverCapabilityResultSchema
>;
export type Run = z.infer<typeof runSchema>;
export type RunAdmissionPermit = z.infer<typeof runAdmissionPermitSchema>;
export type RunAdmissionSummary = z.infer<typeof runAdmissionSummarySchema>;
export type RunBudgetReservation = z.infer<typeof runBudgetReservationSchema>;
export type RunReceiverCapability = z.infer<typeof runReceiverCapabilitySchema>;
export type ResumeRunAdmissionInput = z.infer<typeof resumeRunAdmissionInputSchema>;
export type ResumeRunCapability = z.infer<typeof resumeRunCapabilitySchema>;
export type StartRunResult = z.infer<typeof startRunResultSchema>;
export type VerifyActiveRunAdmissionResult = z.infer<typeof verifyActiveRunAdmissionResultSchema>;
export type VerifyRunAdmissionResult = z.infer<typeof verifyRunAdmissionResultSchema>;
