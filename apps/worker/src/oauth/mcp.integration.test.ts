import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  OWNER_DEFAULT_SCOPE_CLAIM,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  createAgentResultSchema,
  createConnectionLinkResultSchema,
  controlPlaneStatusResultSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  integrationCatalogSearchResultSchema,
  listAgentRevisionsResultSchema,
  listAgentsResultSchema,
  listConnectionsResultSchema,
  ownerAuthoritySchema,
  ownerKeySchema,
  ownerScopeClaimSchema,
  updateAgentResultSchema,
} from "@crewhelm/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX } from "../owner/connections/authorization-return.js";
import type { WorkerEnv } from "../env.js";
import { handleWorkerRequest } from "../http/server.js";
import {
  MCP_CREATE_AGENT_TOOL_NAME,
  MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
  MCP_GET_AGENT_TOOL_NAME,
  MCP_GET_AGENT_REVISION_TOOL_NAME,
  MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
  MCP_LIST_AGENTS_TOOL_NAME,
  MCP_LIST_CONNECTIONS_TOOL_NAME,
  MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
  MCP_STATUS_TOOL_NAME,
  MCP_UPDATE_AGENT_TOOL_NAME,
} from "../mcp/server.js";
import { deriveOwnerKey } from "../owner/identity.js";
import { exchangeGithubAuthorizationCode } from "./auth.js";
import { registerAuthTestDatabase } from "./testkit.js";

const origin = "https://crewhelm.test";
const redirectUri = "https://client.example/oauth/callback";
const ownerGithubUserId = "123456";
const githubToken = "transient-github-token-must-not-be-stored";
const reversedOwnerScopeClaim = `${INTEGRATIONS_READ_SCOPE} ${CONNECTIONS_WRITE_SCOPE} ${CONNECTIONS_READ_SCOPE} ${AGENTS_WRITE_SCOPE} ${AGENTS_READ_SCOPE} ${OWNER_WRITE_SCOPE} ${OWNER_READ_SCOPE}`;
const registrationSchema = z.looseObject({
  client_id: z.string().min(1),
  token_endpoint_auth_method: z.literal("none"),
});
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.literal(15 * 60),
  scope: ownerScopeClaimSchema,
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

