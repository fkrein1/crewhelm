import * as z from "zod";

import {
  sandboxCodeLanguageSchema,
  sandboxCodeRuntimeToolSchema,
  webFetchRuntimeToolSchema,
  webSearchRuntimeToolSchema,
} from "./agent-runtime.js";
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
  inputDigest: sha256DigestSchema,
  language: sandboxCodeLanguageSchema,
  ownerKey: ownerKeySchema,
  runId: verifyActiveRunAdmissionInputSchema.shape.runId,
  tool: sandboxCodeRuntimeToolSchema,
  toolCallId: toolCallIdSchema,
});

export const classifiedWebFetchActionSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  inputDigest: sha256DigestSchema,
  ownerKey: ownerKeySchema,
  runId: verifyActiveRunAdmissionInputSchema.shape.runId,
  tool: webFetchRuntimeToolSchema,
  toolCallId: toolCallIdSchema,
});

export const classifiedWebSearchActionSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  inputDigest: sha256DigestSchema,
  ownerKey: ownerKeySchema,
  runId: verifyActiveRunAdmissionInputSchema.shape.runId,
  tool: webSearchRuntimeToolSchema,
  toolCallId: toolCallIdSchema,
});

export const classifiedRuntimeToolActionSchema = z.union([
  classifiedSandboxCodeActionSchema,
  classifiedWebFetchActionSchema,
  classifiedWebSearchActionSchema,
]);

export const reserveRuntimeToolExecutionInputSchema = verifyActiveRunAdmissionInputSchema.extend({
  action: classifiedRuntimeToolActionSchema,
});

const invalidRuntimeToolExecutionSchema = z.strictObject({
  error: z.strictObject({
    code: z.literal("invalid_execution"),
    message: z.literal("Runtime tool execution denied."),
  }),
  ok: z.literal(false),
});

export const runtimeToolExecutionPermitSchema = z.strictObject({
  action: classifiedRuntimeToolActionSchema,
  actionDigest: sha256DigestSchema,
  audience: z.literal("crew_session_runtime_tool"),
  constraints: z.strictObject({
    decisionExpiresAt: z.iso.datetime(),
    maxDurationMs: z.number().int().min(1),
    maxOutputBytes: z.number().int().min(1_024),
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
export type ClassifiedRuntimeToolAction = z.infer<typeof classifiedRuntimeToolActionSchema>;
export type ClassifiedWebFetchAction = z.infer<typeof classifiedWebFetchActionSchema>;
export type ClassifiedWebSearchAction = z.infer<typeof classifiedWebSearchActionSchema>;
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
