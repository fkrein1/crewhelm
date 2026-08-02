import { describe, expect, it, vi } from "vitest";

import {
  RemoteMcpClientError,
  callRemoteMcpTool,
  discoverRemoteMcpTools,
  normalizeRemoteMcpEndpoint,
} from "./client.js";

function requestBody(init: RequestInit | undefined): { id?: number; method?: string } {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
  const parsed: unknown = JSON.parse(init.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON-RPC request object.");
  }
  const id = Reflect.get(parsed, "id");
  const method = Reflect.get(parsed, "method");
  return {
    ...(typeof id === "number" ? { id } : {}),
    ...(typeof method === "string" ? { method } : {}),
  };
}

function mcpFetch(options?: {
  reflectedParts?: string[];
  reflectedToken?: string;
  serverInfo?: Record<string, unknown>;
  tools?: unknown[];
}) {
  return vi.fn<typeof fetch>(async (_input, init) => {
    const authorization = new Headers(init?.headers).get("authorization");
    const body = requestBody(init);

    if (body.method === "initialize") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: options?.serverInfo ?? { name: "fixture", version: "1.0.0" },
        },
      });
    }

    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (body.method === "tools/list") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          tools: options?.tools ?? [
            {
              description: " Read one record. ",
              inputSchema: {
                properties: { id: { type: "string" } },
                required: ["id"],
                type: "object",
              },
              name: "record.read",
            },
          ],
        },
      });
    }

    if (body.method === "tools/call") {
      return Response.json({
        id: body.id,
        jsonrpc: "2.0",
        result: {
          content: (
            options?.reflectedParts ?? [
              options?.reflectedToken ?? `authorized:${authorization === "Bearer secret"}`,
            ]
          ).map((text) => ({ text, type: "text" })),
        },
      });
    }

    throw new Error(`Unexpected MCP request: ${String(body.method)}`);
  });
}

describe("remote MCP endpoints", () => {
  it.each([
    "http://example.com/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com:8443/mcp",
    "https://example.com/mcp?token=secret",
    "https://example.com/mcp#fragment",
  ])("denies non-public or credential-bearing endpoint %s", (endpoint) => {
    expect(() => normalizeRemoteMcpEndpoint(endpoint)).toThrow(RemoteMcpClientError);
  });

  it("canonicalizes a public HTTPS endpoint", () => {
    expect(normalizeRemoteMcpEndpoint("https://MCP.EXAMPLE.COM.:443/mcp")).toBe(
      "https://mcp.example.com/mcp",
    );
  });
});

