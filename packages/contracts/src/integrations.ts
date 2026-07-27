import * as z from "zod";

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

      const prototype = Object.getPrototypeOf(current.value);

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
export const inspectIntegrationToolInputSchema = z.strictObject({
  slug: integrationToolSlugSchema,
  version: integrationToolkitVersionSchema,
});
export const integrationToolInspectionSchema = integrationToolCatalogItemSchema.extend({
  inputParameters: integrationToolParameterMapSchema,
  outputParameters: integrationToolParameterMapSchema,
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
export type IntegrationCatalogItem = z.infer<typeof integrationCatalogItemSchema>;
export type IntegrationCatalogSearchInput = z.infer<typeof integrationCatalogSearchInputSchema>;
export type IntegrationCatalogSearchResult = z.infer<typeof integrationCatalogSearchResultSchema>;
export type IntegrationToolCatalogItem = z.infer<typeof integrationToolCatalogItemSchema>;
export type IntegrationToolInspection = z.infer<typeof integrationToolInspectionSchema>;
export type IntegrationToolSearchInput = z.infer<typeof integrationToolSearchInputSchema>;
export type IntegrationToolSearchResult = z.infer<typeof integrationToolSearchResultSchema>;
