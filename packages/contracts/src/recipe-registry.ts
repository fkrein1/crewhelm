import * as z from "zod";

import {
  recipePackageSchema,
  recipePublisherNamespaceSchema,
  recipeRegistryProjectionSchema,
  recipeVersionSchema,
  registryArtifactKindSchema,
  registryArtifactVersionEnvelopeSchema,
  registrySkillPackageSchema,
  registrySkillProjectionSchema,
} from "./recipes.js";

export const MAXIMUM_REGISTRY_SEARCH_QUERY_CHARACTERS = 256;
export const MAXIMUM_REGISTRY_SEARCH_RESULTS = 25;
export const MAXIMUM_REGISTRY_PUBLISH_SKILLS = 8;

export const registryPublishAuthorizationIdSchema = z
  .string()
  .regex(
    /^publish_authorization_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Registry publishing authorization ID.",
  );
export const registryPublishVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected a base64url publishing verifier.");
export const registryPublishChallengeSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]+$/, "Expected a lowercase SHA-256 publishing challenge.");
export const registryPublishIdempotencyKeySchema = z
  .uuid()
  .describe("A UUID that identifies one immutable Registry publication attempt.");

export const registryCreatePublishAuthorizationSchema = z.strictObject({
  challenge: registryPublishChallengeSchema,
  idempotencyKey: registryPublishIdempotencyKeySchema,
  installationLabel: z.string().trim().min(1).max(120),
});

export const registryPublishAuthorizationSchema = z.strictObject({
  authorizationUrl: z.url().max(2_048),
  expiresAt: z.iso.datetime(),
  id: registryPublishAuthorizationIdSchema,
});

export const registryResolvePublishAuthorizationSchema = z.strictObject({
  verifier: registryPublishVerifierSchema,
});

export const registryResolvedPublishAuthorizationSchema = z.strictObject({
  expiresAt: z.iso.datetime(),
  id: registryPublishAuthorizationIdSchema,
  publisher: recipeRegistryProjectionSchema.shape.publisher,
});

export const registrySearchQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(MAXIMUM_REGISTRY_SEARCH_RESULTS).default(10),
  query: z.string().trim().min(2).max(MAXIMUM_REGISTRY_SEARCH_QUERY_CHARACTERS),
});

export const registrySearchMatchReasonSchema = z.enum([
  "capability",
  "deliverable",
  "integration",
  "outcome",
  "tag",
  "title",
]);

export const registryRecipeSearchResultSchema = z.strictObject({
  matchReasons: z.array(registrySearchMatchReasonSchema).max(6),
  recipe: recipeRegistryProjectionSchema,
  score: z.number().min(0).max(1),
});

export const registryRecipeSearchResponseSchema = z.strictObject({
  query: z.string().min(2).max(MAXIMUM_REGISTRY_SEARCH_QUERY_CHARACTERS),
  results: z.array(registryRecipeSearchResultSchema).max(MAXIMUM_REGISTRY_SEARCH_RESULTS),
  retrieval: z.enum(["lexical_fallback", "semantic"]),
  searchVersion: z.literal(1),
});

export const registryRecipeListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(MAXIMUM_REGISTRY_SEARCH_RESULTS).default(25),
});

export const registryRecipeListResponseSchema = z.strictObject({
  listVersion: z.literal(1),
  recipes: z.array(recipeRegistryProjectionSchema).max(MAXIMUM_REGISTRY_SEARCH_RESULTS),
});

export const registryPublishRecipeSchema = z.strictObject({
  package: recipePackageSchema,
  version: recipeVersionSchema,
});

export const registryPublishSkillSchema = z.strictObject({
  package: registrySkillPackageSchema,
  version: recipeVersionSchema,
});

export const registryPublishBundleSchema = z
  .strictObject({
    idempotencyKey: registryPublishIdempotencyKeySchema,
    namespace: recipePublisherNamespaceSchema,
    recipe: registryPublishRecipeSchema,
    skills: z.array(registryPublishSkillSchema).max(MAXIMUM_REGISTRY_PUBLISH_SKILLS),
  })
  .superRefine((bundle, context) => {
    const identities = bundle.skills.map(({ package: skillPackage }) => skillPackage.name);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: "custom", message: "A publish bundle cannot repeat a Skill." });
    }
  });

export const registryPublishResultSchema = z.strictObject({
  artifacts: z.array(registryArtifactVersionEnvelopeSchema).min(1).max(9),
  recipe: recipeRegistryProjectionSchema,
  semanticIndex: z.enum(["indexed", "pending"]),
});

export const registryArtifactProjectionSchema = z.union([
  recipeRegistryProjectionSchema.transform((projection) => ({
    ...projection,
    kind: "recipe" as const,
  })),
  registrySkillProjectionSchema.transform((projection) => ({
    ...projection,
    kind: "skill" as const,
  })),
]);

export const registryArtifactPathSchema = z.strictObject({
  kind: registryArtifactKindSchema,
  name: z.string().min(1).max(80),
  namespace: recipePublisherNamespaceSchema,
  version: recipeVersionSchema,
});

export type RegistryPublishBundle = z.infer<typeof registryPublishBundleSchema>;
export type RegistryPublishAuthorization = z.infer<typeof registryPublishAuthorizationSchema>;
export type RegistryPublishResult = z.infer<typeof registryPublishResultSchema>;
export type RegistryResolvedPublishAuthorization = z.infer<
  typeof registryResolvedPublishAuthorizationSchema
>;
export type RegistryRecipeSearchResponse = z.infer<typeof registryRecipeSearchResponseSchema>;
export type RegistryRecipeSearchResult = z.infer<typeof registryRecipeSearchResultSchema>;
export type RegistryRecipeListResponse = z.infer<typeof registryRecipeListResponseSchema>;
export type RegistrySearchQuery = z.infer<typeof registrySearchQuerySchema>;
