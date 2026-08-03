import * as z from "zod";

import {
  agentCapabilityConfigurationsSchema,
  agentCapabilityPrerequisiteSchema,
} from "./agent-capabilities.js";
import { agentBlueprintParameterNameSchema } from "./agent-blueprints.js";
import {
  agentCreationIdempotencyKeySchema,
  agentIdSchema,
  agentRevisionNumberSchema,
  agentExecutionLimitsSchema,
  agentInstructionsSchema,
  agentNameSchema,
} from "./control-plane.js";
import { connectionIdSchema, connectionStatusSchema } from "./connections.js";
import { sha256DigestSchema } from "./capabilities.js";
import {
  recipeEventTriggerSchema,
  recipeConnectionRequirementSchema,
  recipeNameSchema,
  recipePackageSchema,
  recipeOperationNameSchema,
  recipePrimaryOperationSchema,
  recipePublisherNamespaceSchema,
  recipeRegistryOriginSchema,
  recipeRegistryProjectionSchema,
  recipeScheduleSchema,
  recipeVersionSchema,
  registryArtifactCoordinateSchema,
  registrySkillProjectionSchema,
} from "./recipes.js";
import {
  registryRecipeSearchResponseSchema,
  registrySearchQuerySchema,
} from "./recipe-registry.js";
import { skillFilePathSchema, skillIdSchema, skillVersionSchema } from "./skills.js";
import { briefReferenceSchema } from "./briefs.js";

export const MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS = 8;

export const recipeInstallationIdSchema = z
  .string()
  .regex(
    /^recipe_installation_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Recipe installation ID.",
  );

const recipeTargetSchema = registryArtifactCoordinateSchema
  .extend({
    digest: sha256DigestSchema,
    kind: z.literal("recipe"),
    registry: recipeRegistryOriginSchema,
  })
  .describe("One exact immutable Recipe version at the configured canonical Registry origin.");

const skillTargetSchema = registryArtifactCoordinateSchema.extend({
  digest: sha256DigestSchema,
  kind: z.literal("skill"),
  registry: recipeRegistryOriginSchema,
});

const recipeParameterValuesSchema = z
  .record(
    agentBlueprintParameterNameSchema,
    z.union([z.string().max(2_048), z.number().finite(), z.boolean()]),
  )
  .refine((parameters) => Object.keys(parameters).length <= 16, "Too many Recipe parameters.");

const recipeConnectionBindingSchema = z.strictObject({
  connectionId: connectionIdSchema,
  slot: z.string().min(1).max(40),
});

export const recipeBriefBindingSchema = z.strictObject({
  brief: briefReferenceSchema,
  inputName: recipePackageSchema.shape.inputs.element.shape.name,
});
const recipeBriefBindingsSchema = z
  .array(recipeBriefBindingSchema)
  .max(16)
  .refine(
    (bindings) => new Set(bindings.map(({ inputName }) => inputName)).size === bindings.length,
    "Expected one exact Brief binding per Recipe input.",
  );

const recipeOperationSelectionSchema = z.strictObject({
  eventTriggers: z.array(recipeOperationNameSchema).max(8).default([]),
  schedules: z.array(recipeOperationNameSchema).max(8).default([]),
  timeZone: z.string().trim().min(1).max(120).optional(),
});

export const recipePreviewRequestSchema = z.strictObject({
  briefBindings: recipeBriefBindingsSchema.default([]),
  connectionBindings: z.array(recipeConnectionBindingSchema).max(8).default([]),
  operations: recipeOperationSelectionSchema.default({ eventTriggers: [], schedules: [] }),
  optionalSkills: z
    .array(
      z.strictObject({
        name: recipeNameSchema,
        namespace: recipePublisherNamespaceSchema,
      }),
    )
    .max(8)
    .default([]),
  parameters: recipeParameterValuesSchema.default({}),
  target: recipeTargetSchema,
});

const recipeToolMcpPreviewRequestSchema = z.strictObject({
  ...recipePreviewRequestSchema.shape,
  target: recipeTargetSchema.meta({ description: undefined }),
});

const recipeSourceSchema = z.strictObject({
  digest: sha256DigestSchema,
  registry: recipeRegistryOriginSchema,
  review: recipeRegistryProjectionSchema.shape.review,
  target: registryArtifactCoordinateSchema.extend({ kind: z.literal("recipe") }),
});

