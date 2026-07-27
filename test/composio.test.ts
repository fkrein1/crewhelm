import { describe, expect, it, vi } from "vitest";

import { createComposioCatalog } from "../packages/composio/src/index.js";
import { integrationToolParameterMapSchema } from "../packages/contracts/src/index.js";

function catalogResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return Response.json(body, { ...init, headers });
}

describe("Composio catalog adapter", () => {
  it("accepts only bounded inert JSON parameter maps", () => {
    expect(
      integrationToolParameterMapSchema.parse({
        array: [null, true, 42, "value", { nested: false }],
        object: {
          additionalProperties: false,
          type: "string",
        },
      }),
    ).toEqual({
      array: [null, true, 42, "value", { nested: false }],
      object: {
        additionalProperties: false,
        type: "string",
      },
    });

    let tooDeep: Record<string, unknown> = { type: "string" };

    for (let depth = 0; depth < 25; depth += 1) {
      tooDeep = { nested: tooDeep };
    }

    const tooManyNodes = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`group${index}`, Array(512).fill(null)]),
    );
    const arrayWithExtraProperty = Object.assign([], { extra: null });
    const arrayWithToJson = Object.defineProperty([], "toJSON", {
      value: () => ({ changed: "after-validation" }),
    });
    const arrayWithSymbol = Object.assign([], { [Symbol("hidden")]: null });
    const objectWithAccessor = Object.defineProperty({}, "type", {
      enumerable: true,
      get: () => "string",
    });

    for (const invalid of [
      [],
      { arrayWithExtraProperty },
      { arrayWithSymbol },
      { arrayWithToJson },
      { objectWithAccessor },
      { [Symbol("hidden")]: null },
      { ["k".repeat(257)]: null },
      { value: "x".repeat(32 * 1_024 + 1) },
      { value: undefined },
      Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`key${index}`, null])),
      tooDeep,
      tooManyNodes,
    ]) {
      expect(integrationToolParameterMapSchema.safeParse(invalid).success).toBe(false);
    }
  });

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

  it("discovers exact tools from every integration at the latest resolved version", async () => {
    const apiKey = "composio-project-secret";
    const cancellation = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [
          {
            description: "Create an issue in a repository.",
            input_parameters: {
              body: { type: "string" },
              repo: { type: "string" },
            },
            is_deprecated: false,
            name: "Create issue",
            no_auth: false,
            output_parameters: {
              issue_number: { type: "number" },
            },
            scopes: ["repo"],
            slug: "GITHUB_CREATE_ISSUE",
            tags: ["issues", "write"],
            toolkit: {
              logo: "https://cdn.example/github.svg",
              name: "GitHub",
              slug: "github",
            },
            version: "20260720_00",
          },
          {
            name: "Project action",
            slug: "PROJECT_TOOLKIT_ACTION",
            toolkit: {
              name: "Project toolkit",
              slug: "project_toolkit",
            },
            version: "20260721_00",
          },
        ],
        next_cursor: "next-tools-page",
      }),
    );
    const catalog = createComposioCatalog({
      apiKey,
      fetch: fetchMock,
      signal: cancellation.signal,
    });
    const result = await catalog.searchTools({
      cursor: "previous-tools-page",
      limit: 2,
      query: "create issue",
    });
    const request = fetchMock.mock.calls[0];
    const endpoint = request?.[0];
    const init = request?.[1];

    expect(endpoint).toBeInstanceOf(URL);

    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected the adapter to use a fixed URL.");
    }

    expect(endpoint.origin).toBe("https://backend.composio.dev");
    expect(endpoint.pathname).toBe("/api/v3.1/tools");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      cursor: "previous-tools-page",
      include_deprecated: "false",
      limit: "2",
      query: "create issue",
      toolkit_versions: "latest",
    });
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    cancellation.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(result).toEqual({
      nextCursor: "next-tools-page",
      ok: true,
      tools: [
        {
          description: "Create an issue in a repository.",
          integration: {
            name: "GitHub",
            slug: "github",
          },
          name: "Create issue",
          noAuth: false,
          requiredScopes: ["repo"],
          slug: "GITHUB_CREATE_ISSUE",
          tags: ["issues", "write"],
          version: "20260720_00",
        },
        {
          description: null,
          integration: {
            name: "Project toolkit",
            slug: "project_toolkit",
          },
          name: "Project action",
          noAuth: null,
          requiredScopes: null,
          slug: "PROJECT_TOOLKIT_ACTION",
          tags: [],
          version: "20260721_00",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("input_parameters");
  });

  it("optionally narrows tool discovery to one exact integration", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        items: [],
        next_cursor: null,
      }),
    );
    const catalog = createComposioCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    });

    await expect(
      catalog.searchTools({
        integrationSlug: "github",
        limit: 10,
      }),
    ).resolves.toEqual({
      nextCursor: null,
      ok: true,
      tools: [],
    });

    const endpoint = fetchMock.mock.calls[0]?.[0];

    expect(endpoint).toBeInstanceOf(URL);

    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected the adapter to use a fixed URL.");
    }

    expect(endpoint.searchParams.get("toolkit_slug")).toBe("github");
  });

  it("inspects bounded parameter schemas for one exact tool version", async () => {
    const apiKey = "composio-project-secret";
    const cancellation = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        description: "Create an issue in a repository.",
        input_parameters: {
          body: {
            description: "Issue body.",
            type: "string",
          },
          repo: {
            description: "Repository in owner/name form.",
            type: "string",
          },
        },
        is_deprecated: false,
        name: "Create issue",
        no_auth: false,
        output_parameters: {
          issue_number: {
            type: "number",
          },
        },
        scopes: ["repo"],
        slug: "GITHUB_CREATE_ISSUE",
        tags: ["issues", "write"],
        toolkit: {
          name: "GitHub",
          slug: "github",
        },
        version: "20260720_00",
      }),
    );
    const catalog = createComposioCatalog({
      apiKey,
      fetch: fetchMock,
      signal: cancellation.signal,
    });
    const result = await catalog.inspectTool({
      slug: "GITHUB_CREATE_ISSUE",
      version: "20260720_00",
    });
    const endpoint = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1];

    expect(endpoint).toBeInstanceOf(URL);

    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected the adapter to use a fixed URL.");
    }

    expect(endpoint.origin).toBe("https://backend.composio.dev");
    expect(endpoint.pathname).toBe("/api/v3.1/tools/GITHUB_CREATE_ISSUE");
    expect(Object.fromEntries(endpoint.searchParams)).toEqual({
      version: "20260720_00",
    });
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    cancellation.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(result).toEqual({
      ok: true,
      tool: {
        description: "Create an issue in a repository.",
        inputParameters: {
          body: {
            description: "Issue body.",
            type: "string",
          },
          repo: {
            description: "Repository in owner/name form.",
            type: "string",
          },
        },
        integration: {
          name: "GitHub",
          slug: "github",
        },
        name: "Create issue",
        noAuth: false,
        outputParameters: {
          issue_number: {
            type: "number",
          },
        },
        requiredScopes: ["repo"],
        slug: "GITHUB_CREATE_ISSUE",
        tags: ["issues", "write"],
        version: "20260720_00",
      },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([
    {
      label: "a substituted slug",
      mutate: (tool: Record<string, unknown>) => ({ ...tool, slug: "GITHUB_DELETE_ISSUE" }),
    },
    {
      label: "a substituted version",
      mutate: (tool: Record<string, unknown>) => ({ ...tool, version: "20260721_00" }),
    },
    {
      label: "a deprecated tool",
      mutate: (tool: Record<string, unknown>) => ({ ...tool, is_deprecated: true }),
    },
    {
      label: "a reflected project key",
      mutate: (tool: Record<string, unknown>, apiKey: string) => ({
        ...tool,
        input_parameters: {
          token: {
            description: apiKey,
            type: "string",
          },
        },
      }),
    },
    {
      label: "a project key reflected as a parameter name",
      mutate: (tool: Record<string, unknown>, apiKey: string) => ({
        ...tool,
        input_parameters: {
          [apiKey]: {
            type: "string",
          },
        },
      }),
    },
    {
      label: "an excessively deep schema",
      mutate: (tool: Record<string, unknown>) => {
        let schema: Record<string, unknown> = { type: "string" };

        for (let depth = 0; depth < 25; depth += 1) {
          schema = { nested: schema };
        }

        return { ...tool, input_parameters: schema };
      },
    },
    {
      label: "a missing deprecation marker",
      mutate: (tool: Record<string, unknown>) =>
        Object.fromEntries(Object.entries(tool).filter(([key]) => key !== "is_deprecated")),
    },
  ])("rejects $label during exact tool inspection", async ({ mutate }) => {
    const apiKey = "composio-project-secret";
    const tool = {
      input_parameters: {},
      is_deprecated: false,
      name: "Create issue",
      output_parameters: {},
      slug: "GITHUB_CREATE_ISSUE",
      toolkit: {
        name: "GitHub",
        slug: "github",
      },
      version: "20260720_00",
    };
    const result = await createComposioCatalog({
      apiKey,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(catalogResponse(mutate(tool, apiKey))),
    }).inspectTool({
      slug: "GITHUB_CREATE_ISSUE",
      version: "20260720_00",
    });

    expect(result).toEqual({
      error: {
        code: "integration_catalog_unavailable",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("rejects reflected credentials, deprecated tools, and unresolved versions", async () => {
    const apiKey = "composio-project-secret";

    for (const item of [
      {
        description: `Reflected credential: ${apiKey}`,
        is_deprecated: false,
        name: "Hostile action",
        slug: "HOSTILE_ACTION",
        toolkit: { name: "Hostile", slug: "hostile" },
        version: "20260720_00",
      },
      {
        is_deprecated: true,
        name: "Deprecated action",
        slug: "DEPRECATED_ACTION",
        toolkit: { name: "Deprecated", slug: "deprecated" },
        version: "20260720_00",
      },
      {
        is_deprecated: false,
        name: "Unresolved action",
        slug: "UNRESOLVED_ACTION",
        toolkit: { name: "Unresolved", slug: "unresolved" },
        version: "latest",
      },
    ]) {
      const result = await createComposioCatalog({
        apiKey,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          catalogResponse({
            items: [item],
            next_cursor: null,
          }),
        ),
      }).searchTools({ limit: 10 });

      expect(result).toEqual({
        error: {
          code: "integration_catalog_unavailable",
          message: "Integration catalog request denied.",
        },
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain(apiKey);
    }
  });

  it("bounds tool discovery responses and rejects invalid input before egress", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1_024 * 1_024 + 1));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = createComposioCatalog({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    });

    await expect(catalog.searchTools({ limit: 10 })).resolves.toMatchObject({
      error: { code: "integration_catalog_unavailable" },
      ok: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    await expect(catalog.searchTools({ limit: 10, query: "ab" })).resolves.toMatchObject({
      error: { code: "integration_catalog_unavailable" },
      ok: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
