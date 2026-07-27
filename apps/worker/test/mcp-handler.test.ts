import { env } from "cloudflare:test";
import {
  OWNER_READ_SCOPE,
  controlPlaneStatusResultSchema,
  ownerAuthoritySchema,
} from "@crewhelm/contracts";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { MCP_STATUS_TOOL_NAME, handleAuthenticatedMcpRequest } from "../src/mcp-handler.js";
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
  }),
});

async function ownerAuthority() {
  return ownerAuthoritySchema.parse({
    clientId: "test-client",
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "123456",
    }),
    scopes: [OWNER_READ_SCOPE],
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
        schemaVersion: 1,
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
});
