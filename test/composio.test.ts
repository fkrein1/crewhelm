import { describe, expect, it, vi } from "vitest";

import { createComposioCatalog } from "../packages/composio/src/index.js";

function catalogResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return Response.json(body, { ...init, headers });
}

describe("Composio catalog adapter", () => {
  it("searches the complete current catalog through a fixed, bounded request", async () => {
    const apiKey = "composio-project-secret";
    const cancellation = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          {
            auth_schemes: ["OAUTH2"],
            meta: {
              description: "Search and scrape the web.",
              tools_count: 18,
              version: "20260701_00",
            },
            name: "Firecrawl",
            no_auth: false,
            slug: "firecrawl",
          },
          {
            meta: {
              description: "A project-owned integration.",
              tools_count: 3,
              version: "20260702_00",
            },
            name: "Project toolkit",
            slug: "project_toolkit",
          },
        ],
        next_cursor: "opaque-provider-cursor",
      }),
    );
    const catalog = createComposioCatalog({
      apiKey,
      fetch: fetchMock,
      signal: cancellation.signal,
    });
    const result = await catalog.search({
      cursor: "previous-provider-cursor",
      limit: 2,
      query: "web research",
    });
    const request = fetchMock.mock.calls[0];
    const endpoint = request?.[0];
    const init = request?.[1];

    expect(endpoint).toBeInstanceOf(URL);

    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected the adapter to use a fixed URL.");
    }

    expect(endpoint.origin).toBe("https://backend.composio.dev");
    expect(endpoint.pathname).toBe("/api/v3/toolkits");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      cursor: "previous-provider-cursor",
      include_deprecated: "false",
      limit: "2",
      managed_by: "all",
      search: "web research",
      sort_by: "usage",
    });
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    cancellation.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(result).toEqual({
      integrations: [
        {
          authSchemes: ["oauth2"],
          description: "Search and scrape the web.",
          name: "Firecrawl",
          noAuth: false,
          slug: "firecrawl",
          toolsCount: 18,
          version: "20260701_00",
        },
        {
          authSchemes: null,
          description: "A project-owned integration.",
          name: "Project toolkit",
          noAuth: null,
          slug: "project_toolkit",
          toolsCount: 3,
          version: "20260702_00",
        },
      ],
      nextCursor: "opaque-provider-cursor",
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("fails closed without sending a request when the project key is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await createComposioCatalog({ apiKey: undefined, fetch: fetchMock }).search({
      limit: 20,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: {
        code: "integration_catalog_unavailable",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("rejects a valid provider response that reflects the project key", async () => {
    const apiKey = "composio-project-secret";
    const result = await createComposioCatalog({
      apiKey,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        catalogResponse({
          items: [
            {
              meta: {
                description: `Reflected credential: ${apiKey}`,
                tools_count: 1,
                version: "20260701_00",
              },
              name: "Hostile project toolkit",
              slug: "hostile_project_toolkit",
            },
          ],
          next_cursor: apiKey,
        }),
      ),
    }).search({ limit: 20 });

    expect(result).toEqual({
      error: {
        code: "integration_catalog_unavailable",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([
    ["a redirect", () => new Response(null, { status: 302 })],
    ["a non-JSON response", () => new Response("denied")],
    [
      "malformed provider data",
      () =>
        catalogResponse({
          error: {
            message: "provider-secret-must-not-be-reflected",
          },
        }),
    ],
    [
      "an oversized chunked response",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(256 * 1_024 + 1));
              controller.close();
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ],
  ])("normalizes %s to one safe failure", async (_label, response) => {
    const result = await createComposioCatalog({
      apiKey: "secret-api-key-123456",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
    }).search({ limit: 20 });

    expect(result).toEqual({
      error: {
        code: "integration_catalog_unavailable",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
