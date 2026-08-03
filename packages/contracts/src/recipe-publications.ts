import * as z from "zod";

import { sha256DigestSchema } from "./capabilities.js";
import { agentIdSchema, agentRevisionNumberSchema } from "./control-plane.js";
import { agentScheduleIdSchema } from "./schedule-revision.js";
import { agentEventTriggerIdSchema } from "./agent-event-triggers.js";
import {
  recipeLicenseSchema,
  recipePackageSchema,
  recipeRegistryOriginSchema,
  recipeSkillDependencySchema,
  recipeVersionSchema,
  registrySkillPackageSchema,
  registrySkillProjectionSchema,
} from "./recipes.js";
import {
  registryPublishAuthorizationIdSchema,
  registryPublishAuthorizationSchema,
  registryPublishIdempotencyKeySchema,
  registryPublishResultSchema,
  registryResolvedPublishAuthorizationSchema,
} from "./recipe-registry.js";
import { skillFilePathSchema, skillIdSchema, skillVersionSchema } from "./skills.js";

const localSkillTargetSchema = z.strictObject({
  id: skillIdSchema,
  version: skillVersionSchema,
});

export const recipePublicationSkillDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("publish"),
    license: recipeLicenseSchema,
    local: localSkillTargetSchema,
    requirement: z.enum(["optional", "required"]),
  }),
  z.strictObject({
    decision: z.literal("reference"),
    local: localSkillTargetSchema,
    requirement: z.enum(["optional", "required"]),
    target: recipeSkillDependencySchema.omit({ requirement: true }),
  }),
  z.strictObject({
    decision: z.literal("remove"),
    local: localSkillTargetSchema,
  }),
]);

const { skills: _recipeSkills, ...recipePublicationDraftShape } = recipePackageSchema.shape;

export const recipePublicationCandidateSchema = z.strictObject({
  agent: z.strictObject({ id: agentIdSchema, revision: agentRevisionNumberSchema }),
  recipe: z.strictObject(recipePublicationDraftShape),
  skills: z
    .array(recipePublicationSkillDecisionSchema)
    .max(8)
    .refine(
      (decisions) =>
        new Set(decisions.map(({ local }) => `${local.id}:${local.version}`)).size ===
        decisions.length,
      "Expected one decision for each local Skill.",
    ),
});

const recipePublicationSourceSchema = z.strictObject({
  id: agentIdSchema,
  revision: agentRevisionNumberSchema,
});

export const recipePublicationToolInputSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("prepare_publish"),
    agent: recipePublicationSourceSchema,
    eventTriggerIds: z
      .array(agentEventTriggerIdSchema)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, "Expected unique Event Trigger IDs.")
      .default([]),
    license: recipeLicenseSchema,
    scheduleIds: z
      .array(agentScheduleIdSchema)
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, "Expected unique Schedule IDs.")
      .default([]),
  }),
  z.strictObject({
    action: z.literal("authorize_publish"),
    idempotencyKey: registryPublishIdempotencyKeySchema,
    installationLabel: z.string().trim().min(1).max(120),
  }),
  z.strictObject({
    action: z.literal("preview_publish"),
    authorizationId: registryPublishAuthorizationIdSchema,
    candidate: recipePublicationCandidateSchema,
    idempotencyKey: registryPublishIdempotencyKeySchema,
  }),
  z.strictObject({
    action: z.literal("publish"),
    authorizationId: registryPublishAuthorizationIdSchema,
    candidate: recipePublicationCandidateSchema,
    expectedConfirmationDigest: sha256DigestSchema,
    idempotencyKey: registryPublishIdempotencyKeySchema,
  }),
]);

