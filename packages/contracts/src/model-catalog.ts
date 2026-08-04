import * as z from "zod";

import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentNameSchema,
} from "./control-plane.js";
import {
  CREWHELM_STARTER_AGENT_MODELS,
  DEFAULT_RUNNABLE_AGENT_MODEL,
  cloudflareAiModelIdSchema,
} from "./inference.js";

export const MAXIMUM_ENABLED_AGENT_MODELS = 64;
export const MAXIMUM_MODEL_CATALOG_REVISIONS = 1_000;
export const MAXIMUM_MODEL_DISCOVERY_ITEMS = 25;
export const MAXIMUM_MODEL_BROWSE_ITEMS = 100;
export const MAXIMUM_MODEL_BROWSE_PAGES = 500;
export const MAXIMUM_MODEL_BROWSE_SCAN_ITEMS = 500;
export const MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS = 250;
export const CLOUDFLARE_AI_MODEL_CATALOG_URL = "https://developers.cloudflare.com/ai/models/";
export const CLOUDFLARE_AI_PRICING_URL =
  "https://developers.cloudflare.com/workers-ai/platform/pricing/";
export const CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL =
  "https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/unified-billing";

export const crewhelmStarterModelCatalog = {
  defaultModel: DEFAULT_RUNNABLE_AGENT_MODEL,
  enabledModels: [...CREWHELM_STARTER_AGENT_MODELS].toSorted(),
} as const;

const canonicalEnabledModelsSchema = z
  .array(cloudflareAiModelIdSchema)
  .min(1)
  .max(MAXIMUM_ENABLED_AGENT_MODELS)
  .refine(
    (models) => models.every((model, index) => index === 0 || (models[index - 1] ?? "") < model),
    "Expected unique model IDs in canonical order.",
  );

export const modelCatalogDataSchema = z
  .strictObject({
    defaultModel: cloudflareAiModelIdSchema.describe(
      "Enabled model used when Agent creation omits inference configuration.",
    ),
    enabledModels: canonicalEnabledModelsSchema.describe(
      "Exact Cloudflare AI model IDs enabled by this owner.",
    ),
  })
  .refine(
    (catalog) => catalog.enabledModels.includes(catalog.defaultModel),
    "The default model must be enabled.",
  );

export const modelCatalogRevisionNumberSchema = z.number().int().positive().safe();
export const modelCatalogSchema = z.strictObject({
  configuredAt: z.iso.datetime(),
  data: modelCatalogDataSchema,
  revision: modelCatalogRevisionNumberSchema,
});

export const getModelCatalogInputSchema = z.strictObject({
  target: z.strictObject({ kind: z.literal("model-catalog") }),
});

export const modelCatalogChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("add"),
    modelId: cloudflareAiModelIdSchema,
  }),
  z.strictObject({
    kind: z.literal("remove"),
    modelId: cloudflareAiModelIdSchema,
    replacementDefaultModelId: cloudflareAiModelIdSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("set-default"),
    modelId: cloudflareAiModelIdSchema,
  }),
]);

export const configureModelCatalogInputSchema = z
  .strictObject({
    change: modelCatalogChangeSchema,
    expectedRevision: modelCatalogRevisionNumberSchema,
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    mode: z.enum(["preview", "apply"]),
    target: z.strictObject({ kind: z.literal("model-catalog") }),
  })
  .superRefine((input, context) => {
    if (input.mode === "apply" && input.idempotencyKey === undefined) {
      context.addIssue({
        code: "custom",
        message: "Apply mode requires an idempotency key.",
        path: ["idempotencyKey"],
      });
    }
    if (input.mode === "preview" && input.idempotencyKey !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Preview mode does not accept an idempotency key.",
        path: ["idempotencyKey"],
      });
    }
  });

export const modelCatalogAffectedAgentSchema = z.strictObject({
  id: agentIdSchema,
  model: cloudflareAiModelIdSchema,
  name: agentNameSchema,
  revision: z.number().int().positive().safe(),
  status: z.enum(["active", "disabled"]),
});

export const modelCatalogImpactSchema = z.strictObject({
  affectedAgents: z.array(modelCatalogAffectedAgentSchema).max(MAXIMUM_MODEL_DISCOVERY_ITEMS),
  affectedAgentsTotal: z.number().int().nonnegative().safe(),
  truncated: z.boolean(),
});

