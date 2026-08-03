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
    idempotencyKey: z.uuid(),
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
export type RegistryPublishResult = z.infer<typeof registryPublishResultSchema>;
export type RegistryRecipeSearchResponse = z.infer<typeof registryRecipeSearchResponseSchema>;
export type RegistryRecipeSearchResult = z.infer<typeof registryRecipeSearchResultSchema>;
export type RegistrySearchQuery = z.infer<typeof registrySearchQuerySchema>;
