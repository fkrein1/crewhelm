import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerAuthTestDatabase } from "../oauth/testkit.js";
import {
  createCloudflareUnifiedModelCatalogItem,
  readCloudflareUnifiedModelCatalog,
  refreshCloudflareUnifiedModelCatalog,
} from "./cloudflare-unified-model-catalog.js";

const commitA = "a".repeat(40);
const commitB = "b".repeat(40);
const luna = {
  created_at: "2026-07-10 02:51:21",
  description: "A cost-sensitive reasoning model with tool use.",
  metadata: { "Input Modalities": "Text, Image" },
  model_id: "openai/gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  request_formats: ["responses"],
  schema: { input: { properties: { tools: { type: "array" } } } },
  tags: ["Reasoning", "Multimodal"],
  task: "Text Generation",
  zdr: false,
};
const claude = {
  created_at: "2026-07-07 16:15:48",
  description: "A balanced model for long-horizon professional work.",
  model_id: "anthropic/claude-sonnet-5",
  name: "Claude Sonnet 5",
  request_formats: ["anthropic-messages"],
  tags: ["Reasoning"],
  task: "Text Generation",
  zdr: true,
};

registerAuthTestDatabase();

function response(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: { "content-length": String(new TextEncoder().encode(body).byteLength) },
  });
}

function catalogFetch(commit = commitA, invalidModel = false) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/commits")) {
      return response([{ sha: commit }]);
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/contents/")) {
      return response([
        { name: "anthropic-claude-sonnet-5.json", size: 10_000, type: "file" },
        { name: "openai-gpt-5.6-luna.json", size: 10_000, type: "file" },
      ]);
    }
    if (url.pathname.endsWith("anthropic-claude-sonnet-5.json")) return response(claude);
    if (url.pathname.endsWith("openai-gpt-5.6-luna.json")) {
      return response(invalidModel ? { ...luna, model_id: 42 } : luna);
    }
    return new Response(null, { status: 404 });
  });
}

describe("Cloudflare unified model catalog cache", () => {
  beforeEach(async () => {
    await env.AUTH_DB.prepare('DELETE FROM "cloudflare_model_catalog_cache"').run();
  });

  it("refreshes structured upstream records and reuses an unchanged commit", async () => {
    const fetchImplementation = catalogFetch();
    await expect(
      refreshCloudflareUnifiedModelCatalog(env.AUTH_DB, fetchImplementation),
    ).resolves.toEqual({ modelCount: 2, sourceCommit: commitA, status: "refreshed" });

    const snapshot = await readCloudflareUnifiedModelCatalog(env.AUTH_DB);
    expect(snapshot).toMatchObject({ sourceCommit: commitA, status: "last-known-good" });
    expect(snapshot.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilities: expect.arrayContaining(["function-calling", "reasoning", "vision"]),
          freshness: "last-known-good",
          id: luna.model_id,
          runtimeCompatibility: "compatible",
          runtimeCompatibilityEvidence: "declared-tool-support",
        }),
        expect.objectContaining({
          capabilities: expect.arrayContaining(["zero-data-retention"]),
          id: claude.model_id,
          runtimeCompatibility: "compatible",
          runtimeCompatibilityEvidence: "adapter-inferred-tool-support",
        }),
      ]),
    );

    const unchangedFetch = catalogFetch();
    await expect(
      refreshCloudflareUnifiedModelCatalog(env.AUTH_DB, unchangedFetch),
    ).resolves.toEqual({ modelCount: 2, sourceCommit: commitA, status: "unchanged" });
    expect(unchangedFetch).toHaveBeenCalledTimes(1);
  });

  it("preserves the last-known-good catalog when a changed source is invalid", async () => {
    await refreshCloudflareUnifiedModelCatalog(env.AUTH_DB, catalogFetch());

    await expect(
      refreshCloudflareUnifiedModelCatalog(env.AUTH_DB, catalogFetch(commitB, true)),
    ).rejects.toThrow("invalid model");
    await expect(readCloudflareUnifiedModelCatalog(env.AUTH_DB)).resolves.toMatchObject({
      sourceCommit: commitA,
      status: "last-known-good",
    });
  });

  it("uses the bundled catalog before the first successful refresh", async () => {
    const snapshot = await readCloudflareUnifiedModelCatalog(env.AUTH_DB);

    expect(snapshot.status).toBe("bundled-fallback");
    expect(snapshot.models.length).toBeGreaterThan(40);
    expect(snapshot.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilities: expect.arrayContaining(["function-calling"]),
          id: "openai/gpt-5.6-luna",
        }),
      ]),
    );
    expect(
      snapshot.models.filter((model) => model.runtimeCompatibility === "compatible").length,
    ).toBeGreaterThan(40);
    expect(snapshot.models.every((model) => model.runtimeCompatibility === "compatible")).toBe(
      true,
    );
  });

  it("requires the request format selected by each runtime adapter", () => {
    const openAIChatOnly = createCloudflareUnifiedModelCatalogItem(
      { ...luna, request_formats: ["chat-completions"] },
      "last-known-good",
    );
    const nonAnthropicMessages = createCloudflareUnifiedModelCatalogItem(
      {
        ...claude,
        model_id: "minimax/example",
        request_formats: ["anthropic-messages"],
      },
      "last-known-good",
    );

    expect(openAIChatOnly).toMatchObject({
      runtimeCompatibility: "incompatible",
      runtimeCompatibilityEvidence: "unsupported-request-format",
    });
    expect(nonAnthropicMessages).toMatchObject({
      runtimeCompatibility: "incompatible",
      runtimeCompatibilityEvidence: "unsupported-request-format",
    });
  });
});
