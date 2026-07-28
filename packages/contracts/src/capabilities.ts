import * as z from "zod";

import { connectionIdSchema } from "./connections.js";
import {
  agentIdSchema,
  agentRevisionNumberSchema,
  capabilityGrantIdSchema,
  ownerKeySchema,
} from "./control-plane.js";
import {
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolSlugSchema,
} from "./integrations.js";

export const COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID = "composio.tool.execute";

const MAXIMUM_COST_MICROUSD = 1_000_000_000_000;
const MAXIMUM_TOOL_DURATION_MS = 5 * 60 * 1_000;
const MAXIMUM_TOOL_OUTPUT_BYTES = 10 * 1_024 * 1_024;
const MAXIMUM_TOOL_TARGETS = 32;

export const runIdSchema = z
  .string()
  .regex(
    /^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm run ID.",
  );
export const toolCallIdSchema = z
  .string()
  .regex(
    /^tool_call_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm tool-call ID.",
  );
export const sha256DigestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 digest.");
export const capabilityEffectSchema = z.enum(["read", "write", "destructive"]);

const canonicalTargetDigestsSchema = z
  .array(sha256DigestSchema)
  .min(1)
  .max(MAXIMUM_TOOL_TARGETS)
  .refine(
    (digests) =>
      digests.every((digest, index) => index === 0 || (digests[index - 1] ?? "") < digest),
    "Expected unique target digests in canonical order.",
  );
const composioToolBindingSchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  capabilityId: z.literal(COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID),
  connectionId: connectionIdSchema,
  effect: capabilityEffectSchema,
  grantId: capabilityGrantIdSchema,
  integrationSlug: integrationSlugSchema,
  ownerKey: ownerKeySchema,
  targetDigests: canonicalTargetDigestsSchema,
  toolkitVersion: integrationToolkitVersionSchema,
  toolSlug: integrationToolSlugSchema,
});
export const composioToolCapabilityGrantSchema = composioToolBindingSchema.extend({
  expiresAt: z.iso.datetime().nullable(),
  limits: z.strictObject({
    maxCallsPerRun: z.number().int().min(1).max(100),
    maxConcurrency: z.number().int().min(1).max(16),
    maxCostMicrousdPerCall: z.number().int().min(0).max(MAXIMUM_COST_MICROUSD).safe(),
    maxDurationMs: z.number().int().min(1).max(MAXIMUM_TOOL_DURATION_MS),
    maxOutputBytes: z.number().int().min(1).max(MAXIMUM_TOOL_OUTPUT_BYTES),
  }),
});
export const classifiedComposioToolActionSchema = composioToolBindingSchema.extend({
  estimatedCostMicrousd: z.number().int().min(0).max(MAXIMUM_COST_MICROUSD).safe().nullable(),
  inputDigest: sha256DigestSchema,
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
});
export const toolGatePolicySnapshotSchema = z.strictObject({
  activeGrantCalls: z.number().int().min(0).max(100),
  agentId: agentIdSchema,
  agentStatus: z.enum(["active", "revoked"]),
  capabilityId: z.literal(COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID),
  connectionId: connectionIdSchema,
  connectionStatus: z.enum(["active", "revoked", "unavailable"]),
  currentAgentRevision: agentRevisionNumberSchema,
  evaluatedAt: z.iso.datetime(),
  grantCallsUsed: z.number().int().min(0).max(100),
  grantId: capabilityGrantIdSchema,
  grantStatus: z.enum(["active", "revoked"]),
  killSwitchActive: z.boolean(),
  ownerKey: ownerKeySchema,
  remainingCostMicrousd: z.number().int().min(0).max(MAXIMUM_COST_MICROUSD).safe(),
  remainingDurationMs: z
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 1_000),
  remainingOutputBytes: z
    .number()
    .int()
    .min(0)
    .max(100 * 1_024 * 1_024),
  remainingToolCalls: z.number().int().min(0).max(100),
  runId: runIdSchema,
});
export const composioToolGateInputSchema = z.strictObject({
  action: classifiedComposioToolActionSchema,
  grant: composioToolCapabilityGrantSchema,
  policy: toolGatePolicySnapshotSchema,
});

const toolGateDenialReasonSchema = z.enum([
  "budget_exhausted",
  "concurrency_exhausted",
  "grant_expired",
  "grant_mismatch",
  "invalid_request",
  "policy_inactive",
  "policy_mismatch",
  "policy_stale",
  "unknown_cost",
]);
export const toolGateDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    action: classifiedComposioToolActionSchema,
    actionDigest: sha256DigestSchema,
    constraints: z.strictObject({
      decisionExpiresAt: z.iso.datetime(),
      maxCostMicrousd: z.number().int().min(0).max(MAXIMUM_COST_MICROUSD).safe(),
      maxDurationMs: z.number().int().min(1).max(MAXIMUM_TOOL_DURATION_MS),
      maxOutputBytes: z.number().int().min(1).max(MAXIMUM_TOOL_OUTPUT_BYTES),
    }),
    decision: z.literal("allow"),
  }),
  z.strictObject({
    decision: z.literal("deny"),
    reason: toolGateDenialReasonSchema,
  }),
  z.strictObject({
    actionDigest: sha256DigestSchema,
    decision: z.literal("requires_approval"),
    effect: z.enum(["write", "destructive"]),
    grantId: capabilityGrantIdSchema,
  }),
]);

export type CapabilityEffect = z.infer<typeof capabilityEffectSchema>;
export type ClassifiedComposioToolAction = z.infer<typeof classifiedComposioToolActionSchema>;
export type ComposioToolCapabilityGrant = z.infer<typeof composioToolCapabilityGrantSchema>;
export type ComposioToolGateInput = z.infer<typeof composioToolGateInputSchema>;
export type ToolGateDecision = z.infer<typeof toolGateDecisionSchema>;
export type ToolGatePolicySnapshot = z.infer<typeof toolGatePolicySnapshotSchema>;
