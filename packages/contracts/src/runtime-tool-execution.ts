import * as z from "zod";

import { sandboxCodeRuntimeToolSchema, sandboxCodeLanguageSchema } from "./agent-runtime.js";
import { sha256DigestSchema, toolCallIdSchema } from "./capabilities.js";
import { agentIdSchema, agentRevisionNumberSchema, ownerKeySchema } from "./control-plane.js";
import { runAdmissionNonceSchema, verifyActiveRunAdmissionInputSchema } from "./run-admission.js";

export const RUNTIME_TOOL_EXECUTION_PERMIT_LIFETIME_MS = 5_000;
// The Sandbox SDK keeps a 120-second transport retry floor even with bounded container startup.
// Owner recovery therefore repeats exact cleanup through that window plus startup and teardown
// margin before it considers the per-call Sandbox durably gone.
export const RUNTIME_TOOL_LATE_OPEN_CLEANUP_HORIZON_MS = 180_000;

export const classifiedSandboxCodeActionSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  codeDigest: sha256DigestSchema,
  language: sandboxCodeLanguageSchema,
  ownerKey: ownerKeySchema,
  runId: verifyActiveRunAdmissionInputSchema.shape.runId,
  tool: sandboxCodeRuntimeToolSchema,
  toolCallId: toolCallIdSchema,
});

export const reserveRuntimeToolExecutionInputSchema = verifyActiveRunAdmissionInputSchema.extend({
  action: classifiedSandboxCodeActionSchema,
});

const invalidRuntimeToolExecutionSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("invalid_execution"),
    message: z.literal("Runtime tool execution denied."),
  }),
  ok: z.literal(false),
});

export const runtimeToolExecutionPermitSchema = z.strictObject({
  action: classifiedSandboxCodeActionSchema,
  actionDigest: sha256DigestSchema,
  audience: z.literal("crew_session_runtime_tool"),
  constraints: z.strictObject({
    decisionExpiresAt: z.iso.datetime(),
    maxDurationMs: sandboxCodeRuntimeToolSchema.shape.limits.shape.maxDurationMs,
    maxOutputBytes: sandboxCodeRuntimeToolSchema.shape.limits.shape.maxOutputBytes,
  }),
  nonce: runAdmissionNonceSchema,
});

export const reserveRuntimeToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    permit: runtimeToolExecutionPermitSchema,
  }),
  invalidRuntimeToolExecutionSchema,
]);

export const dispatchRuntimeToolExecutionInputSchema = z.strictObject({
  permit: runtimeToolExecutionPermitSchema,
});

export const dispatchRuntimeToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    dispatched: z.boolean(),
    ok: z.literal(true),
  }),
  invalidRuntimeToolExecutionSchema,
]);

export const completeRuntimeToolExecutionInputSchema = z.strictObject({
  outcome: z.strictObject({
    outputBytes: z.number().int().min(0),
    status: z.enum(["completed", "failed", "unknown"]),
  }),
  permit: runtimeToolExecutionPermitSchema,
});

export const completeRuntimeToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    completed: z.boolean(),
    ok: z.literal(true),
  }),
  invalidRuntimeToolExecutionSchema,
]);

export type ClassifiedSandboxCodeAction = z.infer<typeof classifiedSandboxCodeActionSchema>;
export type CompleteRuntimeToolExecutionResult = z.infer<
  typeof completeRuntimeToolExecutionResultSchema
>;
export type DispatchRuntimeToolExecutionResult = z.infer<
  typeof dispatchRuntimeToolExecutionResultSchema
>;
export type ReserveRuntimeToolExecutionResult = z.infer<
  typeof reserveRuntimeToolExecutionResultSchema
>;
export type RuntimeToolExecutionPermit = z.infer<typeof runtimeToolExecutionPermitSchema>;