export const recipePublicationToolMcpInputSchema = z.strictObject({
  request: z
    .string()
    .min(2)
    .max(160 * 1_024)
    .describe(
      "JSON action. Start with prepare_publish(agent,license,scheduleIds?,eventTriggerIds?) to copy a live Agent revision into a reviewable candidate; then authorize_publish(idempotencyKey,installationLabel); preview_publish(authorizationId,candidate,idempotencyKey); and publish with the unchanged candidate plus expectedConfirmationDigest.",
    ),
});

const publicSkillPreviewSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("publish"),
    digest: sha256DigestSchema,
    filePaths: z.array(skillFilePathSchema).max(64),
    license: recipeLicenseSchema,
    local: localSkillTargetSchema,
    name: registrySkillPackageSchema.shape.name,
    provenance: registrySkillPackageSchema.shape.provenance,
    requirement: z.enum(["optional", "required"]),
    sizeBytes: z.number().int().positive(),
    version: recipeVersionSchema,
    warnings: registrySkillProjectionSchema.shape.warnings,
  }),
  z.strictObject({
    decision: z.literal("reference"),
    local: localSkillTargetSchema,
    requirement: z.enum(["optional", "required"]),
    target: recipeSkillDependencySchema.omit({ requirement: true }),
  }),
  z.strictObject({ decision: z.literal("remove"), local: localSkillTargetSchema }),
]);

export const recipePublicationPlanSchema = z.strictObject({
  authorization: registryResolvedPublishAuthorizationSchema,
  confirmationDigest: sha256DigestSchema,
  exclusions: z
    .array(
      z.enum([
        "briefs",
        "connection_credentials",
        "grants",
        "history",
        "owner_local_ids",
        "runtime_telemetry",
      ]),
    )
    .length(6),
  recipe: z.strictObject({ package: recipePackageSchema, version: recipeVersionSchema }),
  ready: z.boolean(),
  blockingReasons: z.array(z.enum(["skill_removal_rehearsal_required"])).max(1),
  registry: recipeRegistryOriginSchema,
  skills: z.array(publicSkillPreviewSchema).max(8),
  source: recipePublicationCandidateSchema.shape.agent,
});

const recipePublicationErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "authorization_pending",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "no_changes",
    "owner_mismatch",
    "public_package_invalid",
    "rehearsal_required",
    "registry_conflict",
    "registry_unavailable",
    "skill_decisions_incomplete",
    "skill_mismatch",
    "skill_not_found",
    "stale_preview",
    "storage_unavailable",
  ]),
  message: z.literal("Recipe publication request denied."),
});

export const recipePublicationToolResultSchema = z.union([
  z.strictObject({
    action: z.literal("prepare_publish"),
    candidate: recipePublicationCandidateSchema,
    nextAction: z.literal("preview_publish"),
    ok: z.literal(true),
    review: z.strictObject({
      connections: z.literal("Review portable requirements and requested authority."),
      publicCopy: z.literal("Review the title, summary, outcome, boundaries, tags, and sample."),
      skills: z.literal("Choose publish, reference, or remove for every local Skill."),
    }),
  }),
  z.strictObject({
    action: z.literal("authorize_publish"),
    authorization: registryPublishAuthorizationSchema,
    ok: z.literal(true),
  }),
  z.strictObject({
    action: z.literal("preview_publish"),
    ok: z.literal(true),
    plan: recipePublicationPlanSchema,
  }),
  z.strictObject({
    action: z.literal("publish"),
    ok: z.literal(true),
    publication: registryPublishResultSchema,
  }),
  z.strictObject({ error: recipePublicationErrorSchema, ok: z.literal(false) }),
]);

export type RecipePublicationCandidate = z.infer<typeof recipePublicationCandidateSchema>;
export type RecipePublicationPlan = z.infer<typeof recipePublicationPlanSchema>;
export type RecipePublicationSkillDecision = z.infer<typeof recipePublicationSkillDecisionSchema>;
export type RecipePublicationToolInput = z.infer<typeof recipePublicationToolInputSchema>;
export type RecipePublicationToolResult = z.infer<typeof recipePublicationToolResultSchema>;
