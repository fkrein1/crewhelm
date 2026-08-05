import { describe, expect, it, vi } from "vitest";

import {
  classifyComposioToolEffect,
  integrationToolParameterMapSchema,
  isCredentialBearingComposioTool,
} from "../../contracts/src/index.js";
import {
  createComposioCatalog,
  createComposioConnectionLinks,
  createComposioRuntime,
} from "./index.js";

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
              logo: "https://assets.composio.dev/logos/firecrawl.png",
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
          logoUrl: "https://assets.composio.dev/logos/firecrawl.png",
          name: "Firecrawl",
          noAuth: false,
          slug: "firecrawl",
          toolsCount: 18,
          version: "20260701_00",
        },
        {
          authSchemes: null,
          description: "A project-owned integration.",
          logoUrl: null,
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

  it("drops unsafe catalog logo URLs without dropping the integration", async () => {
    const catalog = createComposioCatalog({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        catalogResponse({
          items: [
            {
              meta: {
                description: "Unsafe upstream logo metadata.",
                logo: "http://user:password@example.com/logo.svg",
                tools_count: 1,
                version: "20260701_00",
              },
              name: "Example",
              slug: "example",
            },
          ],
          next_cursor: null,
        }),
      ),
    });

    await expect(catalog.search({ limit: 1 })).resolves.toMatchObject({
      integrations: [{ logoUrl: null, slug: "example" }],
      ok: true,
    });
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

describe("Composio runtime adapter", () => {
  it("converts a provider root object schema into strict runtime validation", () => {
    const runtime = createComposioRuntime({ apiKey: "composio-project-secret" });
    const schema = runtime.createInputSchema(
      JSON.stringify({
        properties: {
          count: { minimum: 1, type: "integer" },
          itemId: { type: "string" },
        },
        required: ["itemId"],
        type: "object",
      }),
    );

    expect(schema.safeParse({ count: 2, itemId: "item-1" }).success).toBe(true);
    expect(schema.safeParse({ count: 0, itemId: "item-1" }).success).toBe(false);
    expect(schema.safeParse({ count: 2 }).success).toBe(false);
    expect(schema.safeParse({ itemId: "item-1", unexpected: true }).success).toBe(false);
    expect(() => runtime.createInputSchema('{"itemId":{"required":true,"type":"string"}}')).toThrow(
      "Composio tool schema is unavailable.",
    );
    expect(() => runtime.createInputSchema('{"properties":{},"type":"array"}')).toThrow(
      "Composio tool schema is unavailable.",
    );
  });

  it("passes through bounded provider root object schemas with strict top-level inputs", () => {
    const runtime = createComposioRuntime({ apiKey: "composio-project-secret" });
    const schema = runtime.createInputSchema(
      JSON.stringify({
        $defs: {
          filter: {
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
            type: "object",
          },
        },
        properties: {
          filter: { $ref: "#/$defs/filter" },
        },
        required: ["filter"],
        title: "ProviderRequest",
        type: "object",
      }),
    );

    expect(schema.safeParse({ filter: { name: "crewhelm" } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ filter: { name: "crewhelm" }, unexpected: true }).success).toBe(
      false,
    );
  });

  it("accepts an empty provider root object schema", () => {
    const runtime = createComposioRuntime({ apiKey: "composio-project-secret" });
    const schema = runtime.createInputSchema(
      JSON.stringify({
        description: "Request with no arguments.",
        properties: {},
        title: "EmptyRequest",
        type: "object",
      }),
    );

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it("classifies only explicit read and destructive hints, defaulting unknown tools to write", () => {
    expect(classifyComposioToolEffect(["readOnlyHint"], "GITHUB_LIST_ISSUES")).toBe("read");
    expect(classifyComposioToolEffect(["readOnlyHint"], "GITHUB_CREATE_ISSUE")).toBe("write");
    expect(classifyComposioToolEffect(["readOnlyHint"], "GITHUB_FETCH_AND_COMMENT")).toBe("write");
    expect(classifyComposioToolEffect([], "GITHUB_LIST_ISSUES")).toBe("write");
    expect(classifyComposioToolEffect(["destructiveHint"])).toBe("destructive");
    expect(classifyComposioToolEffect([], "GITHUB_DELETE_REPOSITORY")).toBe("destructive");
    expect(classifyComposioToolEffect(["issues", "project-management"])).toBe("write");
  });

  it("prevents credential-retrieval tools from being attached to an Agent", () => {
    expect(
      isCredentialBearingComposioTool({
        name: "Read secret",
        outputParameters: { value: { type: "string" } },
        slug: "VAULT_GET_SECRET",
      }),
    ).toBe(true);
    expect(
      isCredentialBearingComposioTool({
        name: "Read item",
        outputParameters: { client_secret: { type: "string" } },
        slug: "PROJECT_READ_ITEM",
      }),
    ).toBe(true);
    expect(
      isCredentialBearingComposioTool({
        name: "Read item",
        outputParameters: { itemId: { type: "string" } },
        slug: "PROJECT_READ_ITEM",
      }),
    ).toBe(false);
  });

  it("verifies an active connected account without retaining its credential state", async () => {
    const apiKey = "composio-project-secret";
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        alias: "Work project",
        id: "ca_project_123",
        state: { val: { access_token: "provider-secret" } },
        status: "ACTIVE",
        toolkit: { slug: "project_toolkit" },
      }),
    );
    const result = await createComposioRuntime({
      apiKey,
      fetch: fetchMock,
      onResponse,
    }).verifyConnection("ca_project_123");
    const request = fetchMock.mock.calls[0];

    expect(request?.[0]).toEqual(
      new URL("https://backend.composio.dev/api/v3.1/connected_accounts/ca_project_123"),
    );
    expect(new Headers(request?.[1]?.headers).get("x-api-key")).toBe(apiKey);
    expect(result).toEqual({
      accountLabel: "Work project",
      ok: true,
      toolkitSlug: "project_toolkit",
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "verify",
      outcome: "accepted",
      status: 200,
    });
  });

  it.each([
    {
      name: "a rejected account",
      outcome: "configuration_unavailable",
      reason: "configuration_unavailable",
      response: () => catalogResponse({ error: "not active" }, { status: 403 }),
      status: 403,
    },
    {
      name: "a missing account",
      outcome: "provider_rejected",
      reason: "provider_rejected",
      response: () => catalogResponse({ error: "not found" }, { status: 404 }),
      status: 404,
    },
    {
      name: "provider unavailability",
      outcome: "provider_unavailable",
      reason: "provider_unavailable",
      response: () => catalogResponse({ error: "temporarily unavailable" }, { status: 503 }),
      status: 503,
    },
    {
      name: "an invalid success response",
      outcome: "invalid_response",
      reason: "invalid_response",
      response: () => new Response("not json", { status: 200 }),
      status: 200,
    },
  ])("classifies $name while verifying a connection", async (testCase) => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const result = await createComposioRuntime({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(testCase.response()),
      onResponse,
    }).verifyConnection("ca_project_123");

    expect(result).toEqual({ ok: false, reason: testCase.reason });
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "verify",
      outcome: testCase.outcome,
      status: testCase.status,
    });
  });

  it("keeps a valid initializing account in the expected not-ready state", async () => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const result = await createComposioRuntime({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          alias: "Personal Todoist",
          id: "ca_project_123",
          status: "INITIALIZING",
          toolkit: { slug: "todoist" },
        }),
      ),
      onResponse,
    }).verifyConnection("ca_project_123");

    expect(result).toEqual({ ok: false, reason: "provider_rejected" });
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "verify",
      outcome: "provider_rejected",
      status: 200,
    });
  });

  it("distinguishes invalid connection verification input from transport failure", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("provider unavailable"));
    const runtime = createComposioRuntime({
      apiKey: "composio-project-secret",
      fetch: fetchMock,
    });

    await expect(runtime.verifyConnection("not-a-provider-id")).resolves.toEqual({
      ok: false,
      reason: "invalid_request",
    });
    await expect(runtime.verifyConnection("ca_project_123")).resolves.toEqual({
      ok: false,
      reason: "transport_error",
    });
    await expect(
      createComposioRuntime({ apiKey: undefined, fetch: fetchMock }).verifyConnection(
        "ca_project_123",
      ),
    ).resolves.toEqual({ ok: false, reason: "configuration_unavailable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("executes one pinned tool exactly once and returns only bounded provider data", async () => {
    const apiKey = "composio-project-secret";
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      catalogResponse({
        data: { itemId: "item-1", status: "found" },
        error: null,
        log_id: "log_123",
        successful: true,
      }),
    );
    const runtime = createComposioRuntime({ apiKey, fetch: fetchMock, onResponse });
    const result = await runtime.execute({
      arguments: { itemId: "item-1" },
      maximumOutputBytes: 64_000,
      providerConnectionId: "ca_project_123",
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      toolkitVersion: "20260727_00",
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
      userId: "owner_1111111111111111111111111111111111111111111",
    });
    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(endpoint).toEqual(
      new URL("https://backend.composio.dev/api/v3/tools/execute/PROJECT_TOOLKIT_READ_ITEM"),
    );
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a serialized Composio execution request.");
    }

    expect(JSON.parse(init.body)).toEqual({
      arguments: { itemId: "item-1" },
      connected_account_id: "ca_project_123",
      user_id: "owner_1111111111111111111111111111111111111111111",
      version: "20260727_00",
    });
    expect(result).toEqual({ itemId: "item-1", status: "found" });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "execute",
      outcome: "accepted",
      status: 200,
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    });
  });

  it("reports a bounded provider rejection without response content", async () => {
    const secret = "provider-secret-that-must-not-be-logged";
    const onResponse = vi.fn<(event: unknown) => void>();
    const runtime = createComposioRuntime({
      apiKey: "composio-project-secret",
      fetch: vi
        .fn<typeof fetch>()
        .mockResolvedValue(catalogResponse({ error: secret }, { status: 403 })),
      onResponse,
    });

    await expect(
      runtime.execute({
        arguments: {},
        maximumOutputBytes: 64_000,
        providerConnectionId: "ca_project_123",
        signal: new AbortController().signal,
        timeoutMs: 20_000,
        toolkitVersion: "20260727_00",
        toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
        userId: "owner_1111111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow("Composio tool execution failed.");
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "execute",
      outcome: "provider_rejected",
      status: 403,
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    });
    expect(JSON.stringify(onResponse.mock.calls)).not.toContain(secret);
  });

  it("reports only structured provider error identifiers", async () => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const runtime = createComposioRuntime({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        catalogResponse(
          {
            error: {
              code: 4001,
              message: "Untrusted provider detail",
              slug: "invalid_tool_input",
              status: 400,
            },
          },
          { status: 400 },
        ),
      ),
      onResponse,
    });

    await expect(
      runtime.execute({
        arguments: {},
        maximumOutputBytes: 64_000,
        providerConnectionId: "ca_project_123",
        signal: new AbortController().signal,
        timeoutMs: 20_000,
        toolkitVersion: "20260727_00",
        toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
        userId: "owner_1111111111111111111111111111111111111111111",
      }),
    ).rejects.toThrow("Composio tool execution failed.");
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "execute",
      outcome: "provider_rejected",
      providerErrorCode: 4001,
      status: 400,
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    });
    expect(JSON.stringify(onResponse.mock.calls)).not.toContain("Untrusted provider detail");
  });

  it("rejects credential-shaped or provider-reference output", async () => {
    for (const data of [
      { access_token: "provider-secret" },
      { account: "ca_project_123" },
      { client_secret: "provider-secret" },
      { private_key: "provider-secret" },
      { "set-cookie": "session=provider-secret" },
      { session_token: "provider-secret" },
      { name: "client_secret", value: "provider-secret" },
      { value: "Bearer provider-secret" },
      { value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature" },
      { value: "-----BEGIN PRIVATE KEY-----\nprovider-secret" },
    ]) {
      const runtime = createComposioRuntime({
        apiKey: "composio-project-secret",
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          catalogResponse({
            data,
            error: null,
            successful: true,
          }),
        ),
      });

      await expect(
        runtime.execute({
          arguments: {},
          maximumOutputBytes: 64_000,
          providerConnectionId: "ca_project_123",
          signal: new AbortController().signal,
          timeoutMs: 20_000,
          toolkitVersion: "20260727_00",
          toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
          userId: "owner_1111111111111111111111111111111111111111111",
        }),
      ).rejects.toThrow("Composio tool execution failed.");
    }
  });
});

