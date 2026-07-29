import * as z from "zod";

import {
  agentIdSchema,
  agentRevisionNumberSchema,
  capabilityGrantIdSchema,
} from "./control-plane.js";
import { connectionIdSchema } from "./connections.js";
import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";
import {
  capabilityEffectSchema,
  composioToolCapabilityGrantSchema,
  runIdSchema,
  toolCallIdSchema,
} from "./capabilities.js";

export const MAXIMUM_BATCH_AGENT_DISABLE_ITEMS = 25;
export const MAXIMUM_BATCH_AGENT_DISABLE_RESPONSE_BYTES = 8 * 1_024;
export const MAXIMUM_UNRESOLVED_TOOL_EFFECTS_RESPONSE_BYTES = 32 * 1_024;

export const changeAuthorityInputSchema = z.discriminatedUnion("target", [
  z.strictObject({
    agentId: agentIdSchema,
    target: z.literal("agent"),
  }),
  z.strictObject({
    connectionId: connectionIdSchema,
    target: z.literal("connection"),
  }),
  z.strictObject({
    grantId: capabilityGrantIdSchema,
    target: z.literal("capability"),
  }),
]);

export const batchDisableAgentsInputSchema = z.strictObject({
  agents: z
    .array(
      z.strictObject({
        agentId: agentIdSchema,
        expectedRevision: agentRevisionNumberSchema,
      }),
    )
    .min(1)
    .max(MAXIMUM_BATCH_AGENT_DISABLE_ITEMS)
    .refine(
      (agents) => new Set(agents.map((agent) => agent.agentId)).size === agents.length,
      "Expected unique Agent IDs.",
    ),
});

export const batchDisableAgentReceiptSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedRevision: agentRevisionNumberSchema,
  outcome: z.enum(["disabled", "already_disabled", "agent_not_found", "revision_conflict"]),
});

const batchDisableAgentsErrorSchema = z.strictObject({
  code: z.enum([
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
  ]),
  message: z.literal("Batch Agent disable request denied."),
});

export const batchDisableAgentsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    receipts: z.array(batchDisableAgentReceiptSchema).max(MAXIMUM_BATCH_AGENT_DISABLE_ITEMS),
  }),
  z.strictObject({
    error: batchDisableAgentsErrorSchema,
    ok: z.literal(false),
  }),
]);

const recoveryRequestErrorCodeSchema = z.enum([
  "agent_not_found",
  "capability_not_found",
  "connection_not_found",
  "incompatible_schema",
  "insufficient_scope",
  "invalid_authority",
  "invalid_request",
  "owner_mismatch",
]);

export const changeAuthorityResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    changed: z.boolean(),
    ok: z.literal(true),
    state: z.discriminatedUnion("target", [
      z.strictObject({
        agentId: agentIdSchema,
        status: z.literal("disabled"),
        target: z.literal("agent"),
      }),
      z.strictObject({
        connectionId: connectionIdSchema,
        status: z.literal("revoked"),
        target: z.literal("connection"),
      }),
      z.strictObject({
        grantId: capabilityGrantIdSchema,
        status: z.literal("revoked"),
        target: z.literal("capability"),
      }),
    ]),
  }),
  z.strictObject({
    error: z.strictObject({
      code: recoveryRequestErrorCodeSchema,
      message: z.literal("Authority control request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const reconcileToolExecutionInputSchema = z.strictObject({
  resolution: z.enum(["applied", "not_applied"]),
  toolCallId: toolCallIdSchema,
});

export const reconcileToolExecutionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    reconciled: z.boolean(),
    resolution: reconcileToolExecutionInputSchema.shape.resolution,
    runId: runIdSchema,
    toolCallId: toolCallIdSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "execution_not_found",
        "execution_not_reconcilable",
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
      ]),
      message: z.literal("Tool execution reconciliation denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const listUnresolvedToolEffectsInputSchema = z.strictObject({
  cursor: toolCallIdSchema.optional(),
  limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(10),
});

export const unresolvedToolEffectSummarySchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  connectionId: connectionIdSchema,
  effect: capabilityEffectSchema,
  authorization: composioToolCapabilityGrantSchema.shape.authorization,
  dispatchedAt: z.iso.datetime().nullable(),
  integrationSlug: composioToolCapabilityGrantSchema.shape.integrationSlug,
  legacyWildcard: z.boolean(),
  recordedAt: z.iso.datetime(),
  runId: runIdSchema,
  toolCallId: toolCallIdSchema,
  toolkitVersion: composioToolCapabilityGrantSchema.shape.toolkitVersion,
  toolSlug: composioToolCapabilityGrantSchema.shape.toolSlug,
});

export const listUnresolvedToolEffectsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    effects: z.array(unresolvedToolEffectSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
    nextCursor: toolCallIdSchema.nullable(),
    ok: z.literal(true),
    total: z.number().int().nonnegative().safe(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
      ]),
      message: z.literal("Unresolved tool effect request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type BatchDisableAgentReceipt = z.infer<typeof batchDisableAgentReceiptSchema>;
export type BatchDisableAgentsInput = z.infer<typeof batchDisableAgentsInputSchema>;
export type BatchDisableAgentsResult = z.infer<typeof batchDisableAgentsResultSchema>;
export type ChangeAuthorityInput = z.infer<typeof changeAuthorityInputSchema>;
export type ChangeAuthorityResult = z.infer<typeof changeAuthorityResultSchema>;
export type ListUnresolvedToolEffectsResult = z.infer<typeof listUnresolvedToolEffectsResultSchema>;
export type ReconcileToolExecutionResult = z.infer<typeof reconcileToolExecutionResultSchema>;