const recipePreviewSkillSchema = z.strictObject({
  license: z.string().min(1).max(160),
  localPackageDigest: sha256DigestSchema,
  name: recipeNameSchema,
  requirement: z.enum(["optional", "required"]),
  selected: z.boolean(),
  review: registrySkillProjectionSchema.shape.review,
  source: z.strictObject({
    digest: sha256DigestSchema,
    namespace: recipePublisherNamespaceSchema,
    version: recipeVersionSchema,
  }),
  warnings: registrySkillProjectionSchema.shape.warnings,
});

const recipePreviewConnectionSchema = z.strictObject({
  bound: z
    .strictObject({
      connectionId: connectionIdSchema,
      endpoint: z.url().max(2_048).nullable(),
      integration: z.string().min(1).max(128).nullable(),
      provider: z.enum(["composio", "remote_mcp"]),
      snapshotDigest: sha256DigestSchema.nullable(),
      status: connectionStatusSchema,
      toolCount: z.number().int().nonnegative().max(100).nullable(),
    })
    .nullable(),
  kind: z.enum(["composio", "remote_mcp"]),
  requestedAuthorization: z.enum(["approval_required", "standing"]),
  requirement: recipeConnectionRequirementSchema,
  slot: z.string().min(1).max(40),
  state: z.enum([
    "available",
    "missing",
    "provider_mismatch",
    "requirement_mismatch",
    "unavailable",
  ]),
});

export const recipeInstallationPlanSchema = z.strictObject({
  agent: z.strictObject({
    capabilities: agentCapabilityConfigurationsSchema,
    executionLimits: agentExecutionLimitsSchema,
    instructions: agentInstructionsSchema,
    name: agentNameSchema,
  }),
  authority: z.strictObject({
    createsConnections: z.literal(false),
    createsGrants: z.literal(false),
    requested: recipeRegistryProjectionSchema.shape.requestedAuthority,
    startsWork: z.literal(false),
  }),
  briefs: z
    .array(
      z.strictObject({
        bound: briefReferenceSchema.nullable(),
        description: recipePackageSchema.shape.inputs.element.shape.description,
        inputName: recipePackageSchema.shape.inputs.element.shape.name,
        required: z.boolean(),
        state: z.enum(["available", "combination_unavailable", "missing", "unavailable"]),
      }),
    )
    .max(16)
    .default([]),
  confirmationDigest: sha256DigestSchema,
  connections: z.array(recipePreviewConnectionSchema).max(8),
  operations: z.strictObject({
    eventTriggers: z.array(recipeEventTriggerSchema).max(8),
    primary: recipePrimaryOperationSchema,
    schedules: z.array(recipeScheduleSchema).max(8),
    timeZone: z.string().trim().min(1).max(120).nullable(),
  }),
  prerequisites: z
    .array(agentCapabilityPrerequisiteSchema.extend({ state: z.enum(["available", "missing"]) }))
    .max(32),
  ready: z.boolean(),
  recipe: recipeRegistryProjectionSchema,
  skills: z.array(recipePreviewSkillSchema).max(8),
  source: recipeSourceSchema,
});

const recipeInstalledSkillSchema = z.strictObject({
  id: skillIdSchema,
  sourceDigest: sha256DigestSchema,
  version: skillVersionSchema,
});

export const recipeInstallationReceiptSchema = z.strictObject({
  agent: z.strictObject({ id: agentIdSchema, revision: agentRevisionNumberSchema }).nullable(),
  briefs: recipeBriefBindingsSchema.default([]),
  connections: z.array(recipeConnectionBindingSchema).max(8),
  createdAt: z.iso.datetime(),
  id: recipeInstallationIdSchema,
  operationsRetained: z.strictObject({
    eventTriggers: z.array(recipeOperationNameSchema).max(8),
    schedules: z.array(recipeOperationNameSchema).max(8),
  }),
  planDigest: sha256DigestSchema,
  skills: z.array(recipeInstalledSkillSchema).max(8),
  source: recipeSourceSchema,
  status: z.enum(["installing", "installed"]),
  updatedAt: z.iso.datetime(),
});

