import {
  browseCloudflareModelsResultSchema,
  crewhelmStarterModelCatalog,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createPrivateToolCatalog } from "./private-tool-catalog.js";
import {
  MCP_CONFIGURE_MODELS_TOOL_NAME,
  MCP_MODELS_TOOL_NAME,
  registerModelTools,
} from "./model-tools.js";
import type { CloudflareUnifiedModelCatalogSnapshot } from "./cloudflare-unified-model-catalog.js";

const authority = {
  clientId: "https://client.example/mcp.json",
  ownerKey: `owner_${"a".repeat(43)}`,
  scopes: ["control:read", "autonomy:write"],
} as OwnerAuthority;

const kimiK3 = {
  description: "A newly available long-context reasoning model.",
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  properties: [
    { property_id: "request_format", value: "Chat Completions" },
    { property_id: "function_calling", value: "true" },
  ],
  source: 2,
  tags: ["Reasoning", "Vision"],
  task: { description: "Generate text responses.", id: "text-generation", name: "Text Generation" },
} satisfies AiModelsSearchObject;

const currentGlm = {
  created_at: "2026-01-28 16:04:39.346",
  description: "A fast model for multi-turn tool calling.",
  id: "86b3e51a-4b05-43fa-a403-0f27821919d2",
  name: "@cf/zai-org/glm-4.7-flash",
  properties: [
    { property_id: "context_window", value: "131072" },
    {
      property_id: "price",
      value: [
        { currency: "USD", price: 0.0605, unit: "per M input tokens" },
        { currency: "USD", price: 0.4, unit: "per M output tokens" },
      ],
    },
    { property_id: "function_calling", value: "true" },
    { property_id: "reasoning", value: "true" },
  ],
  tags: [],
  task: {
    description: "Generate text responses.",
    id: "c329a1f9-323d-4e91-b2aa-582dd4188d34",
    name: "Text Generation",
  },
};

const unifiedCatalog: CloudflareUnifiedModelCatalogSnapshot = {
  models: [
    {
      capabilities: ["reasoning", "function-calling"],
      createdAt: "2026-07-10T02:51:21.000Z",
      description: "A cost-sensitive reasoning model.",
      freshness: "last-known-good",
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      platform: "third-party",
      provider: "openai",
      requestFormats: ["responses"],
      runtimeCompatibility: "compatible",
      runtimeCompatibilityEvidence: "declared-tool-support",
      task: "Text Generation",
    },
    {
      capabilities: ["reasoning", "function-calling"],
      createdAt: "2026-07-11T02:51:21.000Z",
      description: "A balanced model for long-horizon work.",
      freshness: "last-known-good",
      id: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      platform: "third-party",
      provider: "anthropic",
      requestFormats: ["anthropic-messages"],
      runtimeCompatibility: "compatible",
      runtimeCompatibilityEvidence: "adapter-inferred-tool-support",
      task: "Text Generation",
    },
  ],
  refreshedAt: "2026-07-11T03:00:00.000Z",
  sourceCommit: "a".repeat(40),
  sourceUrl:
    "https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/catalog-models",
  status: "last-known-good",
};

function unifiedModelCatalog() {
  return {
    read: vi.fn<() => Promise<CloudflareUnifiedModelCatalogSnapshot>>(async () => unifiedCatalog),
  };
}

function resultJson(result: CallToolResult) {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a text MCP result.");
  const parsed: unknown = JSON.parse(content.text);
  return z.record(z.string(), z.unknown()).parse(parsed);
}

