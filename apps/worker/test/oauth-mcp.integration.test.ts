import { createExecutionContext, env } from "cloudflare:test";
import {
  OWNER_READ_SCOPE,
  controlPlaneStatusResultSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { WorkerEnv } from "../src/env.js";
import { exchangeGithubAuthorizationCode } from "../src/auth.js";
import { handleWorkerRequest } from "../src/index.js";
import { MCP_STATUS_TOOL_NAME } from "../src/mcp-handler.js";
import { deriveOwnerKey } from "../src/owner-identity.js";
import { registerAuthTestDatabase } from "./auth-testkit.js";

const origin = "https://crewhelm.test";
const redirectUri = "https://client.example/oauth/callback";
const ownerGithubUserId = "123456";
const githubToken = "transient-github-token-must-not-be-stored";
const registrationSchema = z.looseObject({
  client_id: z.string().min(1),
  token_endpoint_auth_method: z.literal("none"),
});
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.literal(15 * 60),
  scope: z.literal(OWNER_READ_SCOPE),
  token_type: z.literal("Bearer"),
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
const sqliteIdentifierSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const sqliteTableSchema = z.looseObject({
  name: sqliteIdentifierSchema,
  sql: z.string(),
});

registerAuthTestDatabase();

function allowRateLimit(): RateLimit {
  return {
    limit: async () => ({ success: true }),
  };
}

function integrationEnv(rateLimit = allowRateLimit()): WorkerEnv {
  return {
    AUTH_DB: env.AUTH_DB,
    AUTH_RATE_LIMIT: rateLimit,
    BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    MCP_RATE_LIMIT: rateLimit,
    OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
    OWNER_GITHUB_USER_ID: ownerGithubUserId,
    PUBLIC_ORIGIN: origin,
  };
}

function request(workerEnv: WorkerEnv, path: string, init?: RequestInit): Promise<Response> {
  return handleWorkerRequest(
    new Request(`${origin}${path}`, init),
    workerEnv,
    createExecutionContext(),
  );
}

function callMcp(workerEnv: WorkerEnv, token: string): Promise<Response> {
  return request(workerEnv, "/mcp", {
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
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });
}

async function readAllAuthDatabaseText(database: D1Database): Promise<string> {
  const tableQuery = await database
    .prepare(
      `SELECT "name", "sql"
       FROM "sqlite_schema"
       WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`,
    )
    .all();
  const tables = z.array(sqliteTableSchema).parse(tableQuery.results);
  const contents: unknown[] = [];

  for (const table of tables) {
    const columns = [...table.sql.matchAll(/^\s*"([A-Za-z_][A-Za-z0-9_]*)"\s+text\b/gim)].map(
      (match) => sqliteIdentifierSchema.parse(match[1]),
    );

    if (columns.length > 0) {
      const select = columns.map((column) => `"${column}"`).join(", ");
      const rows = await database.prepare(`SELECT ${select} FROM "${table.name}"`).all();
      contents.push(rows.results);
    }
  }

  return JSON.stringify(contents);
}

class CookieJar {
  readonly values = new Map<string, string>();

  capture(response: Response): void {
    const combined = response.headers.get("set-cookie");

    if (combined === null) {
      return;
    }

    for (const cookie of combined.split(/,(?=\s*[^;,=\s]+=[^;,]*)/)) {
      const pair = cookie.trim().split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;

      if (pair === undefined || separator <= 0) {
        continue;
      }

      this.values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

function htmlAttribute(body: string, name: string): string {
  const match = body.match(new RegExp(`name="${name}" value="([^"]+)"`));

  if (match?.[1] === undefined) {
    throw new Error(`Expected ${name} form value.`);
  }

  return match[1]
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function responseLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location !== null) {
    return location;
  }

  throw new Error(`Expected redirect, received ${response.status}.`);
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

async function fetchUrl(input: RequestInfo | URL): Promise<string> {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public OAuth to MCP integration", () => {
  it("authenticates the configured GitHub owner and issues a revocable MCP token", async () => {
    const workerEnv = integrationEnv();
    const cookies = new CookieJar();
    const registrationResponse = await request(workerEnv, "/api/auth/oauth2/register", {
      body: JSON.stringify({
        client_name: "<script>Integration MCP client</script>",
        grant_types: ["authorization_code"],
        redirect_uris: [redirectUri],
        require_pkce: true,
        response_types: ["code"],
        scope: OWNER_READ_SCOPE,
        token_endpoint_auth_method: "none",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const registration = registrationSchema.parse(await registrationResponse.json());

    expect(registrationResponse.status).toBe(201);
    const verifier = "crewhelm-integration-verifier-0123456789abcdef";
    const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("code_challenge", await codeChallenge(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("resource", `${origin}/mcp`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", OWNER_READ_SCOPE);
    authorize.searchParams.set("state", "integration-client-state");
    const authorizeResponse = await request(workerEnv, `${authorize.pathname}${authorize.search}`, {
      headers: {
        accept: "text/html",
      },
    });
    const loginLocation = new URL(responseLocation(authorizeResponse), origin);

    expect(authorizeResponse.status).toBe(302);
    expect(loginLocation.pathname).toBe("/oauth/login");
    const loginPageResponse = await request(
      workerEnv,
      `${loginLocation.pathname}${loginLocation.search}`,
    );
    const loginPage = await loginPageResponse.text();
    const loginQuery = htmlAttribute(loginPage, "oauth_query");

    expect(loginPageResponse.status).toBe(200);
    expect(loginPageResponse.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const loginResponse = await request(workerEnv, "/oauth/login", {
      body: new URLSearchParams({ oauth_query: loginQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
        "sec-fetch-mode": "navigate",
      },
      method: "POST",
    });
    cookies.capture(loginResponse);
    const githubLocation = new URL(responseLocation(loginResponse), origin);
    const githubState = githubLocation.searchParams.get("state");

    expect(loginResponse.status).toBe(302);
    expect(githubLocation.origin).toBe("https://github.com");
    expect(githubLocation.searchParams.get("scope")).toBeNull();
    expect(githubState).not.toBeNull();
    const githubRequestOptions: Array<RequestInit | undefined> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = await fetchUrl(input);

      if (url.startsWith("https://github.com/login/oauth/access_token")) {
        githubRequestOptions.push(init);
        return Response.json({
          access_token: githubToken,
          scope: "",
          token_type: "bearer",
        });
      }

      if (url === "https://api.github.com/user") {
        githubRequestOptions.push(init);
        return Response.json({ id: Number(ownerGithubUserId) });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const callbackResponse = await request(
      workerEnv,
      `/api/auth/callback/github?code=github-code&state=${githubState ?? ""}`,
      {
        headers: {
          accept: "text/html",
          cookie: cookies.header(),
          "sec-fetch-mode": "navigate",
        },
      },
    );
    cookies.capture(callbackResponse);
    const consentLocation = new URL(responseLocation(callbackResponse), origin);

    expect(callbackResponse.status).toBe(302);
    expect(githubRequestOptions.map((options) => options?.redirect)).toEqual(["manual", "manual"]);
    expect(githubRequestOptions.every((options) => options?.signal instanceof AbortSignal)).toBe(
      true,
    );
    expect(consentLocation.pathname).toBe("/oauth/consent");
    const tamperedConsentLocation = new URL(consentLocation);
    tamperedConsentLocation.searchParams.set(
      "redirect_uri",
      "https://attacker.example/phishing-return",
    );
    const tamperedConsentResponse = await request(
      workerEnv,
      `${tamperedConsentLocation.pathname}${tamperedConsentLocation.search}`,
      {
        headers: {
          cookie: cookies.header(),
        },
      },
    );

    expect(tamperedConsentResponse.status).toBe(400);
    expect(await tamperedConsentResponse.text()).not.toContain("attacker.example");
    const consentPageResponse = await request(
      workerEnv,
      `${consentLocation.pathname}${consentLocation.search}`,
      {
        headers: {
          cookie: cookies.header(),
        },
      },
    );
    const consentPage = await consentPageResponse.text();
    const consentQuery = htmlAttribute(consentPage, "oauth_query");

    expect(consentPageResponse.status).toBe(200);
    expect(consentPage).toContain("&lt;script&gt;Integration MCP client&lt;/script&gt;");
    expect(consentPage).not.toContain("<script>Integration MCP client</script>");
    expect(consentPage).toContain("read-only access");
    const consentResponse = await request(workerEnv, "/oauth/consent", {
      body: new URLSearchParams({
        decision: "approve",
        oauth_query: consentQuery,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies.header(),
        origin,
        "sec-fetch-mode": "navigate",
      },
      method: "POST",
    });
    const clientLocation = new URL(responseLocation(consentResponse), origin);
    const authorizationCode = clientLocation.searchParams.get("code");

    expect(consentResponse.status).toBe(302);
    expect(clientLocation.origin).toBe("https://client.example");
    expect(clientLocation.searchParams.get("state")).toBe("integration-client-state");
    expect(clientLocation.searchParams.get("iss")).toBe(`${origin}/api/auth`);
    expect(authorizationCode).not.toBeNull();
    const expectedOwnerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: ownerGithubUserId,
    });
    const usersBeforeToken = await workerEnv.AUTH_DB.prepare(
      `SELECT "id", "ownerKey" FROM "user"`,
    ).all();

    expect(usersBeforeToken.results).toContainEqual({
      id: expectedOwnerKey,
      ownerKey: expectedOwnerKey,
    });
    const exchangeToken = () =>
      request(workerEnv, "/api/auth/oauth2/token", {
        body: new URLSearchParams({
          client_id: registration.client_id,
          code: authorizationCode ?? "",
          code_verifier: verifier,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
          resource: `${origin}/mcp`,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
    const tokenResponses = await Promise.all([exchangeToken(), exchangeToken()]);
    expect(
      tokenResponses.map((response) => response.status).toSorted((left, right) => left - right),
    ).toEqual([200, 400]);
    const tokenResponse = tokenResponses.find((response) => response.ok);

    if (tokenResponse === undefined) {
      throw new Error("Expected exactly one successful token exchange.");
    }

    const rawToken: unknown = await tokenResponse.json();
    const token = tokenSchema.parse(rawToken);

    expect(tokenResponse.status).toBe(200);
    expect(typeof rawToken === "object" && rawToken !== null && "refresh_token" in rawToken).toBe(
      false,
    );
    const storedAccounts = await workerEnv.AUTH_DB.prepare(
      `SELECT
         "accountId", "accessToken", "refreshToken", "idToken",
         "accessTokenExpiresAt", "refreshTokenExpiresAt"
       FROM "account"`,
    ).all();
    const storedUsers = await workerEnv.AUTH_DB.prepare(
      `SELECT "id", "ownerKey", "email" FROM "user"`,
    ).all();
    const ownerKey = ownerKeySchema.parse(storedUsers.results[0]?.ownerKey);

    expect(storedAccounts.results).toHaveLength(1);
    expect(storedAccounts.results[0]).toMatchObject({
      accessToken: null,
      accessTokenExpiresAt: null,
      accountId: ownerKey,
      idToken: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
    expect(storedUsers.results).toEqual([
      {
        email: `${ownerKey}@identity.invalid`.toLowerCase(),
        id: ownerKey,
        ownerKey,
      },
    ]);
    expect(JSON.stringify([...storedAccounts.results, ...storedUsers.results])).not.toContain(
      ownerGithubUserId,
    );
    expect(JSON.stringify([...storedAccounts.results, ...storedUsers.results])).not.toContain(
      githubToken,
    );
    const authDatabaseText = await readAllAuthDatabaseText(workerEnv.AUTH_DB);

    expect(authDatabaseText).not.toContain(githubToken);
    expect(authDatabaseText).not.toContain(workerEnv.GITHUB_CLIENT_SECRET);
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

    expect(wrongAudienceResponse.status).toBe(421);
    const mcpResponse = await callMcp(workerEnv, token.access_token);
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
    const otherRegistration = registrationSchema.parse(
      await (
        await request(workerEnv, "/api/auth/oauth2/register", {
          body: JSON.stringify({
            grant_types: ["authorization_code"],
            redirect_uris: ["https://other-client.example/callback"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        })
      ).json(),
    );
    const crossClientRevocation = await request(workerEnv, "/api/auth/oauth2/revoke", {
      body: new URLSearchParams({
        client_id: otherRegistration.client_id,
        token: token.access_token,
        token_type_hint: "access_token",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(crossClientRevocation.status).toBe(200);
    expect((await callMcp(workerEnv, token.access_token)).status).toBe(200);
    await workerEnv.AUTH_DB.prepare(
      `UPDATE "mcpClientRegistration" SET "expiresAt" = 0 WHERE "clientId" = ?`,
    )
      .bind(registration.client_id)
      .run();
    const expiredClientRevocation = await request(workerEnv, "/api/auth/oauth2/revoke", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        token: token.access_token,
        token_type_hint: "access_token",
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(expiredClientRevocation.status).toBe(200);
    const revokedBearerResponse = await callMcp(workerEnv, token.access_token);

    expect(revokedBearerResponse.status).toBe(401);
    const revocations = await workerEnv.AUTH_DB.prepare(
      `SELECT "tokenHash" FROM "mcpTokenRevocation"`,
    ).all();

    expect(revocations.results).toHaveLength(1);
    expect(JSON.stringify(revocations.results)).not.toContain(token.access_token);
  });

  it("logs only a fixed stage for a secret-bearing GitHub token error", async () => {
    const providerSecret = "provider-secret-that-must-never-be-logged";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          error: "bad_verification_code",
          error_description: providerSecret,
        },
        { status: 400 },
      ),
    );

    await expect(
      exchangeGithubAuthorizationCode(
        {
          GITHUB_CLIENT_ID: "github-client-id",
          GITHUB_CLIENT_SECRET: "github-client-secret",
        },
        {
          code: "rejected-code",
          redirectURI: `${origin}/api/auth/callback/github`,
        },
      ),
    ).rejects.toThrow("GitHub OAuth token exchange failed.");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("crewhelm.authorization_unavailable", {
      stage: "github_token_response",
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(providerSecret);
  });

  it.each([
    [{ access_token: githubToken, scope: "read:user", token_type: "bearer" }],
    [{ access_token: githubToken, scope: "", token_type: "mac" }],
  ])("rejects an overprivileged or non-bearer GitHub credential: %j", async (payload) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payload));

    await expect(
      exchangeGithubAuthorizationCode(
        {
          GITHUB_CLIENT_ID: "github-client-id",
          GITHUB_CLIENT_SECRET: "github-client-secret",
        },
        {
          code: "rejected-code",
          redirectURI: `${origin}/api/auth/callback/github`,
        },
      ),
    ).rejects.toThrow("GitHub OAuth token exchange failed.");
  });

  it.each([
    [
      "a redirect response",
      () =>
        new Response(null, {
          headers: { location: "https://attacker.example/token" },
          status: 302,
        }),
    ],
    ["malformed JSON", () => new Response("{")],
    [
      "an oversized chunked response",
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(16 * 1024 + 1));
              controller.close();
            },
          }),
        ),
    ],
    ["a non-success response", () => new Response("denied", { status: 502 })],
  ])("rejects GitHub token exchange with %s", async (_label, response) => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response());

    await expect(
      exchangeGithubAuthorizationCode(
        {
          GITHUB_CLIENT_ID: "github-client-id",
          GITHUB_CLIENT_SECRET: "github-client-secret",
        },
        {
          code: "rejected-code",
          redirectURI: `${origin}/api/auth/callback/github`,
        },
      ),
    ).rejects.toThrow("GitHub OAuth token exchange failed.");
    const init = fetchMock.mock.calls[0]?.[1];

    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["http://crewhelm.test", "https://crewhelm.test/path"])(
    "fails closed for invalid PUBLIC_ORIGIN %s",
    async (publicOrigin) => {
      const response = await handleWorkerRequest(
        new Request(`${origin}/health`),
        {
          ...integrationEnv(),
          PUBLIC_ORIGIN: publicOrigin,
        },
        createExecutionContext(),
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "internal_error",
          message: "Internal server error.",
        },
      });
    },
  );

  it("rejects an alternate request origin before routing", async () => {
    const response = await handleWorkerRequest(
      new Request("https://alternate.example/health"),
      integrationEnv(),
      createExecutionContext(),
    );

    expect(response.status).toBe(421);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "misdirected_request",
        message: "Request denied.",
      },
    });
  });

  it("fails closed when GitHub authenticates a different numeric account", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workerEnv = {
      ...integrationEnv(),
      OWNER_GITHUB_USER_ID: "999999",
    };
    const cookies = new CookieJar();
    const usersBefore = await workerEnv.AUTH_DB.prepare(`SELECT "id" FROM "user"`).all();
    const registrationResponse = await request(workerEnv, "/api/auth/oauth2/register", {
      body: JSON.stringify({
        grant_types: ["authorization_code"],
        redirect_uris: [redirectUri],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const registration = registrationSchema.parse(await registrationResponse.json());
    const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("code_challenge", "A".repeat(43));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("resource", `${origin}/mcp`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", OWNER_READ_SCOPE);
    const authorizeResponse = await request(workerEnv, `${authorize.pathname}${authorize.search}`);
    const loginLocation = new URL(responseLocation(authorizeResponse), origin);
    const loginPage = await (
      await request(workerEnv, `${loginLocation.pathname}${loginLocation.search}`)
    ).text();
    const loginResponse = await request(workerEnv, "/oauth/login", {
      body: new URLSearchParams({ oauth_query: htmlAttribute(loginPage, "oauth_query") }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      method: "POST",
    });
    cookies.capture(loginResponse);
    const githubState = new URL(responseLocation(loginResponse), origin).searchParams.get("state");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = await fetchUrl(input);
      return url.startsWith("https://github.com/login/oauth/access_token")
        ? Response.json({ access_token: githubToken, scope: "", token_type: "bearer" })
        : Response.json({ id: Number(ownerGithubUserId) });
    });
    const callbackResponse = await request(
      workerEnv,
      `/api/auth/callback/github?code=github-code&state=${githubState ?? ""}`,
      {
        headers: {
          accept: "text/html",
          cookie: cookies.header(),
        },
      },
    );

    expect(callbackResponse.status).toBe(302);
    expect(new URL(responseLocation(callbackResponse), origin).pathname).toBe("/oauth/error");
    expect(consoleError.mock.calls).toContainEqual([
      "crewhelm.authorization_unavailable",
      { stage: "github_owner_mismatch" },
    ]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(ownerGithubUserId);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(workerEnv.OWNER_GITHUB_USER_ID);
    const usersAfter = await workerEnv.AUTH_DB.prepare(`SELECT "id" FROM "user"`).all();
    expect(usersAfter.results).toHaveLength(usersBefore.results.length);
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
    const response = await request(integrationEnv(rateLimit), "/api/auth/oauth2/register", {
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