describe("remote MCP client", () => {
  it("discovers and freezes a canonical tool catalog", async () => {
    const result = await discoverRemoteMcpTools({
      bearerToken: "secret",
      endpoint: "https://mcp.example.com/mcp",
      fetchImplementation: mcpFetch(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      catalogBytes: expect.any(Number),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      server: { name: "fixture", version: "1.0.0" },
      tools: [
        {
          description: "Read one record.",
          inputSchema: expect.any(Object),
          name: "record.read",
        },
      ],
    });
  });

  it("projects standard optional server metadata to the frozen connection shape", async () => {
    const result = await discoverRemoteMcpTools({
      endpoint: "https://mcp.example.com/mcp",
      fetchImplementation: mcpFetch({
        serverInfo: {
          description: "Untrusted optional metadata.",
          icons: [{ src: "https://example.com/icon.png" }],
          name: "fixture",
          title: "Fixture server",
          version: "1.0.0",
          websiteUrl: "https://example.com",
        },
      }),
      signal: new AbortController().signal,
    });

    expect(result.server).toEqual({ name: "fixture", version: "1.0.0" });
  });

  it("calls one exact tool with bearer authentication", async () => {
    await expect(
      callRemoteMcpTool({
        arguments: { id: "record-1" },
        bearerToken: "secret",
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch(),
        maximumOutputBytes: 4_096,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).resolves.toMatchObject({ content: [{ text: "authorized:true", type: "text" }] });
  });

  it("rejects reflected credentials and oversized output", async () => {
    await expect(
      callRemoteMcpTool({
        arguments: {},
        bearerToken: "secret",
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({ reflectedToken: "secret" }),
        maximumOutputBytes: 4_096,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).rejects.toMatchObject({ code: "credential_reflected" });

    const escapedToken = 'secret"with\\escapes';
    await expect(
      callRemoteMcpTool({
        arguments: {},
        bearerToken: escapedToken,
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({ reflectedToken: escapedToken }),
        maximumOutputBytes: 4_096,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).rejects.toMatchObject({ code: "credential_reflected" });

    const splitToken = "credential-split-across-fields";
    await expect(
      callRemoteMcpTool({
        arguments: {},
        bearerToken: splitToken,
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({
          reflectedParts: [
            splitToken.slice(0, Math.ceil(splitToken.length / 2)),
            splitToken.slice(Math.floor(splitToken.length / 2)),
          ],
        }),
        maximumOutputBytes: 4_096,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).rejects.toMatchObject({ code: "credential_reflected" });

    await expect(
      callRemoteMcpTool({
        arguments: {},
        bearerToken: splitToken,
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({
          reflectedParts: [splitToken.slice(0, 8), splitToken.slice(8, 17), splitToken.slice(17)],
        }),
        maximumOutputBytes: 4_096,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).rejects.toMatchObject({ code: "credential_reflected" });

    await expect(
      callRemoteMcpTool({
        arguments: {},
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch(),
        maximumOutputBytes: 16,
        signal: new AbortController().signal,
        toolName: "record.read",
      }),
    ).rejects.toMatchObject({ code: "output_too_large" });
  });

  it("rejects duplicate and oversized catalogs", async () => {
    const duplicate = {
      inputSchema: { type: "object" },
      name: "duplicate",
    };

    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({ tools: [duplicate, duplicate] }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_catalog" });

    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({
          tools: Array.from({ length: 101 }, (_, index) => ({
            inputSchema: { type: "object" },
            name: `tool_${index}`,
          })),
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "catalog_too_large" });
  });

  it("rejects credential-bearing and unsafe discovery metadata", async () => {
    const bearerToken = "discovery-credential-value";
    await expect(
      discoverRemoteMcpTools({
        bearerToken,
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: mcpFetch({
          tools: [
            {
              description: bearerToken,
              inputSchema: { type: "object" },
              name: "reflected",
            },
          ],
        }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "credential_reflected" });

    for (const inputSchema of [
      {
        properties: { value: { default: "transformed", type: "string" } },
        type: "object",
      },
      {
        properties: { value: { pattern: "^(a+)+$", type: "string" } },
        type: "object",
      },
      JSON.parse(
        '{"if":{"properties":{"enabled":{"const":true}}},"then":{"required":["value"]},"type":"object"}',
      ) as unknown,
    ]) {
      await expect(
        discoverRemoteMcpTools({
          endpoint: "https://mcp.example.com/mcp",
          fetchImplementation: mcpFetch({
            tools: [{ inputSchema, name: "unsafe" }],
          }),
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: "invalid_catalog" });
    }
  });

  it.each([307, 308] as const)("follows a bounded same-origin %s redirect", async (status) => {
    const downstream = mcpFetch();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/mcp") {
        return new Response(null, { headers: { location: "/canonical" }, status });
      }
      return downstream(input, init);
    });

    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ server: { name: "fixture" } });
    expect(
      fetchImplementation.mock.calls.every(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return url.origin === "https://mcp.example.com";
      }),
    ).toBe(true);
  });

  it("rejects cross-origin redirects", async () => {
    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation: vi.fn<typeof fetch>(
          async () =>
            new Response(null, {
              headers: { location: "https://different.example.com/mcp" },
              status: 307,
            }),
        ),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_endpoint" });
  });

  it("rejects a same-origin redirect loop after its fixed budget", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(
      async () => new Response(null, { headers: { location: "/mcp" }, status: 308 }),
    );

    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "request_failed" });
    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it("uses deterministic code-unit ordering for catalogs", async () => {
    const result = await discoverRemoteMcpTools({
      endpoint: "https://mcp.example.com/mcp",
      fetchImplementation: mcpFetch({
        tools: ["a_", "a-", "a", "A"].map((name) => ({
          inputSchema: { type: "object" },
          name,
        })),
      }),
      signal: new AbortController().signal,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(["A", "a", "a-", "a_"]);
  });

  it("bounds wire responses before the SDK parses them", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      Response.json({ padding: "x".repeat(600 * 1_024) }),
    );

    await expect(
      discoverRemoteMcpTools({
        endpoint: "https://mcp.example.com/mcp",
        fetchImplementation,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});
