import { crewhelmStarterModelCatalog, type OwnerAuthority } from "@crewhelm/contracts";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createPrivateToolCatalog } from "./private-tool-catalog.js";
import {
  MCP_CONFIGURE_MODELS_TOOL_NAME,
  MCP_MODELS_TOOL_NAME,
  registerModelTools,
} from "./model-tools.js";

const authority = {
  clientId: "https://client.example/mcp.json",
  ownerKey: `owner_${"a".repeat(43)}`,
  scopes: ["control:read", "autonomy:write"],
} as OwnerAuthority;

const kimiK3 = {
  description: "A newly available long-context reasoning model.",
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  properties: [{ property_id: "request_format", value: "Chat Completions" }],
  source: 2,
  tags: ["Reasoning", "Vision"],
  task: { description: "Generate text responses.", id: "text-generation", name: "Text Generation" },
} satisfies AiModelsSearchObject;

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
          source: { catalog: "https://developers.cloudflare.com/ai/models/" },
        },
      ],
      ok: true,
      scanned: 1,
    });
    expect(models).toHaveBeenCalledWith(expect.objectContaining({ search: "kimi k3" }));
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
