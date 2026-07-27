import * as z from "zod";

export const integrationCatalogCursorSchema = z.string().min(1).max(2_048);
export const integrationCatalogSearchInputSchema = z.strictObject({
  cursor: integrationCatalogCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  query: z.string().trim().min(3).max(160).optional(),
});
export const integrationSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/, "Expected a Composio integration slug.");
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
export const integrationToolSearchInputSchema = z.strictObject({
  cursor: integrationCatalogCursorSchema.optional(),
  integrationSlug: integrationSlugSchema.optional(),
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

export type IntegrationCatalogItem = z.infer<typeof integrationCatalogItemSchema>;
export type IntegrationCatalogSearchInput = z.infer<typeof integrationCatalogSearchInputSchema>;
export type IntegrationCatalogSearchResult = z.infer<typeof integrationCatalogSearchResultSchema>;
export type IntegrationToolCatalogItem = z.infer<typeof integrationToolCatalogItemSchema>;
export type IntegrationToolSearchInput = z.infer<typeof integrationToolSearchInputSchema>;
export type IntegrationToolSearchResult = z.infer<typeof integrationToolSearchResultSchema>;
