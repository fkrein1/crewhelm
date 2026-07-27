import * as z from "zod";

export const AGENTS_READ_SCOPE = "agents:read";
export const AGENTS_WRITE_SCOPE = "agents:write";
export const INTEGRATIONS_READ_SCOPE = "integrations:read";
export const OWNER_READ_SCOPE = "control:read";
export const OWNER_WRITE_SCOPE = "control:write";
export const OWNER_SCOPES = [
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
] as const;
export const OWNER_DEFAULT_SCOPE_CLAIM =
  "control:read control:write agents:read agents:write integrations:read";

export const ownerScopeSchema = z.enum(OWNER_SCOPES);
export const ownerScopesSchema = z
  .array(ownerScopeSchema)
  .min(1)
  .max(OWNER_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Duplicate owner scope.");
export const ownerScopeClaimSchema = z
  .string()
  .min(1)
  .max(OWNER_DEFAULT_SCOPE_CLAIM.length)
  .transform((claim, context) => {
    const parsedScopes = ownerScopesSchema.safeParse(claim.split(" "));

    if (!parsedScopes.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid owner scope claim.",
      });
      return z.NEVER;
    }

    return OWNER_SCOPES.filter((scope) => parsedScopes.data.includes(scope)).join(" ");
  });

export const ownerKeySchema = z
  .string()
  .regex(/^owner_[A-Za-z0-9_-]{43}$/, "Expected an opaque Crewhelm owner key.");

export const verifiedOwnerIdentitySchema = z.strictObject({
  issuer: z.url().max(2_048),
  subject: z.string().min(1).max(255),
  tenant: z.string().min(1).max(255).optional(),
});

export const ownerAuthoritySchema = z.strictObject({
  clientId: z.string().min(1).max(2_048),
  ownerKey: ownerKeySchema,
  scopes: ownerScopesSchema,
});

export const controlPlaneStatusSchema = z.strictObject({
  schemaVersion: z.literal(2),
  status: z.literal("ready"),
});

export const controlPlaneStatusResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    status: controlPlaneStatusSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "owner_mismatch",
      ]),
      message: z.literal("Control-plane request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const agentIdSchema = z
  .string()
  .regex(
    /^agent_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm agent ID.",
  );
export const MAXIMUM_AGENTS_PER_OWNER = 100;
export const MAXIMUM_REVISIONS_PER_AGENT = 1_000;
export const agentNameSchema = z.string().trim().min(1).max(80);
export const agentModelSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^(?:@cf\/)?[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    "Expected a bounded provider/model identifier.",
  );
export const agentInstructionsSchema = z
  .string()
  .min(1)
  .max(8 * 1_024);
export const agentExecutionLimitsSchema = z.strictObject({
  maxDurationSeconds: z.number().int().min(1).max(3_600),
  maxModelTokens: z.number().int().min(1).max(1_000_000),
  maxToolCalls: z.number().int().min(0).max(100),
  maxTurns: z.number().int().min(1).max(100),
});
export const agentCapabilityGrantsSchema = z.tuple([]);
export const agentRevisionNumberSchema = z.number().int().positive().safe();
export const agentSummarySchema = z.strictObject({
  capabilityGrants: agentCapabilityGrantsSchema,
  createdAt: z.iso.datetime(),
  executionLimits: agentExecutionLimitsSchema,
  id: agentIdSchema,
  model: agentModelSchema,
  name: agentNameSchema,
  revision: agentRevisionNumberSchema,
});
export const agentSchema = agentSummarySchema.extend({
  instructions: agentInstructionsSchema,
});
export const agentMutationIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque idempotency key.");
export const agentCreationIdempotencyKeySchema = agentMutationIdempotencyKeySchema;
export const createAgentInputSchema = z.strictObject({
  executionLimits: agentExecutionLimitsSchema,
  idempotencyKey: agentCreationIdempotencyKeySchema,
  instructions: agentInstructionsSchema,
  model: agentModelSchema,
  name: agentNameSchema,
});
export const getAgentInputSchema = z.strictObject({
  id: agentIdSchema,
});
export const listAgentsInputSchema = z.strictObject({
  cursor: agentIdSchema.optional(),
  limit: z.number().int().min(1).max(50).default(25),
});
export const updateAgentInputSchema = z.strictObject({
  executionLimits: agentExecutionLimitsSchema,
  expectedRevision: agentRevisionNumberSchema,
  id: agentIdSchema,
  idempotencyKey: agentMutationIdempotencyKeySchema,
  instructions: agentInstructionsSchema,
  model: agentModelSchema,
  name: agentNameSchema,
});

const agentRequestErrorSchema = z.strictObject({
  code: z.enum([
    "agent_limit_exceeded",
    "agent_not_found",
    "agent_revision_limit_exceeded",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "no_changes",
    "owner_mismatch",
    "revision_conflict",
  ]),
  message: z.literal("Agent request denied."),
});

export const createAgentResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agent: agentSchema,
    created: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: agentRequestErrorSchema,
    ok: z.literal(false),
  }),
]);
export const getAgentResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agent: agentSchema,
    ok: z.literal(true),
  }),
  z.strictObject({
    error: agentRequestErrorSchema,
    ok: z.literal(false),
  }),
]);
export const listAgentsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agents: z.array(agentSummarySchema).max(50),
    nextCursor: agentIdSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: agentRequestErrorSchema,
    ok: z.literal(false),
  }),
]);
export const updateAgentResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    agent: agentSchema,
    ok: z.literal(true),
    updated: z.boolean(),
  }),
  z.strictObject({
    error: agentRequestErrorSchema,
    ok: z.literal(false),
  }),
]);

export type Agent = z.infer<typeof agentSchema>;
export type AgentExecutionLimits = z.infer<typeof agentExecutionLimitsSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type ControlPlaneStatus = z.infer<typeof controlPlaneStatusSchema>;
export type ControlPlaneStatusResult = z.infer<typeof controlPlaneStatusResultSchema>;
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;
export type CreateAgentResult = z.infer<typeof createAgentResultSchema>;
export type GetAgentInput = z.infer<typeof getAgentInputSchema>;
export type GetAgentResult = z.infer<typeof getAgentResultSchema>;
export type ListAgentsInput = z.infer<typeof listAgentsInputSchema>;
export type ListAgentsResult = z.infer<typeof listAgentsResultSchema>;
export type OwnerAuthority = z.infer<typeof ownerAuthoritySchema>;
export type OwnerScope = z.infer<typeof ownerScopeSchema>;
export type UpdateAgentInput = z.infer<typeof updateAgentInputSchema>;
export type UpdateAgentResult = z.infer<typeof updateAgentResultSchema>;
export type VerifiedOwnerIdentity = z.infer<typeof verifiedOwnerIdentitySchema>;
