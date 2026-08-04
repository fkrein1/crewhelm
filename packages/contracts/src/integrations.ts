import * as z from "zod";

import { connectionAuthConfigIdSchema } from "./connections.js";

export const INTEGRATION_ENABLEMENT_UNKNOWN_RECOVERY_MS = 30 * 60 * 1_000;
export const MAXIMUM_INTEGRATION_ENABLEMENT_REQUESTS_PER_OWNER = 5_000;
export const MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER = 5_000;
const MAXIMUM_TOOL_PARAMETER_CONTAINER_ENTRIES = 512;
const MAXIMUM_TOOL_PARAMETER_DEPTH = 24;
const MAXIMUM_TOOL_PARAMETER_KEY_LENGTH = 256;
const MAXIMUM_TOOL_PARAMETER_NODES = 10_000;
const MAXIMUM_TOOL_PARAMETER_STRING_LENGTH = 32 * 1_024;

export type IntegrationToolParameterValue =
  | boolean
  | null
  | number
  | string
  | IntegrationToolParameterValue[]
  | { [key: string]: IntegrationToolParameterValue };

function isBoundedToolParameterValue(value: unknown): value is IntegrationToolParameterValue {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
  let nodes = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop();

      if (current === undefined) {
        return false;
      }

      nodes += 1;

      if (nodes > MAXIMUM_TOOL_PARAMETER_NODES) {
        return false;
      }

      if (
        current.value === null ||
        typeof current.value === "boolean" ||
        (typeof current.value === "number" && Number.isFinite(current.value))
      ) {
        continue;
      }

      if (typeof current.value === "string") {
        if (current.value.length > MAXIMUM_TOOL_PARAMETER_STRING_LENGTH) {
          return false;
        }

        continue;
      }

      if (current.depth >= MAXIMUM_TOOL_PARAMETER_DEPTH) {
        return false;
      }

      if (Array.isArray(current.value)) {
        const arrayValue = current.value;

        if (
          Object.getPrototypeOf(arrayValue) !== Array.prototype ||
          arrayValue.length > MAXIMUM_TOOL_PARAMETER_CONTAINER_ENTRIES
        ) {
          return false;
        }

        const ownKeys = Reflect.ownKeys(arrayValue);

        if (
          ownKeys.length !== arrayValue.length + 1 ||
          !ownKeys.every(
            (key) =>
              key === "length" ||
              (typeof key === "string" &&
                /^(0|[1-9][0-9]*)$/.test(key) &&
                Number(key) < arrayValue.length),
          )
        ) {
          return false;
        }

        for (let index = 0; index < arrayValue.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));

          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            return false;
          }

          pending.push({ depth: current.depth + 1, value: descriptor.value });
        }

        continue;
      }

      if (typeof current.value !== "object") {
        return false;
      }

      const prototype: unknown = Object.getPrototypeOf(current.value);

      if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }

      const ownKeys = Reflect.ownKeys(current.value);

      if (
        ownKeys.length > MAXIMUM_TOOL_PARAMETER_CONTAINER_ENTRIES ||
        ownKeys.some(
          (key) => typeof key !== "string" || key.length > MAXIMUM_TOOL_PARAMETER_KEY_LENGTH,
        )
      ) {
        return false;
      }

      for (const key of ownKeys) {
        if (typeof key !== "string") {
          return false;
        }

        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);

        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return false;
        }

        pending.push({ depth: current.depth + 1, value: descriptor.value });
      }
    }
  } catch {
    return false;
  }

  return true;
}

export const integrationToolParameterMapSchema = z.custom<
  Record<string, IntegrationToolParameterValue>
>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isBoundedToolParameterValue(value),
  "Expected a bounded Composio tool parameter map.",
);

