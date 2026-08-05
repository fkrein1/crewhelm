import { describe, expect, it } from "vitest";

import {
  createRemoteMcpConnectionInputSchema,
  remoteMcpApiKeyHeaderNameSchema,
  remoteMcpConnectionSchema,
  remoteMcpConnectionOperationInputSchema,
} from "./remote-mcp.js";

const catalog = [
  {
    inputSchema: { type: "object" as const },
    name: "records.read",
  },
];
const base = {
  catalog,
  catalogBytes: new TextEncoder().encode(JSON.stringify(catalog)).byteLength,
  endpoint: "https://mcp.example.com/rpc",
  idempotencyKey: "api-key-connection",
  name: "API MCP",
  server: { name: "api-mcp", version: "1" },
  snapshotDigest: "a".repeat(64),
};

describe("remote MCP API-key authentication", () => {
  it("accepts one bounded named header and keeps the key out of MCP operations", () => {
    expect(
      remoteMcpConnectionOperationInputSchema.parse({
        action: "connect",
        apiKeyHeaderName: "X-API-Key",
        authKind: "api_key",
        endpoint: base.endpoint,
        idempotencyKey: base.idempotencyKey,
        name: base.name,
      }),
    ).toMatchObject({ apiKeyHeaderName: "x-api-key", authKind: "api_key" });

    expect(
      createRemoteMcpConnectionInputSchema.parse({
        ...base,
        apiKey: { headerName: "X-API-Key", value: "private-api-key" },
        authKind: "api_key",
      }),
    ).toMatchObject({
      apiKey: { headerName: "x-api-key", value: "private-api-key" },
      authKind: "api_key",
    });
  });

  it("exposes the normalized header name without exposing its credential", () => {
    expect(
      remoteMcpConnectionSchema.parse({
        apiKeyHeaderName: "X-API-Key",
        authKind: "api_key",
        catalog,
        catalogBytes: base.catalogBytes,
        connectionId: `connection_${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
        endpoint: base.endpoint,
        name: base.name,
        oauthScopes: [],
        server: base.server,
        snapshotDigest: base.snapshotDigest,
        status: "active",
      }),
    ).toMatchObject({ apiKeyHeaderName: "x-api-key", authKind: "api_key" });
  });

  it.each([
    "Authorization",
    "Cookie",
    "Host",
    "Content-Type",
    "Mcp-Session-Id",
    "Sec-Fetch-Site",
    "X-Forwarded-For",
  ])("rejects reserved header %s", (headerName) => {
    expect(remoteMcpApiKeyHeaderNameSchema.safeParse(headerName).success).toBe(false);
  });
});
