import { env } from "cloudflare:test";
import {
  AGENTS_READ_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  createAgentResultSchema,
  controlPlaneStatusResultSchema,
  getAgentResultSchema,
  integrationCatalogSearchResultSchema,
  inspectIntegrationToolResultSchema,
  integrationToolSearchResultSchema,
  listAgentsResultSchema,
  ownerAuthoritySchema,
  type OwnerScope,
} from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  MCP_CREATE_AGENT_TOOL_NAME,
  MCP_GET_AGENT_TOOL_NAME,
  MCP_INSPECT_INTEGRATION_TOOL_NAME,
  MCP_LIST_AGENTS_TOOL_NAME,
  MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
  MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
  MCP_STATUS_TOOL_NAME,
  handleAuthenticatedMcpRequest,
} from "../src/mcp-handler.js";
import { deriveOwnerKey } from "../src/owner-identity.js";

const origin = "https://crewhelm.test";
const jsonRpcToolResultSchema = z.looseObject({
  result: z.looseObject({
    content: z.array(
      z.looseObject({
        text: z.string().optional(),
        type: z.string(),
      }),
    ),
    isError: z.boolean(),
  }),
});

async function ownerAuthority(subject = "123456", scopes: OwnerScope[] = [OWNER_READ_SCOPE]) {
  return ownerAuthoritySchema.parse({
    clientId: "test-client",
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject,
    }),
    scopes,
  });
}

