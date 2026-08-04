import * as z from "zod";

import { sha256DigestSchema } from "./capabilities.js";
import { connectionAuthConfigIdSchema } from "./connections.js";
import { ownerClientIdSchema, ownerKeySchema } from "./control-plane.js";
import {
  integrationEnablementIdempotencyKeySchema,
  integrationSlugSchema,
  providerAuthConfigReferenceSchema,
  providerAuthSchemeSchema,
} from "./integrations.js";

export const PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS = 5 * 60 * 1_000;
export const PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS = 15 * 60 * 1_000;
export const PROVIDER_AUTH_SETUP_UNKNOWN_RECOVERY_MS = 30 * 60 * 1_000;
export const MAXIMUM_PROVIDER_AUTH_SETUP_REQUESTS_PER_OWNER = 5_000;
export const MAXIMUM_PROVIDER_CREDENTIAL_FIELDS = 16;
export const MAXIMUM_PROVIDER_CREDENTIAL_VALUE_CHARACTERS = 8_192;
const safeHttpsUrlSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  });

export const providerAuthSetupIdSchema = z
  .string()
  .regex(
    /^provider_auth_setup_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const providerCredentialFieldSchema = z.strictObject({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  label: z.string().min(1).max(120),
  maximumLength: z.number().int().min(1).max(MAXIMUM_PROVIDER_CREDENTIAL_VALUE_CHARACTERS),
  required: z.boolean(),
  secret: z.boolean(),
  type: z.literal("string"),
});
export const providerCredentialFieldsSchema = z
  .array(providerCredentialFieldSchema)
  .min(1)
  .max(MAXIMUM_PROVIDER_CREDENTIAL_FIELDS)
  .refine(
    (fields) => new Set(fields.map((field) => field.key)).size === fields.length,
    "Expected unique provider credential fields.",
  );
export const providerAuthSetupPlanSchema = z.strictObject({
  authorizeConnection: z.boolean(),
  authScheme: providerAuthSchemeSchema,
  callbackUrl: safeHttpsUrlSchema.optional(),
  documentationUrl: safeHttpsUrlSchema.optional(),
  fieldSchemaDigest: sha256DigestSchema,
  fields: providerCredentialFieldsSchema,
  integrationName: z.string().min(1).max(160),
  integrationSlug: integrationSlugSchema,
  setupId: providerAuthSetupIdSchema,
});
export const prepareProviderAuthSetupInputSchema = z.strictObject({
  capabilityDigest: sha256DigestSchema,
  capabilityExpiresAt: z.number().int().positive().safe(),
  idempotencyKey: integrationEnablementIdempotencyKeySchema,
  plan: providerAuthSetupPlanSchema,
  setupExpiresAt: z.number().int().positive().safe(),
});
export const prepareProviderAuthSetupResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    capabilityExpiresAt: z.number().int().positive().safe(),
    ok: z.literal(true),
    setupExpiresAt: z.number().int().positive().safe(),
    setupId: providerAuthSetupIdSchema,
    state: z.enum(["prepared", "replay"]),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "idempotency_conflict",
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "provider_auth_setup_limit_exceeded",
      ]),
      message: z.literal("Provider authentication setup request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const providerAuthSetupSessionInputSchema = z.strictObject({
  sessionDigest: sha256DigestSchema,
  setupId: providerAuthSetupIdSchema,
});
export const exchangeProviderAuthSetupInputSchema = providerAuthSetupSessionInputSchema.extend({
  capabilityDigest: sha256DigestSchema,
});
export const providerAuthSetupPlanResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authConfigId: connectionAuthConfigIdSchema.optional(),
    ok: z.literal(true),
    plan: providerAuthSetupPlanSchema,
    sessionExpiresAt: z.number().int().positive().safe(),
    status: z.enum(["exchanged", "configured", "rejected", "outcome_unknown"]),
  }),
  z.strictObject({
    error: z.literal("provider_auth_setup_denied"),
    ok: z.literal(false),
  }),
]);
export const completeProviderAuthSetupInputSchema = providerAuthSetupSessionInputSchema.extend({
  authConfig: providerAuthConfigReferenceSchema,
});
export const rejectProviderAuthSetupInputSchema = providerAuthSetupSessionInputSchema.extend({
  outcome: z.enum(["credentials_rejected", "outcome_unknown"]),
});
export const providerAuthSetupMutationResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ authConfigId: connectionAuthConfigIdSchema.optional(), ok: z.literal(true) }),
  z.strictObject({ error: z.literal("provider_auth_setup_denied"), ok: z.literal(false) }),
]);
export const providerAuthSetupAuthorityResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authConfigId: connectionAuthConfigIdSchema,
    clientId: ownerClientIdSchema,
    ok: z.literal(true),
    ownerKey: ownerKeySchema,
  }),
  z.strictObject({ error: z.literal("provider_auth_setup_denied"), ok: z.literal(false) }),
]);

export type ProviderAuthSetupPlan = z.infer<typeof providerAuthSetupPlanSchema>;
export type ProviderCredentialField = z.infer<typeof providerCredentialFieldSchema>;
export type PrepareProviderAuthSetupResult = z.infer<typeof prepareProviderAuthSetupResultSchema>;
export type ProviderAuthSetupPlanResult = z.infer<typeof providerAuthSetupPlanResultSchema>;
export type ProviderAuthSetupMutationResult = z.infer<typeof providerAuthSetupMutationResultSchema>;
export type ProviderAuthSetupAuthorityResult = z.infer<
  typeof providerAuthSetupAuthorityResultSchema
>;