const modelCatalogErrorSchema = z.strictObject({
  code: z.enum([
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "last_model",
    "model_already_enabled",
    "model_disabled",
    "model_incompatible",
    "model_unavailable",
    "no_changes",
    "owner_mismatch",
    "replacement_default_required",
    "revision_conflict",
    "revision_limit_exceeded",
  ]),
  message: z.literal("Model catalog request denied."),
});

export const getModelCatalogResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ catalog: modelCatalogSchema, ok: z.literal(true) }),
  z.strictObject({ error: modelCatalogErrorSchema, ok: z.literal(false) }),
]);

export const configureModelCatalogResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    applied: z.boolean(),
    catalog: modelCatalogSchema,
    impact: modelCatalogImpactSchema,
    ok: z.literal(true),
  }),
  z.strictObject({ error: modelCatalogErrorSchema, ok: z.literal(false) }),
]);

export const modelDiscoveryCapabilitySchema = z.enum(["function-calling", "reasoning", "vision"]);
export const modelBrowseCapabilitySchema = z.enum([
  "function-calling",
  "reasoning",
  "vision",
  "zero-data-retention",
]);
export const modelBrowsePlatformSchema = z.enum(["cloudflare-hosted", "third-party"]);
export const modelBrowseFreshnessSchema = z.enum(["live", "last-known-good", "bundled-fallback"]);
export const modelRuntimeCompatibilitySchema = z.enum(["compatible", "incompatible"]);
export const modelRuntimeCompatibilityEvidenceSchema = z.enum([
  "declared-tool-support",
  "adapter-inferred-tool-support",
  "unsupported-task",
  "unsupported-request-format",
  "tool-support-undeclared",
]);
export const modelBrowseSortSchema = z.enum(["relevance", "name", "newest", "oldest"]);
export const browseCloudflareModelsInputSchema = z.strictObject({
  capability: modelBrowseCapabilitySchema.optional(),
  includeDescriptions: z.boolean().default(false),
  limit: z.number().int().min(1).max(MAXIMUM_MODEL_BROWSE_ITEMS).default(50),
  page: z.number().int().min(1).max(MAXIMUM_MODEL_BROWSE_PAGES).default(1),
  platform: modelBrowsePlatformSchema.optional(),
  provider: z.string().trim().min(1).max(80).optional(),
  query: z.string().trim().min(1).max(120).optional(),
  sort: modelBrowseSortSchema.default("relevance"),
  task: z.string().trim().min(1).max(80).optional(),
});
export const searchCloudflareModelsInputSchema = z.strictObject({
  capability: modelDiscoveryCapabilitySchema.optional(),
  limit: z.number().int().min(1).max(MAXIMUM_MODEL_DISCOVERY_ITEMS).default(10),
  provider: z.string().trim().min(1).max(80).optional(),
  query: z.string().trim().min(1).max(120).optional(),
  task: z.string().trim().min(1).max(80).optional(),
});
export const inspectCloudflareModelInputSchema = z.strictObject({
  modelId: cloudflareAiModelIdSchema,
});

export const cloudflareModelCapabilityStateSchema = z.enum(["declared-supported", "unspecified"]);
export const cloudflareModelCatalogItemSchema = z.strictObject({
  availability: z.literal("available"),
  capabilities: z.strictObject({
    functionCalling: cloudflareModelCapabilityStateSchema,
    reasoning: cloudflareModelCapabilityStateSchema,
    vision: cloudflareModelCapabilityStateSchema,
  }),
  description: z.string().max(2_000),
  id: cloudflareAiModelIdSchema,
  name: z.string().min(1).max(240),
  platform: z.enum(["cloudflare-hosted", "third-party"]),
  pricing: z.strictObject({
    facts: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(120),
          value: z.string().min(1).max(240),
        }),
      )
      .max(16),
    retrievedAt: z.iso.datetime(),
    source: z.url(),
    status: z.enum(["catalog-reported", "reference-only"]),
  }),
  provider: z.string().min(1).max(120),
  runtimeCompatibility: modelRuntimeCompatibilitySchema,
  runtimeCompatibilityEvidence: modelRuntimeCompatibilityEvidenceSchema,
  source: z.strictObject({
    catalog: z.url(),
    retrievedAt: z.iso.datetime(),
  }),
  task: z.strictObject({
    description: z.string().max(1_000),
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
  }),
});

