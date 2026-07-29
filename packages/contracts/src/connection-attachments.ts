import * as z from "zod";

import { composioToolLimitsSchema, toolAuthorizationModeSchema } from "./capabilities.js";
import {
  connectionIdSchema,
  connectionSummarySchema,
  composioConnectedAccountIdSchema,
} from "./connections.js";
import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
  agentSchema,
} from "./control-plane.js";
import {
  integrationSlugSchema,
  integrationToolInspectionSchema,
  integrationToolkitVersionSchema,
  integrationToolSlugSchema,
} from "./integrations.js";

export const MAXIMUM_CONNECTION_TOOLS_PER_AGENT = 20;

export const configuredConnectionToolSchema = z.strictObject({
  authorization: toolAuthorizationModeSchema,
  slug: integrationToolSlugSchema,
  version: integrationToolkitVersionSchema,
});

export const configureAgentConnectionInputSchema = z.strictObject({
  agentId: agentIdSchema,
  connectionId: connectionIdSchema,
  expectedRevision: agentRevisionNumberSchema,
  expiresAt: z.iso.datetime().nullable(),
  idempotencyKey: agentMutationIdempotencyKeySchema,
  limits: composioToolLimitsSchema,
  tools: z
    .array(configuredConnectionToolSchema)
    .max(MAXIMUM_CONNECTION_TOOLS_PER_AGENT)
    .refine(
      (tools) =>
        tools.every(
          (tool, index) =>
            index === 0 ||
            `${tools[index - 1]?.slug}:${tools[index - 1]?.version}` <
              `${tool.slug}:${tool.version}`,
        ),
      "Expected unique tools in canonical slug and version order.",
    ),
});

export const resolveConnectionForAttachmentInputSchema = z.strictObject({
  agentId: agentIdSchema,
  connectionId: connectionIdSchema,
  expectedRevision: agentRevisionNumberSchema,
});

export const resolvedConnectionForAttachmentSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    providerConnectionId: composioConnectedAccountIdSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "agent_not_found",
        "connection_not_found",
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "revision_conflict",
      ]),
      message: z.literal("Connection attachment request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const completeAgentConnectionConfigurationInputSchema =
  configureAgentConnectionInputSchema.extend({
    providerConnectionId: composioConnectedAccountIdSchema.nullable(),
    tools: z
      .array(
        integrationToolInspectionSchema.extend({
          authorization: toolAuthorizationModeSchema,
        }),
      )
      .max(MAXIMUM_CONNECTION_TOOLS_PER_AGENT),
    verifiedAccountLabel: connectionSummarySchema.shape.accountLabel,
    verifiedToolkitSlug: integrationSlugSchema.nullable(),
  });

const connectionAttachmentErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_revision_limit_exceeded",
    "connection_not_found",
    "connection_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "revision_conflict",
  ]),
  message: z.literal("Connection attachment request denied."),
});

export const configureAgentConnectionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agent: agentSchema,
    configured: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: connectionAttachmentErrorSchema,
    ok: z.literal(false),
  }),
]);

export const lookupAgentConnectionConfigurationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    replay: configureAgentConnectionResultSchema.options[0].nullable(),
  }),
  z.strictObject({
    error: connectionAttachmentErrorSchema,
    ok: z.literal(false),
  }),
]);

export type CompleteAgentConnectionConfigurationInput = z.infer<
  typeof completeAgentConnectionConfigurationInputSchema
>;
export type ConfigureAgentConnectionInput = z.infer<typeof configureAgentConnectionInputSchema>;
export type ConfigureAgentConnectionResult = z.infer<typeof configureAgentConnectionResultSchema>;
export type LookupAgentConnectionConfigurationResult = z.infer<
  typeof lookupAgentConnectionConfigurationResultSchema
>;
export type ResolvedConnectionForAttachment = z.infer<typeof resolvedConnectionForAttachmentSchema>;
