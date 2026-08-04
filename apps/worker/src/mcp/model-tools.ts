import {
  CLOUDFLARE_AI_MODEL_CATALOG_URL,
  CLOUDFLARE_AI_PRICING_URL,
  CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL,
  MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS,
  cloudflareModelCatalogItemSchema,
  configureModelCatalogInputSchema,
  configureModelCatalogResultSchema,
  getModelCatalogResultSchema,
  inspectCloudflareModelInputSchema,
  inspectCloudflareModelResultSchema,
  searchCloudflareModelsInputSchema,
  searchCloudflareModelsResultSchema,
  type CloudflareModelCatalogItem,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import type { CloudflareModelDiscoveryClient, McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_MODELS_TOOL_NAME = "crewhelm_models";
export const MCP_CONFIGURE_MODELS_TOOL_NAME = "crewhelm_configure_models";

type ModelToolContext = Pick<McpToolContext, "ai" | "authority"> & {
  controlPlane: Pick<McpToolContext["controlPlane"], "configureModelCatalog" | "getModelCatalog">;
};

const providerCatalogModelSchema = z.looseObject({
  description: z.string().max(2_000),
  id: z.string().min(3).max(160),
  name: z.string().min(1).max(240),
  properties: z
    .array(
      z.looseObject({
        property_id: z.string().min(1).max(120),
        value: z.string().min(1).max(240),
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

const modelReadInputSchema = z
  .strictObject({
    action: z.enum(["search", "inspect", "list-enabled"]),
    capability: searchCloudflareModelsInputSchema.shape.capability.optional(),
    limit: searchCloudflareModelsInputSchema.shape.limit.optional(),
    modelId: inspectCloudflareModelInputSchema.shape.modelId.optional(),
    provider: searchCloudflareModelsInputSchema.shape.provider.optional(),
    query: searchCloudflareModelsInputSchema.shape.query.optional(),
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
    if (input.action !== "search" && searchFields.some((value) => value !== undefined)) {
      context.addIssue({ code: "custom", message: "Only search accepts catalog filters." });
    }
  });
const modelReadResultSchema = z.union([
  searchCloudflareModelsResultSchema,
  inspectCloudflareModelResultSchema,
  getModelCatalogResultSchema,
]);

function normalizedFacts(model: ProviderCatalogModel): string {
  return [
    model.name,
    model.description,
    model.task.id,
    model.task.name,
    ...model.tags,
    ...model.properties.flatMap((property) => [property.property_id, property.value]),
  ]
    .join(" ")
    .toLowerCase()
    .replaceAll(/[_-]+/g, " ");
}

function declared(facts: string, capability: "function calling" | "reasoning" | "vision") {
  return facts.includes(capability) ? ("declared-supported" as const) : ("unspecified" as const);
}

function providerFrom(model: ProviderCatalogModel): string {
  const parts = model.id.split("/");
  return model.id.startsWith("@") ? (parts[1] ?? model.name) : (parts[0] ?? model.name);
}

function catalogItem(model: ProviderCatalogModel, retrievedAt: string): CloudflareModelCatalogItem {
  const facts = normalizedFacts(model);
  const taskFacts = `${model.task.id} ${model.task.name}`.toLowerCase().replaceAll(/[_-]+/g, " ");
  const pricingFacts = model.properties
    .filter(({ property_id }) => /(price|pricing|cost)/i.test(property_id))
    .slice(0, 16)
    .map(({ property_id, value }) => ({ name: property_id, value }));
  return cloudflareModelCatalogItemSchema.parse({
    availability: "available",
    capabilities: {
      functionCalling: declared(facts, "function calling"),
      reasoning: declared(facts, "reasoning"),
      vision: declared(facts, "vision"),
    },
    description: model.description,
    id: model.id,
    name: model.name,
    platform: model.id.startsWith("@") ? "cloudflare-hosted" : "third-party",
    pricing: {
      facts: pricingFacts,
      retrievedAt,
      source:
        pricingFacts.length > 0
          ? CLOUDFLARE_AI_MODEL_CATALOG_URL
          : model.id.startsWith("@")
            ? CLOUDFLARE_AI_PRICING_URL
            : CLOUDFLARE_AI_THIRD_PARTY_PRICING_URL,
      status: pricingFacts.length === 0 ? "reference-only" : "catalog-reported",
    },
    provider: providerFrom(model),
    runtimeCompatibility: taskFacts.includes("text generation") ? "compatible" : "incompatible",
    source: { catalog: CLOUDFLARE_AI_MODEL_CATALOG_URL, retrievedAt },
    task: model.task,
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
  modelId: string,
): Promise<z.infer<typeof inspectCloudflareModelResultSchema>> {
  if (ai === undefined) {
    return {
      error: { code: "catalog_unavailable", message: "Cloudflare model discovery request denied." },
      ok: false,
    };
  }

  const retrievedAt = new Date().toISOString();

  try {
    for (let page = 1, scanned = 0; scanned < MAXIMUM_MODEL_DISCOVERY_SCAN_ITEMS; page += 1) {
      const providerPage = await ai.models({ page, per_page: 50, search: modelId });
      const pageModels = providerPage.slice(0, 50);
      scanned += pageModels.length;
      const rawExact = pageModels.find(
        (candidate) =>
          typeof candidate === "object" && candidate !== null && candidate.id === modelId,
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
        return inspectCloudflareModelResultSchema.parse({
          model: catalogItem(exact.data, retrievedAt),
          ok: true,
        });
      }
      if (pageModels.length < 50) break;
    }
  } catch {
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
  const { ai, authority, controlPlane } = context;

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
        "Search or inspect the live Cloudflare AI catalog, or list the owner's enabled model catalog. Capability and pricing metadata is returned only when Cloudflare declares it, with source and retrieval time; Crewhelm does not label models tested or untested.",
      inputSchema: modelReadInputSchema,
      title: "Discover Cloudflare AI models",
    },
    async (input) => {
      switch (input.action) {
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
          const discovery = await inspect(ai, input.change.modelId);
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