describe("Cloudflare model MCP tools", () => {
  it("discovers a newly returned model without a Crewhelm model enum", async () => {
    const models = vi
      .fn<(params?: AiModelsSearchParams) => Promise<AiModelsSearchObject[]>>()
      .mockResolvedValue([kimiK3]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
      });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "search", query: "kimi k3" },
      {},
    );

    expect(result.isError).toBe(false);
    expect(resultJson(result)).toMatchObject({
      models: [
        {
          availability: "available",
          id: "moonshotai/kimi-k3",
          platform: "third-party",
          provider: "moonshotai",
          runtimeCompatibility: "compatible",
          runtimeCompatibilityEvidence: "declared-tool-support",
          source: { catalog: "https://developers.cloudflare.com/ai/models/" },
        },
      ],
      ok: true,
      scanned: 1,
    });
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ search: "kimi k3" }));
  });

  it("normalizes the current Cloudflare catalog response shape", async () => {
    const models = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([currentGlm]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
      });
    });

    const searchResult = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "search", capability: "function-calling", query: "glm-4.7-flash" },
      {},
    );
    const inspectResult = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "inspect", modelId: currentGlm.name },
      {},
    );

    expect(searchResult.isError).toBe(false);
    expect(resultJson(searchResult)).toMatchObject({
      models: [
        {
          capabilities: {
            functionCalling: "declared-supported",
            reasoning: "declared-supported",
          },
          id: currentGlm.name,
          platform: "cloudflare-hosted",
          pricing: {
            facts: [
              {
                name: "price",
                value:
                  '[{"currency":"USD","price":0.0605,"unit":"per M input tokens"},{"currency":"USD","price":0.4,"unit":"per M output tokens"}]',
              },
            ],
            status: "catalog-reported",
          },
          provider: "zai-org",
          runtimeCompatibility: "compatible",
          runtimeCompatibilityEvidence: "declared-tool-support",
        },
      ],
      ok: true,
      scanned: 1,
    });
    expect(inspectResult.isError).toBe(false);
    expect(resultJson(inspectResult)).toMatchObject({
      model: { id: currentGlm.name },
      ok: true,
    });
  });

  it("browses compact pageable results and facets across the unified catalog", async () => {
    const models = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([currentGlm]);
    const modelCatalog = unifiedModelCatalog();
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
        modelCatalog,
      });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "browse", capability: "reasoning", limit: 2, page: 1, sort: "newest" },
      {},
    );
    const pageTwoResult = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "browse", capability: "reasoning", limit: 2, page: 2, sort: "newest" },
      {},
    );

    expect(result.isError).toBe(false);
    expect(resultJson(result)).toMatchObject({
      facets: {
        platforms: [
          { count: 2, value: "third-party" },
          { count: 1, value: "cloudflare-hosted" },
        ],
        providers: [
          { count: 1, value: "anthropic" },
          { count: 1, value: "openai" },
          { count: 1, value: "zai-org" },
        ],
      },
      models: [
        { id: "anthropic/claude-sonnet-5", platform: "third-party" },
        { id: "openai/gpt-5.6-luna", platform: "third-party" },
      ],
      nextPage: 2,
      ok: true,
      page: 1,
      total: 3,
    });
    expect(resultJson(pageTwoResult)).toMatchObject({
      models: [{ freshness: "live", id: currentGlm.name }],
      nextPage: null,
      ok: true,
      page: 2,
      total: 3,
    });
    const browseResult = browseCloudflareModelsResultSchema.parse(resultJson(result));
    if (!browseResult.ok) throw new Error("Expected model browse success.");
    expect(browseResult.models[0]).not.toHaveProperty("description");
    expect(modelCatalog.read).toHaveBeenCalledTimes(2);
    expect(models).toHaveBeenCalledWith({ page: 1, per_page: 50 });
  });

  it("ranks exact queries first and includes descriptions only when requested", async () => {
    const models = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([currentGlm]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
        modelCatalog: unifiedModelCatalog(),
      });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      {
        action: "browse",
        includeDescriptions: true,
        query: "openai/gpt-5.6-luna",
        sort: "relevance",
      },
      {},
    );

    expect(result.isError).toBe(false);
    expect(resultJson(result)).toMatchObject({
      models: [
        {
          description: "A cost-sensitive reasoning model.",
          id: "openai/gpt-5.6-luna",
        },
      ],
      ok: true,
      total: 1,
    });
  });

  it("inspects an exact third-party model from the unified catalog", async () => {
    const models = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
        modelCatalog: unifiedModelCatalog(),
      });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "inspect", modelId: "anthropic/claude-sonnet-5" },
      {},
    );

    expect(result.isError).toBe(false);
    expect(resultJson(result)).toMatchObject({
      model: {
        capabilities: {
          functionCalling: "declared-supported",
          reasoning: "declared-supported",
        },
        id: "anthropic/claude-sonnet-5",
        platform: "third-party",
        pricing: { status: "reference-only" },
        provider: "anthropic",
        runtimeCompatibility: "compatible",
        runtimeCompatibilityEvidence: "adapter-inferred-tool-support",
      },
      ok: true,
    });
    expect(models).not.toHaveBeenCalled();
  });

  it("inspects cached third-party models while the live binding is unavailable", async () => {
    const models = vi.fn<() => Promise<unknown[]>>().mockRejectedValue(new Error("unavailable"));
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: {},
        modelCatalog: unifiedModelCatalog(),
      });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "inspect", modelId: "openai/gpt-5.6-luna" },
      {},
    );

    expect(result.isError).toBe(false);
    expect(resultJson(result)).toMatchObject({
      model: { id: "openai/gpt-5.6-luna", runtimeCompatibility: "compatible" },
      ok: true,
    });
    expect(models).not.toHaveBeenCalled();
  });

  it("fails closed when the cached unified catalog is unavailable", async () => {
    const modelCatalog = {
      read: vi.fn<() => Promise<CloudflareUnifiedModelCatalogSnapshot>>(async () =>
        Promise.reject(new Error("unavailable")),
      ),
    };
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: undefined,
        authority,
        controlPlane: {},
        modelCatalog,
      });
    });

    const result = await catalog.dispatch(MCP_MODELS_TOOL_NAME, { action: "browse" }, {});

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      error: {
        code: "catalog_unavailable",
        message: "Cloudflare model discovery request denied.",
      },
      ok: false,
    });
  });

  it("inspects a live model before previewing owner enablement", async () => {
    const configureModelCatalog = vi.fn<() => Promise<unknown>>().mockResolvedValue({
      applied: false,
      catalog: {
        configuredAt: new Date().toISOString(),
        data: {
          defaultModel: crewhelmStarterModelCatalog.defaultModel,
          enabledModels: [...crewhelmStarterModelCatalog.enabledModels, kimiK3.id].toSorted(),
        },
        revision: 2,
      },
      impact: { affectedAgents: [], affectedAgentsTotal: 0, truncated: false },
      ok: true,
    });
    const models = vi
      .fn<(params?: AiModelsSearchParams) => Promise<AiModelsSearchObject[]>>()
      .mockResolvedValue([kimiK3]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, {
        ai: { models },
        authority,
        controlPlane: { configureModelCatalog },
      });
    });
    const input = {
      change: { kind: "add", modelId: kimiK3.id },
      expectedRevision: 1,
      mode: "preview",
      target: { kind: "model-catalog" },
    };

    const result = await catalog.dispatch(MCP_CONFIGURE_MODELS_TOOL_NAME, input, {});

    expect(result.isError).toBe(false);
    expect(configureModelCatalog).toHaveBeenCalledWith(authority, input);
  });

  it("rejects an exact provider model whose metadata exceeds the catalog bounds", async () => {
    const models = vi
      .fn<(params?: AiModelsSearchParams) => Promise<AiModelsSearchObject[]>>()
      .mockResolvedValue([{ ...kimiK3, description: "x".repeat(2_001) }]);
    const catalog = createPrivateToolCatalog((server) => {
      registerModelTools(server, { ai: { models }, authority, controlPlane: {} });
    });

    const result = await catalog.dispatch(
      MCP_MODELS_TOOL_NAME,
      { action: "inspect", modelId: kimiK3.id },
      {},
    );

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toEqual({
      error: {
        code: "catalog_unavailable",
        message: "Cloudflare model discovery request denied.",
      },
      ok: false,
    });
  });
});