function integrationEnv(
  rateLimit = allowRateLimit(),
  configuredOwnerGithubUserId = ownerGithubUserId,
): WorkerEnv {
  return {
    AI: env.AI,
    AUTH_DB: env.AUTH_DB,
    AUTH_RATE_LIMIT: rateLimit,
    BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
    COMPOSIO_API_KEY: "test-composio-api-key",
    CREW_AGENT: env.CREW_AGENT,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    MCP_RATE_LIMIT: rateLimit,
    OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
    OWNER_GITHUB_USER_ID: configuredOwnerGithubUserId,
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

function callMcp(
  workerEnv: WorkerEnv,
  token: string,
  name = MCP_STATUS_TOOL_NAME,
  arguments_: Record<string, unknown> = {},
): Promise<Response> {
  return request(workerEnv, "/mcp", {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: arguments_,
        name,
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

async function completeOAuthFlow(
  workerEnv: WorkerEnv,
  scope: string,
): Promise<{
  consentPage: string;
  token: z.infer<typeof tokenSchema>;
}> {
  const cookies = new CookieJar();
  const registrationResponse = await request(workerEnv, "/api/auth/oauth2/register", {
    body: JSON.stringify({
      client_name: "Scoped integration client",
      grant_types: ["authorization_code"],
      redirect_uris: [redirectUri],
      require_pkce: true,
      response_types: ["code"],
      scope,
      token_endpoint_auth_method: "none",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const registration = registrationSchema.parse(await registrationResponse.json());
  const verifier = "crewhelm-scoped-verifier-0123456789abcdef0123456789";
  const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);

  authorize.searchParams.set("client_id", registration.client_id);
  authorize.searchParams.set("code_challenge", await codeChallenge(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("resource", `${origin}/mcp`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", "scoped-integration-state");
  const authorizeResponse = await request(workerEnv, `${authorize.pathname}${authorize.search}`, {
    headers: { accept: "text/html" },
  });
  const loginLocation = new URL(responseLocation(authorizeResponse), origin);
  const loginPage = await (
    await request(workerEnv, `${loginLocation.pathname}${loginLocation.search}`)
  ).text();
  const loginResponse = await request(workerEnv, "/oauth/login", {
    body: new URLSearchParams({
      oauth_query: htmlAttribute(loginPage, "oauth_query"),
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      "sec-fetch-mode": "navigate",
    },
    method: "POST",
  });

  cookies.capture(loginResponse);
  const githubState = new URL(responseLocation(loginResponse), origin).searchParams.get("state");

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = await fetchUrl(input);

    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({
        access_token: githubToken,
        scope: "",
        token_type: "bearer",
      });
    }

    if (url === "https://api.github.com/user") {
      return Response.json({ id: Number(workerEnv.OWNER_GITHUB_USER_ID) });
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
  const consentPage = await (
    await request(workerEnv, `${consentLocation.pathname}${consentLocation.search}`, {
      headers: { cookie: cookies.header() },
    })
  ).text();
  const consentResponse = await request(workerEnv, "/oauth/consent", {
    body: new URLSearchParams({
      decision: "approve",
      oauth_query: htmlAttribute(consentPage, "oauth_query"),
    }),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies.header(),
      origin,
      "sec-fetch-mode": "navigate",
    },
    method: "POST",
  });
  const authorizationCode = new URL(responseLocation(consentResponse), origin).searchParams.get(
    "code",
  );
  const tokenResponse = await request(workerEnv, "/api/auth/oauth2/token", {
    body: new URLSearchParams({
      client_id: registration.client_id,
      code: authorizationCode ?? "",
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      resource: `${origin}/mcp`,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  return {
    consentPage,
    token: tokenSchema.parse(await tokenResponse.json()),
  };
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
        application_type: "native",
        client_name: "<script>Integration MCP client</script>",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [redirectUri],
        require_pkce: true,
        response_types: ["code"],
        scope: reversedOwnerScopeClaim,
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
    authorize.searchParams.set("scope", reversedOwnerScopeClaim);
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
    expect(consentPage).toContain("View control-plane status and Agent summaries.");
    expect(consentPage).toContain("View full Agent definitions, including instructions.");
    expect(consentPage).toContain("Update Agent definitions by creating immutable revisions.");
    expect(consentPage).toContain(
      "Create Agent definitions with bounded configuration and no capability grants.",
    );
    expect(consentPage).toContain(
      "Search the Composio integration catalog and inspect exact tool schemas. Search terms are sent to Composio.",
    );
    expect(consentPage).toContain(
      "Create private, short-lived Composio Connect Links. The selected auth configuration and an opaque owner key are sent to Composio; provider credentials stay with Composio.",
    );
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
    expect(token.scope).toBe(OWNER_DEFAULT_SCOPE_CLAIM);
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
        schemaVersion: 3,
        status: "ready",
      },
    });
    const createMcpResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        executionLimits: {
          maxDurationSeconds: 180,
          maxModelTokens: 12_000,
          maxToolCalls: 0,
          maxTurns: 3,
        },
        idempotencyKey: "oauth-integration-create-agent",
        instructions: "Maintain a concise authenticated work queue.",
        model: "anthropic/claude-sonnet-4",
        name: "Authenticated work queue",
      },
    );
    const createToolResult = toolResultSchema.parse(await createMcpResponse.json()).result;

    expect(createMcpResponse.status).toBe(200);
    expect(createToolResult.isError).toBe(false);
    const createdAgent = createAgentResultSchema.parse(
      JSON.parse(createToolResult.content[0].text),
    );

    expect(createdAgent).toMatchObject({
      agent: {
        capabilityGrants: [],
        name: "Authenticated work queue",
        revision: 1,
      },
      created: true,
      ok: true,
    });
    if (!createdAgent.ok) {
      throw new Error("Expected authenticated Agent creation to succeed.");
    }
    const getMcpResponse = await callMcp(workerEnv, token.access_token, MCP_GET_AGENT_TOOL_NAME, {
      id: createdAgent.agent.id,
    });
    const getToolResult = toolResultSchema.parse(await getMcpResponse.json()).result;

    expect(getMcpResponse.status).toBe(200);
    expect(getToolResult.isError).toBe(false);
    expect(getAgentResultSchema.parse(JSON.parse(getToolResult.content[0].text))).toEqual({
      agent: createdAgent.agent,
      ok: true,
    });
    const updateMcpResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_UPDATE_AGENT_TOOL_NAME,
      {
        executionLimits: createdAgent.agent.executionLimits,
        expectedRevision: 1,
        id: createdAgent.agent.id,
        idempotencyKey: "oauth-integration-update-agent",
        instructions: "Maintain and coordinate a concise authenticated work queue.",
        model: createdAgent.agent.model,
        name: "Authenticated work coordinator",
      },
    );
    const updateToolResult = toolResultSchema.parse(await updateMcpResponse.json()).result;

    expect(updateToolResult.isError).toBe(false);
    expect(
      updateAgentResultSchema.parse(JSON.parse(updateToolResult.content[0].text)),
    ).toMatchObject({
      agent: {
        id: createdAgent.agent.id,
        name: "Authenticated work coordinator",
        revision: 2,
      },
      ok: true,
      updated: true,
    });
    const revisionsResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
      { id: createdAgent.agent.id },
    );
    const revisionsResult = toolResultSchema.parse(await revisionsResponse.json()).result;
    const revisionsText = revisionsResult.content[0].text;

    expect(revisionsResult.isError).toBe(false);
    expect(listAgentRevisionsResultSchema.parse(JSON.parse(revisionsText))).toMatchObject({
      nextCursor: null,
      ok: true,
      revisions: [
        { name: "Authenticated work coordinator", revision: 2 },
        { name: "Authenticated work queue", revision: 1 },
      ],
    });
    expect(revisionsText).not.toContain(createdAgent.agent.instructions);
    const revisionResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_GET_AGENT_REVISION_TOOL_NAME,
      { id: createdAgent.agent.id, revision: 1 },
    );
    const revisionResult = toolResultSchema.parse(await revisionResponse.json()).result;

    expect(revisionResult.isError).toBe(false);
    expect(getAgentRevisionResultSchema.parse(JSON.parse(revisionResult.content[0].text))).toEqual({
      agent: {
        ...createdAgent.agent,
        revisedAt: createdAgent.agent.createdAt,
      },
      ok: true,
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

  it("keeps a signed read-only token unable to create or persist an Agent", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123457");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, OWNER_READ_SCOPE);

    expect(token.scope).toBe(OWNER_READ_SCOPE);
    expect(consentPage).toContain("View control-plane status and Agent summaries.");
    expect(consentPage).not.toContain("View full Agent definitions, including instructions.");
    expect(consentPage).not.toContain("Update Agent definitions by creating immutable revisions.");
    expect(consentPage).not.toContain(
      "Create Agent definitions with bounded configuration and no capability grants.",
    );
    expect(consentPage).not.toContain(
      "Search the Composio integration catalog and inspect exact tool schemas. Search terms are sent to Composio.",
    );
    expect(consentPage).not.toContain("Create private, short-lived Composio Connect Links.");
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: workerEnv.OWNER_GITHUB_USER_ID,
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const auditCount = () =>
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql.exec("SELECT COUNT(*) AS event_count FROM audit_events").one(),
      );
    const listBeforeResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_LIST_AGENTS_TOOL_NAME,
    );
    const listBeforeResult = toolResultSchema.parse(await listBeforeResponse.json()).result;
    const agentsBefore = listAgentsResultSchema.parse(JSON.parse(listBeforeResult.content[0].text));
    const auditBefore = await auditCount();

    expect(listBeforeResult.isError).toBe(false);
    expect(agentsBefore.ok).toBe(true);
    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        executionLimits: {
          maxDurationSeconds: 180,
          maxModelTokens: 12_000,
          maxToolCalls: 0,
          maxTurns: 3,
        },
        idempotencyKey: "read-only-create-agent",
        instructions: "This signed read-only token must not persist an Agent.",
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
        name: "Denied read-only Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(true);
    expect(createAgentResultSchema.parse(JSON.parse(createResult.content[0].text))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
    const definitionResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_GET_AGENT_TOOL_NAME,
      {
        id: "agent_00000000-0000-4000-8000-000000000000",
      },
    );
    const definitionResult = toolResultSchema.parse(await definitionResponse.json()).result;
    const definitionText = definitionResult.content[0].text;

    expect(definitionResult.isError).toBe(true);
    expect(getAgentResultSchema.parse(JSON.parse(definitionText))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
    expect(definitionText).not.toContain("instructions");
    const listResponse = await callMcp(workerEnv, token.access_token, MCP_LIST_AGENTS_TOOL_NAME);
    const listResult = toolResultSchema.parse(await listResponse.json()).result;

    expect(listResult.isError).toBe(false);
    expect(listAgentsResultSchema.parse(JSON.parse(listResult.content[0].text))).toEqual(
      agentsBefore,
    );
    await expect(auditCount()).resolves.toEqual(auditBefore);
  });

  it("requires explicit Agent-definition read consent before returning instructions", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123460");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, AGENTS_READ_SCOPE);
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: workerEnv.OWNER_GITHUB_USER_ID,
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const created = await controlPlane.createAgent(
      {
        clientId: "test-seed-client",
        ownerKey,
        scopes: [OWNER_WRITE_SCOPE],
      },
      {
        executionLimits: {
          maxDurationSeconds: 180,
          maxModelTokens: 12_000,
          maxToolCalls: 0,
          maxTurns: 3,
        },
        idempotencyKey: "agent-read-scope-seed",
        instructions: "Instruction text requires explicit Agent-definition read consent.",
        model: "anthropic/claude-sonnet-4",
        name: "Definition scope Agent",
      },
    );

    expect(token.scope).toBe(AGENTS_READ_SCOPE);
    expect(consentPage).not.toContain("View control-plane status and Agent summaries.");
    expect(consentPage).toContain("View full Agent definitions, including instructions.");
    expect(consentPage).not.toContain("Update Agent definitions by creating immutable revisions.");
    if (!created.ok) {
      throw new Error("Expected test Agent creation to succeed.");
    }

    const response = await callMcp(workerEnv, token.access_token, MCP_GET_AGENT_TOOL_NAME, {
      id: created.agent.id,
    });
    const toolResult = toolResultSchema.parse(await response.json()).result;

    expect(toolResult.isError).toBe(false);
    expect(getAgentResultSchema.parse(JSON.parse(toolResult.content[0].text))).toEqual({
      agent: created.agent,
      ok: true,
    });
  });

  it("grants Agent revisions without widening creation or read authority", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123461");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, AGENTS_WRITE_SCOPE);
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: workerEnv.OWNER_GITHUB_USER_ID,
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const created = await controlPlane.createAgent(
      {
        clientId: "test-seed-client",
        ownerKey,
        scopes: [OWNER_WRITE_SCOPE],
      },
      {
        executionLimits: {
          maxDurationSeconds: 180,
          maxModelTokens: 12_000,
          maxToolCalls: 0,
          maxTurns: 3,
        },
        idempotencyKey: "agent-update-scope-seed",
        instructions: "Seed an Agent for an update-only OAuth grant.",
        model: "anthropic/claude-sonnet-4",
        name: "Update scope Agent",
      },
    );

    expect(token.scope).toBe(AGENTS_WRITE_SCOPE);
    expect(consentPage).toContain("Update Agent definitions by creating immutable revisions.");
    expect(consentPage).not.toContain("View control-plane status and Agent summaries.");
    expect(consentPage).not.toContain("View full Agent definitions, including instructions.");
    expect(consentPage).not.toContain(
      "Create Agent definitions with bounded configuration and no capability grants.",
    );
    if (!created.ok) {
      throw new Error("Expected test Agent creation to succeed.");
    }

    const updateResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_UPDATE_AGENT_TOOL_NAME,
      {
        executionLimits: created.agent.executionLimits,
        expectedRevision: 1,
        id: created.agent.id,
        idempotencyKey: "agent-update-scope-update",
        instructions: "Update the Agent with an explicit update-only OAuth grant.",
        model: created.agent.model,
        name: "Updated scope Agent",
      },
    );
    const updateResult = toolResultSchema.parse(await updateResponse.json()).result;

    expect(updateResult.isError).toBe(false);
    expect(updateAgentResultSchema.parse(JSON.parse(updateResult.content[0].text))).toMatchObject({
      agent: { id: created.agent.id, name: "Updated scope Agent", revision: 2 },
      ok: true,
      updated: true,
    });
    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        executionLimits: created.agent.executionLimits,
        idempotencyKey: "agent-update-scope-create",
        instructions: "An update-only grant must not create this Agent.",
        model: created.agent.model,
        name: "Denied Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(true);
    expect(createAgentResultSchema.parse(JSON.parse(createResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
    const listResponse = await callMcp(workerEnv, token.access_token, MCP_LIST_AGENTS_TOOL_NAME);
    const listResult = toolResultSchema.parse(await listResponse.json()).result;

    expect(listResult.isError).toBe(true);
    expect(listAgentsResultSchema.parse(JSON.parse(listResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
    const getResponse = await callMcp(workerEnv, token.access_token, MCP_GET_AGENT_TOOL_NAME, {
      id: created.agent.id,
    });
    const getResult = toolResultSchema.parse(await getResponse.json()).result;

    expect(getResult.isError).toBe(true);
    expect(getAgentResultSchema.parse(JSON.parse(getResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
  });

  it("keeps a signed write-only token unable to read owner state", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123458");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, OWNER_WRITE_SCOPE);

    expect(token.scope).toBe(OWNER_WRITE_SCOPE);
    expect(consentPage).not.toContain("View control-plane status and Agent summaries.");
    expect(consentPage).not.toContain("View full Agent definitions, including instructions.");
    expect(consentPage).not.toContain("Update Agent definitions by creating immutable revisions.");
    expect(consentPage).toContain(
      "Create Agent definitions with bounded configuration and no capability grants.",
    );
    expect(consentPage).not.toContain(
      "Search the Composio integration catalog and inspect exact tool schemas. Search terms are sent to Composio.",
    );
    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        executionLimits: {
          maxDurationSeconds: 180,
          maxModelTokens: 12_000,
          maxToolCalls: 0,
          maxTurns: 3,
        },
        idempotencyKey: "write-only-create-agent",
        instructions: "Create through a signed write-only token.",
        model: "@cf/meta/llama-4-scout-17b-16e-instruct",
        name: "Write-only Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(false);
    const createdAgent = createAgentResultSchema.parse(JSON.parse(createResult.content[0].text));

    expect(createdAgent).toMatchObject({
      agent: { name: "Write-only Agent" },
      created: true,
      ok: true,
    });
    if (!createdAgent.ok) {
      throw new Error("Expected write-only Agent creation to succeed.");
    }
    const updateResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_UPDATE_AGENT_TOOL_NAME,
      {
        executionLimits: createdAgent.agent.executionLimits,
        expectedRevision: 1,
        id: createdAgent.agent.id,
        idempotencyKey: "write-only-update-agent",
        instructions: "A legacy creation grant must not update this Agent.",
        model: createdAgent.agent.model,
        name: "Denied update",
      },
    );
    const updateResult = toolResultSchema.parse(await updateResponse.json()).result;

    expect(updateResult.isError).toBe(true);
    expect(updateAgentResultSchema.parse(JSON.parse(updateResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
    const listResponse = await callMcp(workerEnv, token.access_token, MCP_LIST_AGENTS_TOOL_NAME);
    const listResult = toolResultSchema.parse(await listResponse.json()).result;

    expect(listResult.isError).toBe(true);
    expect(listAgentsResultSchema.parse(JSON.parse(listResult.content[0].text))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Agent request denied.",
      },
      ok: false,
    });
    const statusResponse = await callMcp(workerEnv, token.access_token);
    const statusResult = toolResultSchema.parse(await statusResponse.json()).result;

    expect(statusResult.isError).toBe(true);
    expect(controlPlaneStatusResultSchema.parse(JSON.parse(statusResult.content[0].text))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  });

  it("grants Composio catalog search without widening control-plane read", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123459");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, INTEGRATIONS_READ_SCOPE);

    expect(token.scope).toBe(INTEGRATIONS_READ_SCOPE);
    expect(consentPage).not.toContain("View control-plane status and Agent summaries.");
    expect(consentPage).not.toContain("View full Agent definitions, including instructions.");
    expect(consentPage).not.toContain(
      "Create Agent definitions with bounded configuration and no capability grants.",
    );
    expect(consentPage).toContain(
      "Search the Composio integration catalog and inspect exact tool schemas. Search terms are sent to Composio.",
    );

    vi.restoreAllMocks();
    const composioFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
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
    const catalogResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
      { query: "web research" },
    );
    const catalogResult = toolResultSchema.parse(await catalogResponse.json()).result;

    expect(composioFetch).toHaveBeenCalledOnce();
    expect(catalogResult.isError).toBe(false);
    expect(
      integrationCatalogSearchResultSchema.parse(JSON.parse(catalogResult.content[0].text)),
    ).toMatchObject({
      integrations: [{ slug: "firecrawl" }],
      nextCursor: null,
      ok: true,
    });

    const statusResponse = await callMcp(workerEnv, token.access_token);
    const statusResult = toolResultSchema.parse(await statusResponse.json()).result;

    expect(statusResult.isError).toBe(true);
    expect(controlPlaneStatusResultSchema.parse(JSON.parse(statusResult.content[0].text))).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  });

  it("grants private connection-link creation without widening catalog or control reads", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123460");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, CONNECTIONS_WRITE_SCOPE);

    expect(token.scope).toBe(CONNECTIONS_WRITE_SCOPE);
    expect(consentPage).toContain(
      "Create private, short-lived Composio Connect Links. The selected auth configuration and an opaque owner key are sent to Composio; provider credentials stay with Composio.",
    );
    expect(consentPage).not.toContain("View control-plane status and Agent summaries.");
    expect(consentPage).not.toContain(
      "Search the Composio integration catalog and inspect exact tool schemas.",
    );

    vi.restoreAllMocks();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
    const composioFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          connected_account_id: "ca_oauth_connection",
          expires_at: expiresAt,
          experimental: {
            account_type: "PRIVATE",
          },
          link_token: "ln_oauth_connection",
          redirect_url: "https://connect.composio.dev/link/ln_oauth_connection",
        },
        { status: 201 },
      ),
    );
    const connectionResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
      {
        authConfigId: "ac_linear_managed",
        idempotencyKey: "oauth-connection-link",
      },
    );
    const connectionResult = toolResultSchema.parse(await connectionResponse.json()).result;
    const connection = createConnectionLinkResultSchema.parse(
      JSON.parse(connectionResult.content[0].text),
    );

    expect(composioFetch).toHaveBeenCalledOnce();
    expect(connectionResult.isError).toBe(false);
    expect(connection).toMatchObject({
      connectionLink: {
        connectionId: expect.stringMatching(/^connection_/),
        expiresAt,
        url: "https://connect.composio.dev/link/ln_oauth_connection",
      },
      created: true,
      ok: true,
    });
    expect(JSON.stringify(connection)).not.toContain(workerEnv.COMPOSIO_API_KEY);

    const [, providerRequest] = composioFetch.mock.calls[0] ?? [];

    if (typeof providerRequest?.body !== "string") {
      throw new TypeError("Expected a serialized Composio connection-link request.");
    }

    const providerBody = z
      .strictObject({
        auth_config_id: z.literal("ac_linear_managed"),
        callback_url: z.url(),
        experimental: z.strictObject({
          account_type: z.literal("PRIVATE"),
        }),
        user_id: ownerKeySchema,
      })
      .parse(JSON.parse(providerRequest.body));
    const callbackUrl = new URL(providerBody.callback_url);
    const callbackSecrets = callbackUrl.pathname.split("/").slice(-2);

    if (callbackSecrets.length !== 2) {
      throw new TypeError("Expected two callback capability secrets.");
    }

    expect(callbackUrl.origin).toBe(origin);
    expect(callbackUrl.pathname).toMatch(
      /^\/connections\/composio\/callback\/owner_[A-Za-z0-9_-]{43}\/connection_link_[0-9a-f-]{36}\/[1-9][0-9]{12}\/[A-Za-z0-9_-]{43}\/[A-Za-z0-9_-]{43}$/,
    );
    for (const callbackSecret of callbackSecrets) {
      expect(JSON.stringify(connection)).not.toContain(callbackSecret);
    }

    callbackUrl.searchParams.set("status", "success");
    callbackUrl.searchParams.set("connected_account_id", "ca_oauth_connection");
    const callbackResponse = await request(
      workerEnv,
      `${callbackUrl.pathname}${callbackUrl.search}`,
    );
    const callbackBody = await callbackResponse.text();

    expect(callbackResponse.status).toBe(200);
    expect(callbackBody).toContain("Authorization returned to Crewhelm");
    expect(callbackBody).not.toContain("ca_oauth_connection");
    for (const callbackSecret of callbackSecrets) {
      expect(callbackBody).not.toContain(callbackSecret);
    }

    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: workerEnv.OWNER_GITHUB_USER_ID,
    });
    const readAuthority = ownerAuthoritySchema.parse({
      clientId: "oauth-callback-inspection",
      ownerKey,
      scopes: [CONNECTIONS_READ_SCOPE],
    });

    await expect(
      workerEnv.OWNER_CONTROL_PLANE.getByName(ownerKey).listConnections(readAuthority, {}),
    ).resolves.toMatchObject({
      connections: [{ authorizationOutcome: "returned", status: "initiated" }],
      ok: true,
    });

    const catalogResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
      { query: "linear" },
    );
    const catalogResult = toolResultSchema.parse(await catalogResponse.json()).result;
    expect(catalogResult.isError).toBe(true);
    expect(
      integrationCatalogSearchResultSchema.parse(JSON.parse(catalogResult.content[0].text)),
    ).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Integration catalog request denied.",
      },
      ok: false,
    });

    const statusResponse = await callMcp(workerEnv, token.access_token);
    const statusResult = toolResultSchema.parse(await statusResponse.json()).result;
    expect(statusResult.isError).toBe(true);
    expect(
      controlPlaneStatusResultSchema.parse(JSON.parse(statusResult.content[0].text)),
    ).toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });
  });

  it("grants local connection listing without widening connection mutation", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123461");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, CONNECTIONS_READ_SCOPE);

    expect(token.scope).toBe(CONNECTIONS_READ_SCOPE);
    expect(consentPage).toContain(
      "View bounded Crewhelm connection summaries. Provider account identifiers and credentials are not returned.",
    );
    expect(consentPage).not.toContain("Create private, short-lived Composio Connect Links.");

    vi.restoreAllMocks();
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: workerEnv.OWNER_GITHUB_USER_ID,
    });

    await runInDurableObject(
      workerEnv.OWNER_CONTROL_PLANE.getByName(ownerKey),
      (_instance, state) => {
        state.storage.sql.exec(`
          INSERT INTO connections
            (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
          VALUES
            ('connection_00000000-0000-4000-8000-000000000004',
             'composio', 'ca_private_oauth', 'ac_github_managed', 'initiated', 4)
        `);
      },
    );
    const listResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_LIST_CONNECTIONS_TOOL_NAME,
    );
    const listResult = toolResultSchema.parse(await listResponse.json()).result;
    const listText = listResult.content[0].text;

    expect(listResult.isError).toBe(false);
    expect(listConnectionsResultSchema.parse(JSON.parse(listText))).toEqual({
      connections: [
        {
          authorizationOutcome: "untracked",
          authConfigId: "ac_github_managed",
          connectionId: "connection_00000000-0000-4000-8000-000000000004",
          createdAt: "1970-01-01T00:00:00.004Z",
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });
    expect(listText).not.toContain("ca_private_oauth");

    const composioFetch = vi.spyOn(globalThis, "fetch");
    const mutationResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
      {
        authConfigId: "ac_github_managed",
        idempotencyKey: "read-scope-must-not-mutate",
      },
    );
    const mutationResult = toolResultSchema.parse(await mutationResponse.json()).result;

    expect(mutationResult.isError).toBe(true);
    expect(
      createConnectionLinkResultSchema.parse(JSON.parse(mutationResult.content[0].text)),
    ).toEqual({
      error: {
        code: "insufficient_scope",
        message: "Connection link request denied.",
      },
      ok: false,
    });
    expect(composioFetch).not.toHaveBeenCalled();
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

  it("rate-limits authorization returns without using the callback capability as a key", async () => {
    const authorizationToken = "a".repeat(43);
    const limit = vi.fn<RateLimit["limit"]>().mockResolvedValue({ success: false });
    const callbackPath =
      `${CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX}owner_${"b".repeat(43)}/` +
      `connection_link_00000000-0000-4000-8000-000000000000/${authorizationToken}`;
    const response = await request(integrationEnv({ limit }), callbackPath, {
      headers: {
        "cf-connecting-ip": "203.0.113.10",
      },
    });

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({
      key: `${CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX}:203.0.113.10`,
    });
    expect(JSON.stringify(limit.mock.calls)).not.toContain(authorizationToken);
  });
});
