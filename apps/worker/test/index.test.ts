import { SELF } from "cloudflare:test";
import { OWNER_READ_SCOPE, healthReportSchema, ownerAuthoritySchema } from "@crewhelm/contracts";
import { GrantType } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it, vi } from "vitest";

import {
  bindAccessTokenAuthority,
  createWorker,
  validateClientRegistration,
} from "../src/index.js";

const origin = "https://crewhelm.test";
const worker = createWorker();
const authority = ownerAuthoritySchema.parse({
  clientId: "test-client",
  ownerKey: `owner_${"A".repeat(43)}`,
  scopes: [OWNER_READ_SCOPE],
});

function registrationRequest(
  redirectUris: string[],
  contentLength = 128,
): Parameters<typeof validateClientRegistration>[0] {
  return {
    clientMetadata: {
      redirect_uris: redirectUris,
    },
    request: new Request(`${origin}/oauth/register`, {
      headers: {
        "content-length": String(contentLength),
      },
      method: "POST",
    }),
  };
}

function request(path: string, init?: RequestInit): Promise<Response> | Response {
  return worker.fetch(new Request(`${origin}${path}`, init));
}

describe("Crewhelm Worker", () => {
  it.each([
    "https://client.example/oauth/callback",
    "http://localhost:43123/oauth/callback",
    "http://127.0.0.1:43123/oauth/callback",
    "http://[::1]:43123/oauth/callback",
  ])("allows a bounded HTTPS or loopback OAuth redirect: %s", (redirectUri) => {
    expect(validateClientRegistration(registrationRequest([redirectUri]))).toBeUndefined();
  });

  it.each([
    "http://client.example/oauth/callback",
    "custom-scheme://oauth/callback",
    "https://user:password@client.example/oauth/callback",
    "https://client.example/oauth/callback#fragment",
  ])("rejects an unsafe OAuth redirect: %s", (redirectUri) => {
    expect(validateClientRegistration(registrationRequest([redirectUri]))).toEqual({
      code: "invalid_client_metadata",
      description: "Client registration denied.",
      status: 400,
    });
  });

  it("rejects oversized OAuth client registration metadata", () => {
    expect(
      validateClientRegistration(
        registrationRequest(["https://client.example/oauth/callback"], 8 * 1024 + 1),
      ),
    ).toMatchObject({
      code: "invalid_client_metadata",
      status: 400,
    });
  });

  it("binds the effective token scope into encrypted MCP authority", () => {
    expect(
      bindAccessTokenAuthority({
        clientId: authority.clientId,
        grantId: "grant",
        grantType: GrantType.AUTHORIZATION_CODE,
        props: { authority },
        requestedScope: [OWNER_READ_SCOPE],
        scope: [OWNER_READ_SCOPE],
        userId: authority.ownerKey,
      }),
    ).toEqual({
      accessTokenProps: { authority },
      accessTokenScope: [OWNER_READ_SCOPE],
      refreshTokenTTL: 0,
    });
  });

  it("rejects a token downscoped below MCP read authority", () => {
    expect(() =>
      bindAccessTokenAuthority({
        clientId: authority.clientId,
        grantId: "grant",
        grantType: GrantType.AUTHORIZATION_CODE,
        props: { authority },
        requestedScope: [],
        scope: [OWNER_READ_SCOPE],
        userId: authority.ownerKey,
      }),
    ).toThrow("Requested scope denied.");
  });

  it("rejects token authority with a mismatched client or owner", () => {
    const mismatches = [
      {
        clientId: "other-client",
        userId: authority.ownerKey,
      },
      {
        clientId: authority.clientId,
        userId: `owner_${"B".repeat(43)}`,
      },
    ];

    for (const mismatch of mismatches) {
      expect(() =>
        bindAccessTokenAuthority({
          ...mismatch,
          grantId: "grant",
          grantType: GrantType.AUTHORIZATION_CODE,
          props: { authority },
          requestedScope: [OWNER_READ_SCOPE],
          scope: [OWNER_READ_SCOPE],
        }),
      ).toThrow("Requested scope denied.");
    }
  });

  it("routes public health and protected MCP requests through the OAuth provider", async () => {
    const healthResponse = await SELF.fetch(`${origin}/health`);
    const mcpResponse = await SELF.fetch(`${origin}/mcp`, {
      method: "POST",
    });

    expect(healthResponse.status).toBe(200);
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get("www-authenticate")).toContain("Bearer");
    expect(await mcpResponse.text()).not.toContain("/mcp");
  });

  it("reports fixed liveness metadata without caching", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload: unknown = await response.json();

    expect(healthReportSchema.parse(payload)).toEqual({
      service: "crewhelm",
      status: "ok",
    });
  });

  it("supports health probes without returning a HEAD body", async () => {
    const getResponse = await request("/health");
    const headResponse = await request("/health", { method: "HEAD" });

    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(
      getResponse.headers.get("content-length"),
    );
    await expect(headResponse.text()).resolves.toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])(
    "rejects unsupported %s health requests without reflecting request data",
    async (method) => {
      const response = await request("/health", {
        body: "do-not-reflect-this",
        method,
      });
      const body = await response.text();

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(JSON.parse(body)).toEqual({
        error: {
          code: "method_not_allowed",
          message: "Method not allowed.",
        },
      });
      expect(body).not.toContain("do-not-reflect-this");
    },
  );

  it("fails closed for every other route without reflecting the URL", async () => {
    const response = await request("/private?token=do-not-reflect-this");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "not_found",
        message: "Not found.",
      },
    });
    expect(body).not.toContain("private");
    expect(body).not.toContain("do-not-reflect-this");
  });

  it.each(["/%68ealth", "/he%61lth", "/health/", "/HEALTH"])(
    "does not treat %s as the canonical health route",
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "not_found",
          message: "Not found.",
        },
      });
    },
  );

  it("preserves HEAD semantics for unknown routes", async () => {
    const getResponse = await request("/private");
    const headResponse = await request("/private", { method: "HEAD" });

    expect(headResponse.status).toBe(404);
    expect(headResponse.headers.get("content-length")).toBe(
      getResponse.headers.get("content-length"),
    );
    await expect(headResponse.text()).resolves.toBe("");
  });

  it("returns a fixed internal error without logging or reflecting the exception", async () => {
    const failingWorker = createWorker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failingWorker.get("/failure", () => {
      throw new Error("do-not-reflect-this");
    });

    const response = await failingWorker.fetch(new Request(`${origin}/failure`));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(body).not.toContain("do-not-reflect-this");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