describe("Composio connection-link adapter", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const input = {
    authConfigId: "ac_github_managed",
    callbackSecrets: ["b".repeat(43), "c".repeat(43)] as [string, string],
    callbackUrl:
      `https://crewhelm.example/connections/composio/callback/owner_${"a".repeat(43)}/` +
      "connection_link_00000000-0000-4000-8000-000000000000/1785155400000/" +
      `${"b".repeat(43)}/${"c".repeat(43)}`,
    userId: `owner_${"a".repeat(43)}`,
  };
  const providerResponse = {
    connected_account_id: "ca_connection_123",
    expires_at: "2026-07-27T12:10:00.000Z",
    link_token: "link_secure_link_123",
    redirect_url: "https://connect.composio.dev/link/link_secure_link_123",
  };

  it("creates a private hosted link through one fixed, bounded request", async () => {
    const apiKey = "composio-project-secret";
    const connectionSecret = "provider-connection-secret";
    const cancellation = new AbortController();
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(catalogResponse(providerResponse, { status: 201 }));
    const connectionLinks = createComposioConnectionLinks({
      apiKey,
      fetch: fetchMock,
      now: () => now,
      onResponse,
      signal: cancellation.signal,
    });

    await expect(
      connectionLinks.create({
        ...input,
        connectionData: {
          full: "https://api.firecrawl.dev/v1",
          generic_api_key: connectionSecret,
        },
      }),
    ).resolves.toEqual({
      connectionLink: {
        expiresAt: providerResponse.expires_at,
        providerConnectionId: providerResponse.connected_account_id,
        url: providerResponse.redirect_url,
      },
      ok: true,
    });
    expect(connectionLinks.isAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledExactlyOnceWith({
      durationMs: expect.any(Number),
      operation: "link",
      outcome: "accepted",
      status: 201,
    });

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];

    expect(endpoint).toBe("https://backend.composio.dev/api/v3.1/connected_accounts/link");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a serialized Composio request body.");
    }

    expect(JSON.parse(init.body)).toEqual({
      auth_config_id: input.authConfigId,
      callback_url: input.callbackUrl,
      connection_data: {
        full: "https://api.firecrawl.dev/v1",
        generic_api_key: connectionSecret,
      },
      experimental: {
        account_type: "PRIVATE",
      },
      user_id: input.userId,
    });
    cancellation.abort();
    expect(init?.signal?.aborted).toBe(true);
    expect(JSON.stringify(await connectionLinks.create(input))).not.toContain(apiKey);
    expect(JSON.stringify(await connectionLinks.create(input))).not.toContain(connectionSecret);
  });

  it("does not dispatch without valid local configuration or input", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const connectionLinks = createComposioConnectionLinks({
      apiKey: undefined,
      fetch: fetchMock,
      now: () => now,
    });

    expect(connectionLinks.isAvailable()).toBe(false);
    await expect(connectionLinks.create(input)).resolves.toEqual({
      error: {
        code: "connection_link_outcome_unknown",
        message: "Connection link request denied.",
      },
      ok: false,
    });
    await expect(
      createComposioConnectionLinks({
        apiKey: "composio-project-secret",
        fetch: fetchMock,
        now: () => now,
      }).create({ ...input, authConfigId: "github" }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      createComposioConnectionLinks({
        apiKey: "composio-project-secret",
        fetch: fetchMock,
        now: () => now,
      }).create({ ...input, callbackUrl: "https://crewhelm.example/callback?token=secret" }),
    ).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a redirect", () => new Response(null, { status: 302 })],
    ["a provider rejection", () => catalogResponse({ error: "provider-secret" }, { status: 422 })],
    ["a non-JSON success", () => new Response("created", { status: 201 })],
    [
      "an untrusted hosted-link origin",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            redirect_url: "https://attacker.example/link/ln_secure_link_123",
          },
          { status: 201 },
        ),
    ],
    [
      "a substituted link token",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            redirect_url: "https://connect.composio.dev/link/ln_different",
          },
          { status: 201 },
        ),
    ],
    [
      "a callback token reflected as the connected account",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            connected_account_id: `ca_${input.callbackSecrets[0]}`,
          },
          { status: 201 },
        ),
    ],
    [
      "a callback token reflected as the hosted link",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            link_token: `ln_${input.callbackSecrets[0]}`,
            redirect_url: `https://connect.composio.dev/link/ln_${input.callbackSecrets[0]}`,
          },
          { status: 201 },
        ),
    ],
    [
      "a callback authenticator reflected as the hosted link",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            link_token: `ln_${input.callbackSecrets[1]}`,
            redirect_url: `https://connect.composio.dev/link/ln_${input.callbackSecrets[1]}`,
          },
          { status: 201 },
        ),
    ],
    [
      "a shared account",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            experimental: { account_type: "SHARED" },
          },
          { status: 201 },
        ),
    ],
    [
      "an already expired link",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            expires_at: "2026-07-27T11:59:59.000Z",
          },
          { status: 201 },
        ),
    ],
    [
      "an excessively long-lived link",
      () =>
        catalogResponse(
          {
            ...providerResponse,
            expires_at: "2026-07-27T12:30:00.001Z",
          },
          { status: 201 },
        ),
    ],
    [
      "an oversized response",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(32 * 1_024 + 1));
              controller.close();
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 201,
          },
        ),
    ],
  ])("fails closed on %s after dispatch", async (_label, response) => {
    const result = await createComposioConnectionLinks({
      apiKey: "composio-project-secret",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(response()),
      now: () => now,
    }).create(input);

    expect(result).toEqual({
      error: {
        code: "connection_link_outcome_unknown",
        message: "Connection link request denied.",
      },
      ok: false,
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("treats a thrown or cancelled fetch as an unknown external outcome", async () => {
    for (const failure of [
      new DOMException("timed out with secret", "TimeoutError"),
      new Error("network failed with secret"),
    ]) {
      const result = await createComposioConnectionLinks({
        apiKey: "composio-project-secret",
        fetch: vi.fn<typeof fetch>().mockRejectedValue(failure),
        now: () => now,
      }).create(input);

      expect(result).toMatchObject({
        error: { code: "connection_link_outcome_unknown" },
        ok: false,
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
});