export const integrationCatalogCursorSchema = z.string().min(1).max(2_048);
export const integrationCatalogSearchInputSchema = z.strictObject({
  cursor: integrationCatalogCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().trim().min(3).max(160).optional(),
});
export const integrationSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, "Expected a Composio integration slug.");
export const providerAuthSchemeSchema = z.enum(["OAUTH2", "API_KEY", "BEARER_TOKEN", "BASIC"]);
export const providerAuthConfigSourceSchema = z.enum(["composio_managed", "crewhelm_custom"]);
export const providerAuthConfigReferenceSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  authScheme: providerAuthSchemeSchema,
  integrationSlug: integrationSlugSchema,
  name: z.string().min(1).max(160),
  source: providerAuthConfigSourceSchema,
});
const providerAuthReadySchema = z.strictObject({
  selected: providerAuthConfigReferenceSchema,
  state: z.literal("ready"),
});
const providerAuthSelectionRequiredSchema = z.strictObject({
  choices: z.array(providerAuthConfigReferenceSchema).min(2).max(50),
  state: z.literal("selection_required"),
});
const providerAuthSetupRequiredSchema = z.strictObject({
  availableSchemes: z.array(providerAuthSchemeSchema).min(1).max(4),
  managedAuthAvailable: z.boolean(),
  recommendedScheme: providerAuthSchemeSchema,
  setup: z
    .strictObject({
      expiresAt: z.iso.datetime(),
      url: z.url().max(4_096),
    })
    .optional(),
  state: z.literal("setup_required"),
});
const providerAuthUnsupportedSchema = z.strictObject({
  reason: z.enum(["auth_scheme_unsupported", "toolkit_unavailable"]),
  state: z.literal("unsupported"),
});
export const providerAuthReadinessSchema = z.discriminatedUnion("state", [
  providerAuthReadySchema,
  providerAuthSelectionRequiredSchema,
  providerAuthSetupRequiredSchema,
  providerAuthUnsupportedSchema,
]);
const providerAuthPrerequisiteSchema = z.union([
  providerAuthSelectionRequiredSchema,
  providerAuthSetupRequiredSchema,
  providerAuthUnsupportedSchema,
]);
export const inspectProviderAuthInputSchema = z.strictObject({
  integrationSlug: integrationSlugSchema,
});
export const inspectProviderAuthResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authentication: providerAuthReadinessSchema,
    integration: z.strictObject({
      name: z.string().min(1).max(160),
      slug: integrationSlugSchema,
    }),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["insufficient_scope", "provider_auth_unavailable"]),
      message: z.literal("Provider authentication request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const integrationToolSlugSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9_]{0,255}$/, "Expected a Composio tool slug.");
export const integrationToolkitVersionSchema = z
  .string()
  .regex(/^[0-9]{8}_[0-9]{2}$/, "Expected an exact Composio toolkit version.");
export const integrationCatalogItemSchema = z.strictObject({
  authSchemes: z
    .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/))
    .max(16)
    .nullable(),
  description: z.string().max(2_000).nullable(),
  name: z.string().min(1).max(160),
  noAuth: z.boolean().nullable(),
  slug: integrationSlugSchema,
  toolsCount: z.number().int().min(0).max(1_000_000),
  version: integrationToolkitVersionSchema,
});
export const integrationCatalogSearchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    integrations: z.array(integrationCatalogItemSchema).max(50),
    nextCursor: integrationCatalogCursorSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["insufficient_scope", "integration_catalog_unavailable"]),
      message: z.literal("Integration catalog request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const integrationAuthConfigListInputSchema = z.strictObject({
  cursor: integrationCatalogCursorSchema.optional(),
  integrationSlug: integrationSlugSchema,
  limit: z.number().int().min(1).max(50).default(20),
});
export const integrationAuthConfigSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  authScheme: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  managed: z.boolean().nullable(),
  name: z.string().min(1).max(160),
});
export const integrationAuthConfigListResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authConfigs: z.array(integrationAuthConfigSchema).max(50),
    nextCursor: integrationCatalogCursorSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["insufficient_scope", "integration_catalog_unavailable"]),
      message: z.literal("Integration catalog request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const integrationEnablementIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "Expected an opaque idempotency key.");
export const integrationEnablementReservationIdSchema = z
  .string()
  .regex(
    /^integration_enablement_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque integration enablement reservation ID.",
  );
export const enableIntegrationInputSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema.optional(),
  idempotencyKey: integrationEnablementIdempotencyKeySchema,
  integrationSlug: integrationSlugSchema,
});
const integrationEnablementErrorSchema = z.strictObject({
  code: z.enum([
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "integration_enablement_in_progress",
    "integration_enablement_outcome_unknown",
    "integration_enablement_request_limit_exceeded",
    "integration_enablement_unavailable",
    "provider_auth_unavailable",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
  ]),
  message: z.literal("Integration enablement request denied."),
  operation: z
    .strictObject({
      nextAction: z.literal("retry_same_request"),
      recoverAfter: z.iso.datetime(),
      reservationId: integrationEnablementReservationIdSchema,
    })
    .optional(),
});
export const enableIntegrationResultSchema = z.union([
  z.strictObject({
    authConfigId: connectionAuthConfigIdSchema,
    authScheme: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    created: z.boolean(),
    integrationSlug: integrationSlugSchema,
    managed: z.boolean(),
    ok: z.literal(true),
  }),
  z.strictObject({
    authentication: providerAuthPrerequisiteSchema,
    integration: z.strictObject({
      name: z.string().min(1).max(160),
      slug: integrationSlugSchema,
    }),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: integrationEnablementErrorSchema,
    ok: z.literal(false),
  }),
]);
export const reserveIntegrationEnablementResultSchema = z.union([
  z.strictObject({
    authConfigId: connectionAuthConfigIdSchema,
    authScheme: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    integrationSlug: integrationSlugSchema,
    managed: z.literal(true),
    ok: z.literal(true),
    state: z.literal("replay"),
  }),
  z.strictObject({
    ok: z.literal(true),
    recoverAfter: z.iso.datetime(),
    reservationId: integrationEnablementReservationIdSchema,
    state: z.literal("dispatch"),
  }),
  z.strictObject({
    error: integrationEnablementErrorSchema,
    ok: z.literal(false),
  }),
]);
export const completeIntegrationEnablementInputSchema = z.strictObject({
  authConfigId: connectionAuthConfigIdSchema,
  authScheme: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  created: z.boolean(),
  integrationSlug: integrationSlugSchema,
  managed: z.literal(true),
  name: z.string().min(1).max(160),
  reservationId: integrationEnablementReservationIdSchema,
});
export const recordProviderAuthConfigInputSchema = providerAuthConfigReferenceSchema;
export const recordProviderAuthConfigResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    authConfig: providerAuthConfigReferenceSchema,
    created: z.boolean(),
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
        "provider_auth_config_limit_exceeded",
      ]),
      message: z.literal("Provider authentication configuration request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const integrationToolSearchInputSchema = z.strictObject({
  cursor: integrationCatalogCursorSchema.optional(),
  integrationSlug: integrationSlugSchema
    .optional()
    .describe("Limit action discovery to an already selected or connected integration."),
  limit: z.number().int().min(1).max(20).default(10),
  query: z.string().trim().min(3).max(160).optional(),
});
export const integrationToolCatalogItemSchema = z.strictObject({
  description: z.string().max(2_000).nullable(),
  integration: z.strictObject({
    name: z.string().min(1).max(160),
    slug: integrationSlugSchema,
  }),
  name: z.string().min(1).max(160),
  noAuth: z.boolean().nullable(),
  requiredScopes: z.array(z.string().min(1).max(512)).max(32).nullable(),
  slug: integrationToolSlugSchema,
  tags: z.array(z.string().min(1).max(64)).max(32),
  version: integrationToolkitVersionSchema,
});
export const integrationToolSearchResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    nextCursor: integrationCatalogCursorSchema.nullable(),
    ok: z.literal(true),
    tools: z.array(integrationToolCatalogItemSchema).max(20),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["insufficient_scope", "integration_catalog_unavailable"]),
      message: z.literal("Integration catalog request denied."),
    }),
    ok: z.literal(false),
  }),
]);
export const inspectIntegrationToolInputSchema = z.strictObject({
  slug: integrationToolSlugSchema,
  version: integrationToolkitVersionSchema,
});
export const integrationToolInspectionSchema = integrationToolCatalogItemSchema.extend({
  inputParameters: integrationToolParameterMapSchema,
  outputParameters: integrationToolParameterMapSchema,
});
export const integrationToolRuntimeDefinitionSchema = z.strictObject({
  description: z.string().max(2_000).nullable(),
  inputParametersJson: z
    .string()
    .min(2)
    .max(128 * 1_024),
  name: z.string().min(1).max(160),
  outputParametersJson: z
    .string()
    .min(2)
    .max(128 * 1_024),
  tags: z.array(z.string().min(1).max(64)).max(32),
});
export const inspectIntegrationToolResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    tool: integrationToolInspectionSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum(["insufficient_scope", "integration_catalog_unavailable"]),
      message: z.literal("Integration catalog request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type InspectIntegrationToolInput = z.infer<typeof inspectIntegrationToolInputSchema>;
export type InspectIntegrationToolResult = z.infer<typeof inspectIntegrationToolResultSchema>;
export type InspectProviderAuthInput = z.infer<typeof inspectProviderAuthInputSchema>;
export type InspectProviderAuthResult = z.infer<typeof inspectProviderAuthResultSchema>;
export type CompleteIntegrationEnablementInput = z.infer<
  typeof completeIntegrationEnablementInputSchema
>;
export type EnableIntegrationInput = z.infer<typeof enableIntegrationInputSchema>;
export type EnableIntegrationResult = z.infer<typeof enableIntegrationResultSchema>;
export type IntegrationAuthConfig = z.infer<typeof integrationAuthConfigSchema>;
export type IntegrationAuthConfigListInput = z.infer<typeof integrationAuthConfigListInputSchema>;
export type IntegrationAuthConfigListResult = z.infer<typeof integrationAuthConfigListResultSchema>;
export type IntegrationCatalogItem = z.infer<typeof integrationCatalogItemSchema>;
export type IntegrationCatalogSearchInput = z.infer<typeof integrationCatalogSearchInputSchema>;
export type IntegrationCatalogSearchResult = z.infer<typeof integrationCatalogSearchResultSchema>;
export type ProviderAuthConfigReference = z.infer<typeof providerAuthConfigReferenceSchema>;
export type ProviderAuthReadiness = z.infer<typeof providerAuthReadinessSchema>;
export type ProviderAuthScheme = z.infer<typeof providerAuthSchemeSchema>;
export type RecordProviderAuthConfigInput = z.infer<typeof recordProviderAuthConfigInputSchema>;
export type RecordProviderAuthConfigResult = z.infer<typeof recordProviderAuthConfigResultSchema>;
export type ReserveIntegrationEnablementResult = z.infer<
  typeof reserveIntegrationEnablementResultSchema
>;
export type IntegrationToolCatalogItem = z.infer<typeof integrationToolCatalogItemSchema>;
export type IntegrationToolInspection = z.infer<typeof integrationToolInspectionSchema>;
export type IntegrationToolRuntimeDefinition = z.infer<
  typeof integrationToolRuntimeDefinitionSchema
>;
export type IntegrationToolSearchInput = z.infer<typeof integrationToolSearchInputSchema>;
export type IntegrationToolSearchResult = z.infer<typeof integrationToolSearchResultSchema>;