function toolRequest(body: string, additionalHeaders?: HeadersInit): Request {
  const headers = new Headers(additionalHeaders);
  headers.set("accept", "application/json, text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("mcp-protocol-version", "2025-11-25");

  return new Request(`${origin}/mcp`, {
    body,
    headers,
    method: "POST",
  });
}

describe("authenticated MCP handler", () => {
  it("returns owner control-plane status through the read-only MCP tool", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_STATUS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );

    expect(response.status).toBe(200);
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(typeof text).toBe("string");
    expect(controlPlaneStatusResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      ok: true,
      status: {
        schemaVersion: 2,
        status: "ready",
      },
    });
  });

  it("rejects missing or malformed authority before MCP parsing", async () => {
    const request = toolRequest('{"do-not-reflect":"secret"}');
    const response = await handleAuthenticatedMcpRequest(request, env, {
      authority: {
        clientId: "test-client",
        ownerKey: "not-an-owner-key",
        scopes: [OWNER_READ_SCOPE],
      },
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).not.toContain("secret");
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "invalid_authority",
        message: "MCP request denied.",
      },
    });
  });

  it("rejects cross-origin browser requests", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest("{}", { origin: "https://attacker.example" }),
      env,
      { authority },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_origin",
        message: "MCP request denied.",
      },
    });
  });

  it("rejects oversized requests before reading their body", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      toolRequest("{}", { "content-length": String(64 * 1024 + 1) }),
      env,
      { authority },
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "request_too_large",
        message: "MCP request denied.",
      },
    });
  });

  it("returns a fixed MCP error when the control plane fails", async () => {
    const authority = await ownerAuthority();
    const failingEnv = {
      OWNER_CONTROL_PLANE: {
        getByName: () => ({
          createAgent: async () => {
            throw new Error("do-not-reflect-this");
          },
          getAgent: async () => {
            throw new Error("do-not-reflect-this");
          },
          listAgents: async () => {
            throw new Error("do-not-reflect-this");
          },
          status: async () => {
            throw new Error("do-not-reflect-this");
          },
        }),
      },
    };
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_STATUS_TOOL_NAME,
          },
        }),
      ),
      failingEnv,
      { authority },
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("control_plane_unavailable");
    expect(body).not.toContain("do-not-reflect-this");
  });

  it("advertises POST as the only stateless MCP request method", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(new Request(`${origin}/mcp`), env, {
      authority,
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("does not let the OAuth route prefix expose adjacent paths", async () => {
    const authority = await ownerAuthority();
    const response = await handleAuthenticatedMcpRequest(
      new Request(`${origin}/mcp/private`),
      env,
      { authority },
    );

    expect(response.status).toBe(404);
  });

  it("creates and lists an owner-scoped Agent through MCP", async () => {
    const authority = await ownerAuthority("mcp-agent-owner", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AGENTS_READ_SCOPE,
    ]);
    const input = {
      executionLimits: {
        maxDurationSeconds: 120,
        maxModelTokens: 8_000,
        maxToolCalls: 0,
        maxTurns: 3,
      },
      idempotencyKey: "mcp-create-agent-1",
      instructions: "Keep a concise owner-controlled work queue.",
      model: "anthropic/claude-sonnet-4",
      name: "Work queue",
    };
    const createResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 10,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: input,
            name: MCP_CREATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const createPayload: unknown = await createResponse.json();
    const createText = jsonRpcToolResultSchema.parse(createPayload).result.content[0]?.text;
    const created = createAgentResultSchema.parse(JSON.parse(createText ?? ""));

    expect(created).toMatchObject({
      agent: {
        capabilityGrants: [],
        instructions: input.instructions,
        revision: 1,
      },
      created: true,
      ok: true,
    });

    const listResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 11,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_LIST_AGENTS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const listPayload: unknown = await listResponse.json();
    const listText = jsonRpcToolResultSchema.parse(listPayload).result.content[0]?.text;
    const listed = listAgentsResultSchema.parse(JSON.parse(listText ?? ""));

    expect(listed).toMatchObject({
      agents: [{ name: input.name, revision: 1 }],
      nextCursor: null,
      ok: true,
    });
    expect(listText).not.toContain(input.instructions);

    if (!created.ok) {
      throw new Error("Expected Agent creation to succeed.");
    }

    const getResponse = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: created.agent.id },
            name: MCP_GET_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const getPayload: unknown = await getResponse.json();
    const getResult = jsonRpcToolResultSchema.parse(getPayload).result;
    const getText = getResult.content[0]?.text;

    expect(getResult.isError).toBe(false);
    expect(getAgentResultSchema.parse(JSON.parse(getText ?? ""))).toEqual({
      agent: created.agent,
      ok: true,
    });
  });

  it("returns a fixed insufficient-scope result for read-only Agent creation", async () => {
    const authority = await ownerAuthority("mcp-read-only-owner");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              executionLimits: {
                maxDurationSeconds: 120,
                maxModelTokens: 8_000,
                maxToolCalls: 0,
                maxTurns: 3,
              },
              idempotencyKey: "mcp-read-only-create",
              instructions: "This request must not create state.",
              model: "anthropic/claude-sonnet-4",
              name: "Denied Agent",
            },
            name: MCP_CREATE_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(response.status).toBe(200);
    expect(createAgentResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("does not widen legacy control read into full Agent-definition access", async () => {
    const authority = await ownerAuthority("mcp-legacy-control-read-owner", [OWNER_READ_SCOPE]);
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 13,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { id: "agent_00000000-0000-4000-8000-000000000000" },
            name: MCP_GET_AGENT_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(result.isError).toBe(true);
    expect(getAgentResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
  });

  it("searches the complete Composio integration catalog with read scope", async () => {
    const authority = await ownerAuthority("mcp-catalog-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
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
        ],
        next_cursor: null,
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 13,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { limit: 20, query: "web research" },
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(result.isError).toBe(false);
    expect(integrationCatalogSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
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
      ],
      nextCursor: null,
      ok: true,
    });
  });

  it("does not widen control read into integration catalog egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-catalog-owner", [OWNER_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 14,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {},
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(integrationCatalogSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("discovers exact Composio tools with integration read scope", async () => {
    const authority = await ownerAuthority("mcp-tool-catalog-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [
          {
            description: "Crawl a URL.",
            is_deprecated: false,
            name: "Scrape",
            no_auth: false,
            scopes: [],
            slug: "FIRECRAWL_SCRAPE",
            tags: ["web"],
            toolkit: {
              name: "Firecrawl",
              slug: "firecrawl",
            },
            version: "20260701_00",
          },
        ],
        next_cursor: null,
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 15,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              integrationSlug: "firecrawl",
              query: "crawl web",
            },
            name: MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(integrationToolSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      nextCursor: null,
      ok: true,
      tools: [
        {
          description: "Crawl a URL.",
          integration: {
            name: "Firecrawl",
            slug: "firecrawl",
          },
          name: "Scrape",
          noAuth: false,
          requiredScopes: [],
          slug: "FIRECRAWL_SCRAPE",
          tags: ["web"],
          version: "20260701_00",
        },
      ],
    });
  });

  it("does not widen control read into integration tool egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-tool-catalog-owner", [
      OWNER_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 16,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { integrationSlug: "github" },
            name: MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(integrationToolSearchResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("inspects one exact Composio tool schema with integration read scope", async () => {
    const authority = await ownerAuthority("mcp-tool-inspection-owner", [INTEGRATIONS_READ_SCOPE]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        input_parameters: {
          url: { type: "string" },
        },
        is_deprecated: false,
        name: "Scrape",
        no_auth: false,
        output_parameters: {
          markdown: { type: "string" },
        },
        scopes: [],
        slug: "FIRECRAWL_SCRAPE",
        tags: ["web"],
        toolkit: {
          name: "Firecrawl",
          slug: "firecrawl",
        },
        version: "20260701_00",
      }),
    );
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 17,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              slug: "FIRECRAWL_SCRAPE",
              version: "20260701_00",
            },
            name: MCP_INSPECT_INTEGRATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.isError).toBe(false);
    expect(inspectIntegrationToolResultSchema.parse(JSON.parse(text ?? ""))).toMatchObject({
      ok: true,
      tool: {
        inputParameters: {
          url: { type: "string" },
        },
        outputParameters: {
          markdown: { type: "string" },
        },
        slug: "FIRECRAWL_SCRAPE",
        version: "20260701_00",
      },
    });
  });

  it("does not widen control read into exact tool inspection egress", async () => {
    const authority = await ownerAuthority("mcp-control-read-tool-inspection-owner", [
      OWNER_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 18,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: {
              slug: "GITHUB_CREATE_ISSUE",
              version: "20260720_00",
            },
            name: MCP_INSPECT_INTEGRATION_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;
    const text = result.content[0]?.text;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(inspectIntegrationToolResultSchema.parse(JSON.parse(text ?? ""))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });
  });

  it("rejects a too-short integration search before provider egress", async () => {
    const authority = await ownerAuthority("mcp-short-catalog-query-owner", [
      INTEGRATIONS_READ_SCOPE,
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await handleAuthenticatedMcpRequest(
      toolRequest(
        JSON.stringify({
          id: 19,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { query: "ab" },
            name: MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
          },
        }),
      ),
      env,
      { authority },
    );
    const payload: unknown = await response.json();
    const result = jsonRpcToolResultSchema.parse(payload).result;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