export const recipeToolInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("search"), ...registrySearchQuerySchema.shape }),
  z.strictObject({ action: z.literal("inspect"), target: recipeTargetSchema }),
  z.strictObject({
    action: z.literal("read_skill"),
    path: skillFilePathSchema,
    target: skillTargetSchema,
  }),
  z.strictObject({ action: z.literal("preview"), request: recipePreviewRequestSchema }),
  z.strictObject({
    action: z.literal("install"),
    expectedConfirmationDigest: sha256DigestSchema,
    idempotencyKey: agentCreationIdempotencyKeySchema,
    request: recipePreviewRequestSchema,
  }),
  z.strictObject({
    action: z.literal("recover"),
    installationId: recipeInstallationIdSchema,
  }),
]);

export const recipeToolMcpInputSchema = z
  .strictObject({
    action: z
      .enum(["search", "inspect", "read_skill", "preview", "install", "recover"])
      .describe(
        "install(request, expectedConfirmationDigest, idempotencyKey). Preview can bind exact owner-local Briefs to selected recurring operations.",
      ),
    expectedConfirmationDigest: sha256DigestSchema.optional(),
    idempotencyKey: agentCreationIdempotencyKeySchema.optional(),
    installationId: recipeInstallationIdSchema.optional(),
    limit: registrySearchQuerySchema.shape.limit.removeDefault().optional().meta({ default: 10 }),
    path: skillFilePathSchema.meta({ description: undefined }).optional(),
    query: registrySearchQuerySchema.shape.query.optional(),
    request: recipeToolMcpPreviewRequestSchema.optional(),
    target: z
      .union([recipeTargetSchema.meta({ description: undefined }), skillTargetSchema])
      .optional(),
  })
  .superRefine((input, context) => {
    if (recipeToolInputSchema.safeParse(input).success) return;
    context.addIssue({
      code: "custom",
      message: "Fields must match the selected Recipe action.",
    });
  });

const recipeToolErrorSchema = z.strictObject({
  code: z.enum([
    "artifact_not_found",
    "artifact_restricted",
    "idempotency_conflict",
    "incompatible_schema",
    "installation_incomplete",
    "installation_limit_exceeded",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "plan_not_ready",
    "registry_unavailable",
    "stale_preview",
    "storage_unavailable",
  ]),
  message: z.literal("Recipe request denied."),
  recovery: z
    .strictObject({
      installationId: recipeInstallationIdSchema,
      retry: z.literal("recover"),
    })
    .optional(),
});

export const recipeToolResultSchema = z.union([
  z.strictObject({
    action: z.literal("search"),
    ok: z.literal(true),
    registry: recipeRegistryOriginSchema,
    response: registryRecipeSearchResponseSchema,
  }),
  z.strictObject({
    action: z.literal("inspect"),
    ok: z.literal(true),
    package: recipePackageSchema,
    recipe: recipeRegistryProjectionSchema,
  }),
  z.strictObject({
    action: z.literal("read_skill"),
    content: z.string().max(64 * 1_024),
    ok: z.literal(true),
    path: skillFilePathSchema,
    skill: registrySkillProjectionSchema,
  }),
  z.strictObject({
    action: z.literal("preview"),
    ok: z.literal(true),
    plan: recipeInstallationPlanSchema,
  }),
  z.strictObject({
    action: z.literal("install"),
    installationEvidence: z.enum(["created", "replayed"]),
    ok: z.literal(true),
    receipt: recipeInstallationReceiptSchema,
  }),
  z.strictObject({
    action: z.literal("recover"),
    installationEvidence: z.literal("recovered"),
    ok: z.literal(true),
    receipt: recipeInstallationReceiptSchema,
  }),
  z.strictObject({ error: recipeToolErrorSchema, ok: z.literal(false) }),
]);

export type RecipeInstallationPlan = z.infer<typeof recipeInstallationPlanSchema>;
export type RecipeInstallationReceipt = z.infer<typeof recipeInstallationReceiptSchema>;
export type RecipePreviewRequest = z.infer<typeof recipePreviewRequestSchema>;
export type RecipeToolInput = z.infer<typeof recipeToolInputSchema>;
export type RecipeToolResult = z.infer<typeof recipeToolResultSchema>;