export const cloudflareModelBrowseItemSchema = z.strictObject({
  capabilities: z.array(modelBrowseCapabilitySchema).max(8),
  createdAt: z.iso.datetime().nullable(),
  description: z.string().max(500),
  freshness: modelBrowseFreshnessSchema,
  id: cloudflareAiModelIdSchema,
  name: z.string().min(1).max(240),
  platform: modelBrowsePlatformSchema,
  provider: z.string().min(1).max(120),
  requestFormats: z.array(z.string().min(1).max(80)).max(8),
  runtimeCompatibility: modelRuntimeCompatibilitySchema,
  runtimeCompatibilityEvidence: modelRuntimeCompatibilityEvidenceSchema,
  task: z.string().min(1).max(120),
});
export const cloudflareModelBrowseResultItemSchema = cloudflareModelBrowseItemSchema
  .omit({ description: true })
  .extend({ description: z.string().max(500).optional() });
const modelBrowseFacetSchema = z.strictObject({
  count: z.number().int().positive().safe(),
  value: z.string().min(1).max(120),
});
const cloudflareModelDiscoveryErrorSchema = z.strictObject({
  code: z.enum(["catalog_unavailable", "invalid_request", "model_unavailable"]),
  message: z.literal("Cloudflare model discovery request denied."),
});
export const browseCloudflareModelsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    facets: z.strictObject({
      capabilities: z.array(modelBrowseFacetSchema).max(16),
      platforms: z.array(modelBrowseFacetSchema).max(4),
      providers: z.array(modelBrowseFacetSchema).max(120),
      tasks: z.array(modelBrowseFacetSchema).max(64),
    }),
    models: z.array(cloudflareModelBrowseResultItemSchema).max(MAXIMUM_MODEL_BROWSE_ITEMS),
    nextPage: z.number().int().min(2).max(MAXIMUM_MODEL_BROWSE_PAGES).nullable(),
    ok: z.literal(true),
    page: z.number().int().min(1).max(MAXIMUM_MODEL_BROWSE_PAGES),
    retrievedAt: z.iso.datetime(),
    snapshot: z.strictObject({
      refreshedAt: z.iso.datetime(),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      sourceUrl: z.url(),
      status: z.enum(["last-known-good", "bundled-fallback"]),
    }),
    source: z.literal(CLOUDFLARE_AI_MODEL_CATALOG_URL),
    total: z.number().int().nonnegative().max(MAXIMUM_MODEL_BROWSE_SCAN_ITEMS),
  }),
  z.strictObject({ error: cloudflareModelDiscoveryErrorSchema, ok: z.literal(false) }),
]);
export const searchCloudflareModelsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    models: z.array(cloudflareModelCatalogItemSchema).max(MAXIMUM_MODEL_DISCOVERY_ITEMS),
    ok: z.literal(true),
    scanned: z.number().int().nonnegative().max(MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS),
  }),
  z.strictObject({ error: cloudflareModelDiscoveryErrorSchema, ok: z.literal(false) }),
]);
export const inspectCloudflareModelResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ model: cloudflareModelCatalogItemSchema, ok: z.literal(true) }),
  z.strictObject({ error: cloudflareModelDiscoveryErrorSchema, ok: z.literal(false) }),
]);

export type ConfigureModelCatalogInput = z.infer<typeof configureModelCatalogInputSchema>;
export type ConfigureModelCatalogResult = z.infer<typeof configureModelCatalogResultSchema>;
export type GetModelCatalogResult = z.infer<typeof getModelCatalogResultSchema>;
export type ModelCatalog = z.infer<typeof modelCatalogSchema>;
export type ModelCatalogData = z.infer<typeof modelCatalogDataSchema>;
export type CloudflareModelCatalogItem = z.infer<typeof cloudflareModelCatalogItemSchema>;
export type CloudflareModelBrowseItem = z.infer<typeof cloudflareModelBrowseItemSchema>;
export type BrowseCloudflareModelsResult = z.infer<typeof browseCloudflareModelsResultSchema>;
export type SearchCloudflareModelsResult = z.infer<typeof searchCloudflareModelsResultSchema>;
export type InspectCloudflareModelResult = z.infer<typeof inspectCloudflareModelResultSchema>;
