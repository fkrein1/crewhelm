import * as z from "zod";

import { capabilityGrantIdSchema, agentIdSchema } from "./control-plane.js";
import { connectionIdSchema } from "./connections.js";
import { runIdSchema, toolCallIdSchema } from "./capabilities.js";

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

export type ChangeAuthorityInput = z.infer<typeof changeAuthorityInputSchema>;
export type ChangeAuthorityResult = z.infer<typeof changeAuthorityResultSchema>;
export type ReconcileToolExecutionResult = z.infer<typeof reconcileToolExecutionResultSchema>;
