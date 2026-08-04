import {
  CLOUDFLARE_AI_MODEL_CATALOG_URL,
  CLOUDFLARE_AI_PRICING_URL,
  CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL,
  MAXIMUM_MODEL_BROWSE_ITEMS,
  MAXIMUM_MODEL_BROWSE_PAGES,
  MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS,
  browseCloudflareModelsInputSchema,
  browseCloudflareModelsResultSchema,
  cloudflareAiModelIdSchema,
  cloudflareModelCatalogItemSchema,
  configureModelCatalogInputSchema,
  configureModelCatalogResultSchema,
  getModelCatalogResultSchema,
  inspectCloudflareModelInputSchema,
  inspectCloudflareModelResultSchema,
  searchCloudflareModelsInputSchema,
  searchCloudflareModelsResultSchema,
  type CloudflareModelCatalogItem,
  type CloudflareModelBrowseItem,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import type { CloudflareModelDiscoveryClient, McpToolContext } from "./context.js";
import type { CloudflareUnifiedModelCatalogSnapshot } from "./cloudflare-unified-model-catalog.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_MODELS_TOOL_NAME = "crewhelm_models";
export const MCP_CONFIGURE_MODELS_TOOL_NAME = "crewhelm_configure_models";

type ModelToolContext = Pick<McpToolContext, "ai" | "authority" | "modelCatalog"> & {
  controlPlane: Pick<McpToolContext["controlPlane"], "configureModelCatalog" | "getModelCatalog">;
};

const providerCatalogPriceSchema = z.strictObject({
  currency: z.string().min(1).max(16),
  price: z.number().finite().nonnegative(),
  unit: z.string().min(1).max(120),
});
const providerCatalogPropertyValueSchema = z.union([
  z.string().min(1).max(2_000),
  z.number().finite(),
  z.boolean(),
  z.array(providerCatalogPriceSchema).max(16),
]);
const providerCatalogModelSchema = z.looseObject({
  created_at: z.string().min(1).max(64).nullable().optional(),
  description: z.string().max(2_000),
  id: z.string().min(3).max(160),
  name: z.string().min(1).max(240),
  properties: z
    .array(
      z.looseObject({
        property_id: z.string().min(1).max(120),
        value: providerCatalogPropertyValueSchema,
      }),
    )
    .max(64),
  tags: z.array(z.string().min(1).max(120)).max(64),
  task: z.looseObject({
    description: z.string().max(1_000),
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(120),
  }),
});
type ProviderCatalogModel = z.infer<typeof providerCatalogModelSchema>;

function propertyValue(value: z.infer<typeof providerCatalogPropertyValueSchema>): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function runnableModelId(model: ProviderCatalogModel): string | null {
  const current = cloudflareAiModelIdSchema.safeParse(model.name);
  if (current.success) return current.data;

  const legacy = cloudflareAiModelIdSchema.safeParse(model.id);
  return legacy.success ? legacy.data : null;
}

const modelReadInputSchema = z
  .strictObject({
    action: z.enum(["browse", "search", "inspect", "list-enabled"]),
    capability: browseCloudflareModelsInputSchema.shape.capability.optional(),
    includeDescriptions: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAXIMUM_MODEL_BROWSE_ITEMS).optional(),
    modelId: inspectCloudflareModelInputSchema.shape.modelId.optional(),
    page: z.number().int().min(1).max(MAXIMUM_MODEL_BROWSE_PAGES).optional(),
    platform: browseCloudflareModelsInputSchema.shape.platform.optional(),
    provider: searchCloudflareModelsInputSchema.shape.provider.optional(),
    query: searchCloudflareModelsInputSchema.shape.query.optional(),
    sort: z.enum(["relevance", "name", "newest", "oldest"]).optional(),
    task: searchCloudflareModelsInputSchema.shape.task.optional(),
  })
  .superRefine((input, context) => {
    const searchFields = [input.capability, input.provider, input.query, input.task];
    if (input.action === "inspect" && input.modelId === undefined) {
      context.addIssue({ code: "custom", message: "Inspect requires modelId.", path: ["modelId"] });
    }
    if (input.action !== "inspect" && input.modelId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only inspect accepts modelId.",
        path: ["modelId"],
      });
    }
    if (
      input.action !== "search" &&
      input.action !== "browse" &&
      searchFields.some((value) => value !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Only browse and search accept catalog filters.",
      });
    }
    if (
      input.action !== "browse" &&
      [input.includeDescriptions, input.page, input.platform, input.sort].some(
        (value) => value !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Only browse accepts paging and platform fields.",
      });
    }
  });
