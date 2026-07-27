import { createExecutionContext, env } from "cloudflare:test";
import { OWNER_READ_SCOPE, controlPlaneStatusResultSchema } from "@crewhelm/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { WorkerEnv } from "../src/env.js";
import { handleWorkerRequest } from "../src/index.js";
import { MCP_STATUS_TOOL_NAME } from "../src/mcp-handler.js";

const origin = "https://crewhelm.test";
const redirectUri = "https://client.example/oauth/callback";
const ownerGithubUserId = "123456";
const registrationSchema = z.looseObject({
  client_id: z.string().min(1),
});
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.literal(15 * 60),
  resource: z.literal(`${origin}/mcp`),
  scope: z.literal(OWNER_READ_SCOPE),
  token_type: z.literal("bearer"),
});
const toolResultSchema = z.looseObject({
  result: z.looseObject({
    content: z.tuple([
      z.looseObject({
        text: z.string(),
        type: z.literal("text"),
      }),
    ]),
    isError: z.boolean(),
  }),
});

function allowRateLimit(): RateLimit {
  return {
    limit: async () => ({ success: true }),
  };
}

function integrationEnv(rateLimit = allowRateLimit()): WorkerEnv {
  return {
    AUTH_RATE_LIMIT: rateLimit,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    MCP_RATE_LIMIT: rateLimit,
    OAUTH_KV: env.OAUTH_KV,
    OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
    OWNER_GITHUB_USER_ID: ownerGithubUserId,
  };
}

function request(workerEnv: WorkerEnv, path: string, init?: RequestInit): Promise<Response> {
  return handleWorkerRequest(
    new Request(`${origin}${path}`, init),
    workerEnv,
    createExecutionContext(),
  );
}

function cookieValue(response: Response, name: string): string {
  const cookie = response.headers.get("set-cookie");
  const match = cookie?.match(new RegExp(`${name}=([A-Za-z0-9_-]{43})`));

  if (match?.[1] === undefined) {
    throw new Error(`Expected ${name} cookie.`);
  }

  return match[1];
}

function hiddenConsent(body: string): string {
  const match = body.match(/name="consent" value="([A-Za-z0-9_-]{43})"/);

  if (match?.[1] === undefined) {
    throw new Error("Expected consent value.");
  }

  return match[1];
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public OAuth to MCP integration", () => {
  it("registers, authorizes, exchanges, audience-checks, and calls owner status", async () => {
    const workerEnv = integrationEnv();
    const registrationResponse = await request(workerEnv, "/oauth/register", {
      body: JSON.stringify({
        client_name: "Integration MCP client",
        grant_types: ["authorization_code"],
        redirect_uris: [redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const registration = registrationSchema.parse(await registrationResponse.json());
    const verifier = "crewhelm-integration-verifier-0123456789abcdef";
    const authorize = new URL(`${origin}/authorize`);
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("code_challenge", await codeChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("resource", `${origin}/mcp`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", OWNER_READ_SCOPE);
    authorize.searchParams.set("state", "integration-client-state");
    const consentResponse = await request(workerEnv, `${authorize.pathname}${authorize.search}`);
    const consent = hiddenConsent(await consentResponse.text());
    const consentCookie = cookieValue(consentResponse, "__Host-crewhelm-consent");
    const githubResponse = await request(workerEnv, "/authorize", {
      body: new URLSearchParams({
        consent,
        decision: "approve",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-crewhelm-consent=${consentCookie}`,
      },
      method: "POST",
    });
    const githubLocation = new URL(githubResponse.headers.get("location") ?? origin);
    const githubState = githubLocation.searchParams.get("state");

    expect(githubResponse.status).toBe(302);
    expect(githubLocation.origin).toBe("https://github.com");
    expect(githubState).toMatch(/^[A-Za-z0-9_-]{43}$/);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: "transient-github-token",
          scope: "",
          token_type: "bearer",
        });
      }

      if (url === "https://api.github.com/user") {
        return Response.json({ id: Number(ownerGithubUserId) });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const callbackResponse = await request(
      workerEnv,
      `/oauth/github/callback?code=github-code&state=${githubState ?? ""}`,
      {
        headers: {
          cookie: `__Host-crewhelm-github-state=${githubState ?? ""}`,
        },
      },
    );
    const clientLocation = new URL(callbackResponse.headers.get("location") ?? origin);
    const authorizationCode = clientLocation.searchParams.get("code");

    expect(callbackResponse.status).toBe(302);
    expect(clientLocation.origin).toBe("https://client.example");
    expect(clientLocation.searchParams.get("state")).toBe("integration-client-state");
    expect(authorizationCode).not.toBeNull();
    const tokenResponse = await request(workerEnv, "/oauth/token", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        code: authorizationCode ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource: `${origin}/mcp`,
        scope: OWNER_READ_SCOPE,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const rawToken: unknown = await tokenResponse.json();
    const token = tokenSchema.parse(rawToken);

    expect(tokenResponse.status).toBe(200);
    expect(typeof rawToken === "object" && rawToken !== null && "refresh_token" in rawToken).toBe(
      false,
    );
    const wrongAudienceResponse = await handleWorkerRequest(
      new Request("https://other.example/mcp", {
        body: "{}",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token.access_token}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
      workerEnv,
      createExecutionContext(),
    );

    expect(wrongAudienceResponse.status).toBe(401);
    const invalidBearerResponse = await request(workerEnv, "/mcp", {
      body: "{}",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer invalid-token",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(invalidBearerResponse.status).toBe(401);
    const mcpResponse = await request(workerEnv, "/mcp", {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: MCP_STATUS_TOOL_NAME,
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      method: "POST",
    });
    const toolResult = toolResultSchema.parse(await mcpResponse.json()).result;

    expect(mcpResponse.status).toBe(200);
    expect(toolResult.isError).toBe(false);
    expect(controlPlaneStatusResultSchema.parse(JSON.parse(toolResult.content[0].text))).toEqual({
      ok: true,
      status: {
        schemaVersion: 1,
        status: "ready",
      },
    });
    const revocationResponse = await request(workerEnv, "/oauth/token", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        token: token.access_token,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(revocationResponse.status).toBe(200);
    const revokedBearerResponse = await request(workerEnv, "/mcp", {
      body: JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {},
          name: MCP_STATUS_TOOL_NAME,
        },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      },
      method: "POST",
    });

    expect(revokedBearerResponse.status).toBe(401);
  });

  it("bounds chunked OAuth bodies before the provider parses them", async () => {
    const response = await request(integrationEnv(), "/oauth/register", {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8 * 1024 + 1));
          controller.close();
        },
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
  });

  it.each([
    ["returns 429 when exhausted", async () => ({ success: false }), 429],
    [
      "fails closed when unavailable",
      async () => {
        throw new Error("do-not-reflect-this");
      },
      503,
    ],
  ])("%s", async (_label, limit, expectedStatus) => {
    const rateLimit: RateLimit = { limit };
    const response = await request(integrationEnv(rateLimit), "/oauth/register", {
      body: "{}",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.text();

    expect(response.status).toBe(expectedStatus);
    expect(body).not.toContain("do-not-reflect-this");
  });
});
