import * as z from "zod";

import {
  classifiedComposioToolActionSchema,
  sha256DigestSchema,
  toolGateDecisionSchema,
} from "./capabilities.js";
import {
  approveRunToolCapabilitySchema,
  listRunApprovalsCapabilitySchema,
  rejectRunToolCapabilitySchema,
  runAdmissionNonceSchema,
  toolApprovalExecutionIdSchema,
  verifyActiveRunAdmissionInputSchema,
} from "./run-admission.js";
import { composioConnectedAccountIdSchema } from "./connections.js";

export const TOOL_EXECUTION_PERMIT_LIFETIME_MS = 5_000;
export const TOOL_APPROVAL_LIFETIME_MS = 15 * 60 * 1_000;
export const MAXIMUM_TOOL_APPROVALS_PER_RUN = 100;

export const evaluateToolExecutionInputSchema = verifyActiveRunAdmissionInputSchema.extend({
  action: classifiedComposioToolActionSchema,
});

const invalidToolExecutionSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("invalid_execution"),
    message: z.literal("Tool execution denied."),
  }),
  ok: z.literal(false),
});

export const evaluateToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    decision: toolGateDecisionSchema,
    ok: z.literal(true),
  }),
  invalidToolExecutionSchema,
]);

export const toolExecutionPermitSchema = z.strictObject({
  action: classifiedComposioToolActionSchema,
  actionDigest: sha256DigestSchema,
  audience: z.literal("composio_adapter"),
  constraints: z.strictObject({
    decisionExpiresAt: z.iso.datetime(),
    maxCostMicrousd: z.number().int().min(0).safe(),
    maxDurationMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
  }),
  nonce: runAdmissionNonceSchema,
});

export const reserveToolExecutionInputSchema = evaluateToolExecutionInputSchema;
export const reserveToolExecutionResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    permit: toolExecutionPermitSchema,
    state: z.literal("allowed"),
  }),
  z.strictObject({
    actionDigest: sha256DigestSchema,
    effect: z.enum(["write", "destructive"]),
    ok: z.literal(true),
    state: z.literal("requires_approval"),
  }),
  invalidToolExecutionSchema,
]);

export const completeToolExecutionInputSchema = z.strictObject({
  outcome: z.strictObject({
    outputBytes: z.number().int().min(0),
    status: z.enum(["completed", "failed", "unknown"]),
  }),
  permit: toolExecutionPermitSchema,
});

export const completeToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    completed: z.boolean(),
    ok: z.literal(true),
  }),
  invalidToolExecutionSchema,
]);

export const resolveToolExecutionConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    providerConnectionId: composioConnectedAccountIdSchema,
  }),
  invalidToolExecutionSchema,
]);

export const pendingToolApprovalSchema = z.strictObject({
  action: z.string().min(1).max(160),
  actionDigest: sha256DigestSchema,
  effect: z.enum(["write", "destructive"]),
  executionId: toolApprovalExecutionIdSchema,
  expiresAt: z.iso.datetime(),
  grantId: classifiedComposioToolActionSchema.shape.grantId,
  requestedAt: z.iso.datetime(),
  risk: z.enum(["medium", "high"]),
  summary: z.string().min(1).max(240),
  toolCallId: classifiedComposioToolActionSchema.shape.toolCallId,
});

export const listRunToolApprovalsInputSchema = z.strictObject({
  runId: classifiedComposioToolActionSchema.shape.runId,
});

export const listRunToolApprovalsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    approvals: z.array(pendingToolApprovalSchema).max(MAXIMUM_TOOL_APPROVALS_PER_RUN),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "run_not_found",
        "run_unavailable",
      ]),
      message: z.literal("Tool approval request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const decideRunToolApprovalInputSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  executionId: toolApprovalExecutionIdSchema,
  runId: classifiedComposioToolActionSchema.shape.runId,
});

export const decideRunToolApprovalResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    decided: z.boolean(),
    decision: z.enum(["approve", "reject"]),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "approval_not_found",
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "run_not_found",
        "run_unavailable",
      ]),
      message: z.literal("Tool approval request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const listAdmittedRunToolApprovalsInputSchema = z.strictObject({
  capability: listRunApprovalsCapabilitySchema,
});

export const listAdmittedRunToolApprovalsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    approvals: z.array(pendingToolApprovalSchema).max(MAXIMUM_TOOL_APPROVALS_PER_RUN),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.literal("invalid_admission"),
      message: z.literal("Run admission denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const decideAdmittedRunToolApprovalInputSchema = z.strictObject({
  capability: z.discriminatedUnion("action", [
    approveRunToolCapabilitySchema,
    rejectRunToolCapabilitySchema,
  ]),
});

export const decideAdmittedRunToolApprovalResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    decided: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.literal("invalid_admission"),
      message: z.literal("Run admission denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type CompleteToolExecutionResult = z.infer<typeof completeToolExecutionResultSchema>;
export type DecideRunToolApprovalResult = z.infer<typeof decideRunToolApprovalResultSchema>;
export type EvaluateToolExecutionResult = z.infer<typeof evaluateToolExecutionResultSchema>;
export type ListRunToolApprovalsResult = z.infer<typeof listRunToolApprovalsResultSchema>;
export type PendingToolApproval = z.infer<typeof pendingToolApprovalSchema>;
export type ReserveToolExecutionResult = z.infer<typeof reserveToolExecutionResultSchema>;
export type ResolveToolExecutionConnectionResult = z.infer<
  typeof resolveToolExecutionConnectionResultSchema
>;
export type ToolExecutionPermit = z.infer<typeof toolExecutionPermitSchema>;