const modelReadResultSchema = z.union([
  browseCloudflareModelsResultSchema,
  searchCloudflareModelsResultSchema,
  inspectCloudflareModelResultSchema,
  getModelCatalogResultSchema,
]);

function normalized(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
}

function facet(values: string[]): { count: number; value: string }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ count, value }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function browseMatches(
  model: CloudflareModelBrowseItem,
  input: z.infer<typeof browseCloudflareModelsInputSchema>,
): boolean {
  if (input.capability !== undefined && !model.capabilities.includes(input.capability))
    return false;
  if (input.platform !== undefined && model.platform !== input.platform) return false;
  if (input.provider !== undefined && normalized(model.provider) !== normalized(input.provider)) {
    return false;
  }
  if (input.task !== undefined && !normalized(model.task).includes(normalized(input.task)))
    return false;
  if (input.query !== undefined) {
    const facts = normalized(`${model.id} ${model.name} ${model.description} ${model.provider}`);
    if (!facts.includes(normalized(input.query))) return false;
  }
  return true;
}

function browseOrder(
  sort: z.infer<typeof browseCloudflareModelsInputSchema>["sort"],
  query: string | undefined,
): (left: CloudflareModelBrowseItem, right: CloudflareModelBrowseItem) => number {
  if (sort === "name") {
    return (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  }
  if (sort === "relevance") {
    const queryValue = query === undefined ? "" : normalized(query);
    const score = (model: CloudflareModelBrowseItem) => {
      if (queryValue.length === 0) return 0;
      const id = normalized(model.id);
      const name = normalized(model.name);
      if (id === queryValue || name === queryValue) return 100;
      if (id.startsWith(queryValue) || name.startsWith(queryValue)) return 50;
      return [id, name, normalized(model.provider), normalized(model.description)].reduce(
        (total, fact) => total + (fact.includes(queryValue) ? 10 : 0),
        0,
      );
    };
    return (left, right) => {
      const relevance = score(right) - score(left);
      if (relevance !== 0) return relevance;
      const evidence =
        Number(right.runtimeCompatibilityEvidence === "declared-tool-support") -
        Number(left.runtimeCompatibilityEvidence === "declared-tool-support");
      if (evidence !== 0) return evidence;
      if (left.createdAt === null && right.createdAt !== null) return 1;
      if (left.createdAt !== null && right.createdAt === null) return -1;
      return (
        (right.createdAt ?? "").localeCompare(left.createdAt ?? "") ||
        left.id.localeCompare(right.id)
      );
    };
  }
  const direction = sort === "oldest" ? 1 : -1;
  return (left, right) => {
    if (left.createdAt === null && right.createdAt !== null) return 1;
    if (left.createdAt !== null && right.createdAt === null) return -1;
    const dates = (left.createdAt ?? "").localeCompare(right.createdAt ?? "") * direction;
    return dates || left.id.localeCompare(right.id);
  };
}

async function browse(
  ai: CloudflareModelDiscoveryClient | undefined,
  modelCatalog: { read(): Promise<CloudflareUnifiedModelCatalogSnapshot> } | undefined,
  input: z.infer<typeof browseCloudflareModelsInputSchema>,
): Promise<z.infer<typeof browseCloudflareModelsResultSchema>> {
  if (modelCatalog === undefined) {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }
  try {
    const retrievedAt = new Date().toISOString();
    const snapshot = await modelCatalog.read();
    const models = [...snapshot.models, ...(await browseWorkersAiModels(ai))]
      .filter((model) => model.runtimeCompatibility === "compatible")
      .filter((model) => browseMatches(model, input))
      .toSorted(browseOrder(input.sort, input.query));
    const offset = (input.page - 1) * input.limit;
    const pageModels = models
      .slice(offset, offset + input.limit)
      .map((model) =>
        input.includeDescriptions
          ? model
          : Object.fromEntries(Object.entries(model).filter(([key]) => key !== "description")),
      );
    return browseCloudflareModelsResultSchema.parse({
      facets: {
        capabilities: facet(models.flatMap((model) => model.capabilities)),
        platforms: facet(models.map((model) => model.platform)),
        providers: facet(models.map((model) => model.provider)),
        tasks: facet(models.map((model) => model.task)),
      },
      models: pageModels,
      nextPage: offset + pageModels.length < models.length ? input.page + 1 : null,
      ok: true,
      page: input.page,
      retrievedAt,
      snapshot: {
        refreshedAt: snapshot.refreshedAt,
        sourceCommit: snapshot.sourceCommit,
        sourceUrl: snapshot.sourceUrl,
        status: snapshot.status,
      },
      source: CLOUDFLARE_AI_MODEL_CATALOG_URL,
      total: models.length,
    });
  } catch {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }
}

function providerCreatedAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalizedDate = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalizedDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function providerBrowseItem(model: ProviderCatalogModel): CloudflareModelBrowseItem | null {
  const detailed = catalogItem(model, new Date().toISOString());
  if (
    detailed === null ||
    detailed.platform !== "cloudflare-hosted" ||
    detailed.runtimeCompatibility !== "compatible"
  )
    return null;
  return {
    capabilities: [
      ...(detailed.capabilities.functionCalling === "declared-supported"
        ? (["function-calling"] as const)
        : []),
      ...(detailed.capabilities.reasoning === "declared-supported" ? (["reasoning"] as const) : []),
      ...(detailed.capabilities.vision === "declared-supported" ? (["vision"] as const) : []),
    ],
    createdAt: providerCreatedAt(model.created_at),
    description: model.description.replaceAll(/\s+/g, " ").trim().slice(0, 500),
    freshness: "live",
    id: detailed.id,
    name: detailed.name.split("/").at(-1) ?? detailed.name,
    platform: detailed.platform,
    provider: detailed.provider,
    requestFormats: [],
    runtimeCompatibility: detailed.runtimeCompatibility,
    runtimeCompatibilityEvidence: detailed.runtimeCompatibilityEvidence,
    task: detailed.task.name,
  };
}

async function browseWorkersAiModels(
  ai: CloudflareModelDiscoveryClient | undefined,
): Promise<CloudflareModelBrowseItem[]> {
  if (ai === undefined) return [];
  const models: CloudflareModelBrowseItem[] = [];
  try {
    for (let page = 1, scanned = 0; scanned < MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS; page += 1) {
      const rawPage = (await ai.models({ page, per_page: 50 })).slice(0, 50);
      scanned += rawPage.length;
      for (const raw of rawPage) {
        const parsed = providerCatalogModelSchema.safeParse(raw);
        if (!parsed.success) continue;
        const item = providerBrowseItem(parsed.data);
        if (item !== null) models.push(item);
      }
      if (rawPage.length < 50) break;
    }
  } catch {
    return [];
  }
  return models;
}

function normalizedFacts(model: ProviderCatalogModel): string {
  return [
    model.name,
    model.description,
    model.task.id,
    model.task.name,
    ...model.tags,
    ...model.properties.flatMap((property) => [
      property.property_id,
      propertyValue(property.value),
    ]),
  ]
    .join(" ")
    .toLowerCase()
    .replaceAll(/[_-]+/g, " ");
}

function declared(facts: string, capability: "function calling" | "reasoning" | "vision") {
  return facts.includes(capability) ? ("declared-supported" as const) : ("unspecified" as const);
}

function providerFrom(modelId: string): string {
  const parts = modelId.split("/");
  return modelId.startsWith("@") ? (parts[1] ?? modelId) : (parts[0] ?? modelId);
}

function catalogItem(
  model: ProviderCatalogModel,
  retrievedAt: string,
): CloudflareModelCatalogItem | null {
  const modelId = runnableModelId(model);
  if (modelId === null) return null;

  const facts = normalizedFacts(model);
  const taskFacts = `${model.task.id} ${model.task.name}`.toLowerCase().replaceAll(/[_-]+/g, " ");
  const pricingFacts = model.properties
    .filter(({ property_id }) => /(price|pricing|cost)/i.test(property_id))
    .slice(0, 16)
    .map(({ property_id, value }) => ({ name: property_id, value: propertyValue(value) }));
  const textGeneration = taskFacts.includes("text generation");
  const declaresTools = declared(facts, "function calling") === "declared-supported";
  const item = cloudflareModelCatalogItemSchema.safeParse({
    availability: "available",
    capabilities: {
      functionCalling: declared(facts, "function calling"),
      reasoning: declared(facts, "reasoning"),
      vision: declared(facts, "vision"),
    },
    description: model.description,
    id: modelId,
    name: model.name,
    platform: modelId.startsWith("@") ? "cloudflare-hosted" : "third-party",
    pricing: {
      facts: pricingFacts,
      retrievedAt,
      source:
        pricingFacts.length > 0
          ? CLOUDFLARE_AI_MODEL_CATALOG_URL
          : modelId.startsWith("@")
            ? CLOUDFLARE_AI_PRICING_URL
            : CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL,
      status: pricingFacts.length === 0 ? "reference-only" : "catalog-reported",
    },
    provider: providerFrom(modelId),
    runtimeCompatibility: textGeneration && declaresTools ? "compatible" : "incompatible",
    runtimeCompatibilityEvidence: !textGeneration
      ? "unsupported-task"
      : declaresTools
        ? "declared-tool-support"
        : "tool-support-undeclared",
    source: { catalog: CLOUDFLARE_AI_MODEL_CATALOG_URL, retrievedAt },
    task: model.task,
  });
  return item.success ? item.data : null;
}

function browseCatalogItem(
  model: CloudflareModelBrowseItem,
  retrievedAt: string,
): CloudflareModelCatalogItem {
  const capability = (name: "function-calling" | "reasoning" | "vision") =>
    model.capabilities.includes(name) ? ("declared-supported" as const) : ("unspecified" as const);
  return cloudflareModelCatalogItemSchema.parse({
    availability: "available",
    capabilities: {
      functionCalling: capability("function-calling"),
      reasoning: capability("reasoning"),
      vision: capability("vision"),
    },
    description: model.description,
    id: model.id,
    name: model.name,
    platform: model.platform,
    pricing: {
      facts: [],
      retrievedAt,
      source:
        model.platform === "cloudflare-hosted"
          ? CLOUDFLARE_AI_PRICING_URL
          : CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL,
      status: "reference-only",
    },
    provider: model.provider,
    runtimeCompatibility: model.runtimeCompatibility,
    runtimeCompatibilityEvidence: model.runtimeCompatibilityEvidence,
    source: { catalog: CLOUDFLARE_AI_MODEL_CATALOG_URL, retrievedAt },
    task: {
      description: model.task,
      id: normalized(model.task).replaceAll(" ", "-"),
      name: model.task,
    },
  });
}

function matchesCapability(
  model: CloudflareModelCatalogItem,
  capability: "function-calling" | "reasoning" | "vision" | undefined,
): boolean {
  switch (capability) {
    case "function-calling":
      return model.capabilities.functionCalling === "declared-supported";
    case "reasoning":
      return model.capabilities.reasoning === "declared-supported";
    case "vision":
      return model.capabilities.vision === "declared-supported";
    case undefined:
      return true;
  }

  capability satisfies never;
  throw new Error("Invariant violated: unsupported model capability filter.");
}

async function discover(
  ai: CloudflareModelDiscoveryClient | undefined,
  input: z.infer<typeof searchCloudflareModelsInputSchema>,
): Promise<z.infer<typeof searchCloudflareModelsResultSchema>> {
  const retrievedAt = new Date().toISOString();
  const models: CloudflareModelCatalogItem[] = [];
  let scanned = 0;

  if (ai === undefined) {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }

  try {
    for (let page = 1; scanned < MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS; page += 1) {
      const providerPage = await ai.models({
        ...(input.provider === undefined ? {} : { author: input.provider }),
        page,
        per_page: 50,
        ...(input.query === undefined ? {} : { search: input.query }),
        ...(input.task === undefined ? {} : { task: input.task }),
      });
      const pageModels = providerPage.slice(0, 50);
      scanned += pageModels.length;
      for (const raw of pageModels) {
        const bounded = providerCatalogModelSchema.safeParse(raw);
        if (!bounded.success) continue;
        const item = catalogItem(bounded.data, retrievedAt);
        if (item === null) continue;
        if (matchesCapability(item, input.capability)) models.push(item);
        if (models.length === input.limit) break;
      }
      if (models.length === input.limit || pageModels.length < 50) break;
    }
  } catch {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }

  return searchCloudflareModelsResultSchema.parse({ models, ok: true, scanned });
}

async function inspect(
  ai: CloudflareModelDiscoveryClient | undefined,
  modelCatalog: { read(): Promise<CloudflareUnifiedModelCatalogSnapshot> } | undefined,
  modelId: string,
): Promise<z.infer<typeof inspectCloudflareModelResultSchema>> {
  const retrievedAt = new Date().toISOString();

  if (!modelId.startsWith("@") && modelCatalog !== undefined) {
    try {
      const exact = (await modelCatalog.read()).models.find((model) => model.id === modelId);
      if (exact !== undefined) {
        return inspectCloudflareModelResultSchema.parse({
          model: browseCatalogItem(exact, retrievedAt),
          ok: true,
        });
      }
    } catch {
      if (ai === undefined) {
        return {
          error: {
            code: "catalog_unavailable",
            message: "Cloudflare model discovery request denied.",
          },
          ok: false,
        };
      }
    }
  }

  if (ai !== undefined) {
    try {
      for (let page = 1, scanned = 0; scanned < MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS; page += 1) {
        const providerPage = await ai.models({ page, per_page: 50, search: modelId });
        const pageModels = providerPage.slice(0, 50);
        scanned += pageModels.length;
        const rawExact = pageModels.find(
          (candidate) =>
            typeof candidate === "object" &&
            candidate !== null &&
            (("id" in candidate && candidate.id === modelId) ||
              ("name" in candidate && candidate.name === modelId)),
        );
        const exact = providerCatalogModelSchema.safeParse(rawExact);
        if (rawExact !== undefined && !exact.success) {
          return {
            error: {
              code: "catalog_unavailable",
              message: "Cloudflare model discovery request denied.",
            },
            ok: false,
          };
        }
        if (exact.success) {
          const item = catalogItem(exact.data, retrievedAt);
          if (item === null) {
            return {
              error: {
                code: "catalog_unavailable",
                message: "Cloudflare model discovery request denied.",
              },
              ok: false,
            };
          }
          return inspectCloudflareModelResultSchema.parse({ model: item, ok: true });
        }
        if (pageModels.length < 50) break;
      }
    } catch {
      return {
        error: {
          code: "catalog_unavailable",
          message: "Cloudflare model discovery request denied.",
        },
        ok: false,
      };
    }
  }

  if (ai === undefined && modelCatalog === undefined) {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }

  return {
    error: { code: "model_unavailable", message: "Cloudflare model discovery request denied." },
    ok: false,
  };
}

export function registerModelTools(server: McpServer, context: ModelToolContext): void {
  const { ai, authority, controlPlane, modelCatalog } = context;

  server.registerTool(
    MCP_MODELS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Browse the compact unified Cloudflare AI catalog, search detailed Workers AI metadata, inspect one exact model, or list the owner's enabled model catalog. Provider metadata is untrusted and source-timestamped; Crewhelm does not label models tested or untested.",
      inputSchema: modelReadInputSchema,
      title: "Discover Cloudflare AI models",
    },
    async (input) => {
      switch (input.action) {
        case "browse":
          return controlPlaneToolResult(
            () =>
              browse(
                ai,
                modelCatalog,
                browseCloudflareModelsInputSchema.parse({
                  capability: input.capability,
                  includeDescriptions: input.includeDescriptions,
                  limit: input.limit,
                  page: input.page,
                  platform: input.platform,
                  provider: input.provider,
                  query: input.query,
                  sort: input.sort,
                  task: input.task,
                }),
              ),
            modelReadResultSchema,
          );
        case "search":
          return controlPlaneToolResult(
            () =>
              discover(
                ai,
                searchCloudflareModelsInputSchema.parse({
                  capability: input.capability,
                  limit: input.limit,
                  provider: input.provider,
                  query: input.query,
                  task: input.task,
                }),
              ),
            modelReadResultSchema,
          );
        case "inspect":
          return controlPlaneToolResult(
            () =>
              inspect(
                ai,
                modelCatalog,
                inspectCloudflareModelInputSchema.parse({ modelId: input.modelId }).modelId,
              ),
            modelReadResultSchema,
          );
        case "list-enabled":
          return controlPlaneToolResult(
            () =>
              controlPlane.getModelCatalog?.(authority, { target: { kind: "model-catalog" } }) ??
              Promise.resolve({
                error: { code: "incompatible_schema", message: "Model catalog request denied." },
                ok: false,
              }),
            modelReadResultSchema,
          );
      }

      input.action satisfies never;
      throw new Error("Invariant violated: unsupported model catalog action.");
    },
  );

  server.registerTool(
    MCP_CONFIGURE_MODELS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Preview or apply one owner model-catalog add, remove, or default change. Removing a model previews affected current Agents and preserves immutable Agent revisions.",
      inputSchema: configureModelCatalogInputSchema,
      title: "Configure enabled models",
    },
    (input) =>
      controlPlaneToolResult(async () => {
        if (input.change.kind === "add") {
          const discovery = await inspect(ai, modelCatalog, input.change.modelId);
          if (!discovery.ok) {
            return {
              error: {
                code: "model_unavailable",
                message: "Model catalog request denied.",
              },
              ok: false,
            };
          }
          if (discovery.model.runtimeCompatibility === "incompatible") {
            return {
              error: {
                code: "model_incompatible",
                message: "Model catalog request denied.",
              },
              ok: false,
            };
          }
        }
        return (
          controlPlane.configureModelCatalog?.(authority, input) ??
          Promise.resolve({
            error: { code: "incompatible_schema", message: "Model catalog request denied." },
            ok: false,
          })
        );
      }, configureModelCatalogResultSchema),
  );
}
