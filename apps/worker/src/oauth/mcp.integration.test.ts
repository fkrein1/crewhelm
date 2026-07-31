import { createExecutionContext, env } from "cloudflare:test";
import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  RUNS_WRITE_SCOPE,
  createAgentResultSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsResultSchema,
  ownerAuthoritySchema,
  ownerKeySchema,
  updateAgentResultSchema,
} from "@crewhelm/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX } from "../owner/connections/index.js";
import type { WorkerEnv } from "../env.js";
import { handleWorkerRequest } from "../http/server.js";
import {
  MCP_CREATE_AGENT_TOOL_NAME,
  MCP_GET_AGENT_TOOL_NAME,
  MCP_GET_AGENT_REVISION_TOOL_NAME,
  MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
  MCP_STATUS_TOOL_NAME,
  MCP_UPDATE_AGENT_TOOL_NAME,
} from "../mcp/server.js";
import { mcpControlPlaneStatusResultSchema } from "../mcp/guidance.js";
import { deriveOwnerKey } from "../owner/identity.js";
import { CONTROL_PLANE_SCHEMA_VERSION } from "../owner/migrations.js";
import { digestRunPrompt } from "../agent/admitted-runs/index.js";
import {
  createCrewhelmAuth,
  exchangeGithubAuthorizationCode,
  verifyMcpAccessToken,
} from "./auth.js";
import { FULL_ACCESS_SCOPE, USE_ACCESS_SCOPE, VIEW_ACCESS_SCOPE } from "./access-levels.js";
import {
  LEGACY_OAUTH_SCOPES,
  OAUTH_DEFAULT_SCOPE_CLAIM,
  OFFLINE_ACCESS_SCOPE,
  oauthScopeClaimSchema,
} from "./scopes.js";
import { readAuthTestMigrations, registerAuthTestDatabase } from "./testkit.js";

const origin = "https://crewhelm.test";
const redirectUri = "https://client.example/oauth/callback";
const ownerGithubUserId = "123456";
const githubToken = "transient-github-token-must-not-be-stored";
const reversedAccessLevelClaim = `${OFFLINE_ACCESS_SCOPE} ${FULL_ACCESS_SCOPE}`;
const registrationSchema = z.looseObject({
  client_id: z.string().min(1),
  token_endpoint_auth_method: z.literal("none"),
});
const tokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.literal(15 * 60),
  scope: oauthScopeClaimSchema,
  token_type: z.literal("Bearer"),
});
const refreshableTokenSchema = tokenSchema.extend({
  refresh_token: z.string().min(1),
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
    AI_GATEWAY_ID: "crewhelm-test",
    AUTH_DB: env.AUTH_DB,
    AUTH_RATE_LIMIT: rateLimit,
    BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
    COMPOSIO_API_KEY: "test-composio-api-key",
    CREW_AGENT: env.CREW_AGENT,
    CREW_SESSION: env.CREW_SESSION,
    CREWHELM_DEPLOYMENT_FINGERPRINT:
      "0000000000000000000000000000000000000000000000000000000000000000",
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    MCP_RATE_LIMIT: rateLimit,
    OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
    OWNER_GITHUB_USER_ID: configuredOwnerGithubUserId,
    PUBLIC_ORIGIN: origin,
    SKILL_PACKAGES: env.SKILL_PACKAGES,
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

function decodeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function htmlAttribute(body: string, name: string): string {
  const match = body.match(new RegExp(`name="${name}" value="([^"]+)"`));

  if (match?.[1] === undefined) {
    throw new Error(`Expected ${name} form value.`);
  }

  return decodeHtmlAttribute(match[1]);
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
  existingClientId?: string,
): Promise<{
  consentPage: string;
  token: z.infer<typeof tokenSchema>;
}> {
  const cookies = new CookieJar();
  const clientId =
    existingClientId ??
    registrationSchema.parse(
      await (
        await request(workerEnv, "/api/auth/oauth2/register", {
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
        })
      ).json(),
    ).client_id;
  const verifier = "crewhelm-scoped-verifier-0123456789abcdef0123456789";
  const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);

  authorize.searchParams.set("client_id", clientId);
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
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookies.header(),
      origin,
    },
    method: "POST",
  });
  const consentNavigation = z
    .strictObject({ redirectUrl: z.url() })
    .parse(await consentResponse.json());
  const authorizationCode = new URL(consentNavigation.redirectUrl).searchParams.get("code");
  const tokenResponse = await request(workerEnv, "/api/auth/oauth2/token", {
    body: new URLSearchParams({
      client_id: clientId,
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
        scope: reversedAccessLevelClaim,
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
    authorize.searchParams.append("resource", `${origin}/mcp`);
    authorize.searchParams.append("resource", `${origin}/mcp`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", reversedAccessLevelClaim);
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
    expect(loginPageResponse.headers.get("content-security-policy")).toContain(
      "connect-src 'self'",
    );
    expect(loginPageResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(loginPageResponse.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(loginPage).toContain('href="/oauth/styles.css"');
    expect(loginPage).toContain('<script src="/oauth/actions.js" defer></script>');
    expect(loginPage).toContain('href="/oauth/login/continue?');
    expect(loginPage).toContain('data-navigation-start data-pending-label="Opening GitHub…"');
    const stylesheetResponse = await request(workerEnv, "/oauth/styles.css");
    const stylesheet = await stylesheetResponse.text();

    expect(stylesheetResponse.status).toBe(200);
    expect(stylesheetResponse.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(stylesheet).toContain(".ch-button--primary");
    expect(stylesheet).toContain('.ch-button[aria-disabled="true"]');
    expect(stylesheet).toContain("@media (prefers-color-scheme: dark)");
    expect(loginPage).toContain('class="ch-brand" role="img" aria-label="Crewhelm"');
    expect(loginPage).toContain('data-tone="accent"');
    const continueResponse = await request(workerEnv, `/oauth/login/continue?${loginQuery}`);
    const continueLocation = new URL(responseLocation(continueResponse), origin);

    expect(continueResponse.status).toBe(302);
    expect(continueLocation.origin).toBe("https://github.com");
    const crossSiteLoginResponse = await request(workerEnv, "/oauth/login", {
      body: new URLSearchParams({ oauth_query: loginQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://attacker.example",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
    });
    const ambiguousLoginResponse = await request(workerEnv, "/oauth/login", {
      body: new URLSearchParams({ oauth_query: loginQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-mode": "navigate",
      },
      method: "POST",
    });
    const loginResponse = await request(workerEnv, "/oauth/login", {
      body: new URLSearchParams({ oauth_query: loginQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    cookies.capture(loginResponse);
    const githubLocation = new URL(responseLocation(loginResponse), origin);
    const githubState = githubLocation.searchParams.get("state");

    expect(crossSiteLoginResponse.status).toBe(400);
    expect(ambiguousLoginResponse.status).toBe(400);
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
    expect(consentPageResponse.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://client.example",
    );
    expect(consentPageResponse.headers.get("content-security-policy")).not.toContain(
      "attacker.example",
    );
    expect(consentPage).toContain('<script src="/oauth/actions.js" defer></script>');
    expect(consentPage.match(/data-consent-form/g)).toHaveLength(2);
    expect(consentPage).toContain('<input type="hidden" name="decision" value="approve">');
    expect(consentPage).toContain('<input type="hidden" name="decision" value="deny">');
    expect(consentPage).toContain(
      '<button class="ch-button ch-button--primary" type="submit" data-pending-label="Granting access…">Grant access</button>',
    );
    expect(consentPage).toContain(
      '<button class="ch-button ch-button--quiet" type="submit" data-pending-label="Denying…">Deny</button>',
    );
    expect(consentPage).toContain('data-tone="warning"');
    expect(consentPage).not.toContain("Continue to client");
    expect(consentPage).not.toContain("data-navigation-link");
    expect(consentPage).toContain("&lt;script&gt;Integration MCP client&lt;/script&gt;");
    expect(consentPage).not.toContain("<script>Integration MCP client</script>");
    expect(consentPage).toContain("<strong>Full control:</strong>");
    expect(consentPage).toContain(
      "Keep this MCP client signed in using a rotating, revocable refresh token.",
    );
    const actionsScriptResponse = await request(workerEnv, "/oauth/actions.js");

    expect(actionsScriptResponse.status).toBe(200);
    expect(actionsScriptResponse.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    const actionsScript = await actionsScriptResponse.text();
    const completionPageResponse = await request(workerEnv, "/oauth/complete");
    const completionPage = await completionPageResponse.text();

    expect(actionsScript).toContain('consentForm.addEventListener("submit", () => {');
    expect(actionsScript).toContain('link.setAttribute("aria-disabled", "true")');
    expect(actionsScript).toContain('submittingButton.setAttribute("aria-busy", "true")');
    expect(actionsScript).not.toContain("event.submitter");
    expect(actionsScript).not.toContain("fetch(consentForm.action");
    expect(actionsScript).not.toContain("new FormData(consentForm)");
    expect(actionsScript).not.toContain("window.location.assign(result.redirectUrl)");
    expect(completionPageResponse.status).toBe(200);
    expect(completionPage).toContain("Authorization returned to your client.");
    expect(completionPage).toContain("Crewhelm completed this handoff.");
    const speculativeGetResponse = await request(workerEnv, "/oauth/consent/decision");
    const unauthenticatedApproveResponse = await request(workerEnv, "/oauth/consent", {
      body: new URLSearchParams({ decision: "approve", oauth_query: consentQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin,
      },
      method: "POST",
    });
    const crossSiteNullOriginResponse = await request(workerEnv, "/oauth/consent", {
      body: new URLSearchParams({ decision: "approve", oauth_query: consentQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies.header(),
        origin: "null",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
      },
      method: "POST",
    });
    const consentResponse = await request(workerEnv, "/oauth/consent", {
      body: new URLSearchParams({ decision: "approve", oauth_query: consentQuery }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookies.header(),
        origin: "null",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
      method: "POST",
    });
    const clientLocation = new URL(responseLocation(consentResponse), origin);
    const authorizationCode = clientLocation.searchParams.get("code");

    expect(speculativeGetResponse.status).toBe(404);
    expect(unauthenticatedApproveResponse.status).toBe(401);
    expect(crossSiteNullOriginResponse.status).toBe(400);
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
    expect(token.scope).toBe(OAUTH_DEFAULT_SCOPE_CLAIM);
    const refreshableToken = refreshableTokenSchema.parse(rawToken);
    const refreshedResponse = await request(workerEnv, "/api/auth/oauth2/token", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshableToken.refresh_token,
        resource: `${origin}/mcp`,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const refreshedToken = refreshableTokenSchema.parse(await refreshedResponse.json());

    expect(refreshedResponse.status).toBe(200);
    expect(refreshedToken.scope).toBe(OAUTH_DEFAULT_SCOPE_CLAIM);
    expect(refreshedToken.refresh_token).not.toBe(refreshableToken.refresh_token);
    expect((await callMcp(workerEnv, refreshedToken.access_token)).status).toBe(200);
    const replayResponse = await request(workerEnv, "/api/auth/oauth2/token", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshableToken.refresh_token,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });

    expect(replayResponse.status).toBe(400);
    await expect(replayResponse.json()).resolves.toMatchObject({
      error: "invalid_grant",
      error_description: "OAuth request denied.",
    });
    expect(JSON.stringify(rawToken)).not.toContain(workerEnv.BETTER_AUTH_SECRET);
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
    expect(
      mcpControlPlaneStatusResultSchema.parse(JSON.parse(toolResult.content[0].text)),
    ).toMatchObject({
      ok: true,
      status: {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
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
        capabilities: createdAgent.agent.capabilities,
        executionLimits: createdAgent.agent.executionLimits,
        expectedRevision: 1,
        id: createdAgent.agent.id,
        idempotencyKey: "oauth-integration-update-agent",
        instructions: "Maintain and coordinate a concise authenticated work queue.",
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

  it("keeps a pre-upgrade client and rotating refresh token usable", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123460");
    const registrationResponse = await request(workerEnv, "/api/auth/oauth2/register", {
      body: JSON.stringify({
        client_name: "Pre-upgrade MCP client",
        grant_types: ["authorization_code", "refresh_token"],
        redirect_uris: [redirectUri],
        require_pkce: true,
        response_types: ["code"],
        scope: OAUTH_DEFAULT_SCOPE_CLAIM,
        token_endpoint_auth_method: "none",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const registration = registrationSchema.parse(await registrationResponse.json());
    const legacyScopes = [...LEGACY_OAUTH_SCOPES, OFFLINE_ACCESS_SCOPE];
    const legacyScopeClaim = legacyScopes.join(" ");
    const storedLegacyScopes = JSON.stringify(JSON.stringify(legacyScopes));

    await workerEnv.AUTH_DB.prepare(`UPDATE "oauthClient" SET "scopes" = ? WHERE "clientId" = ?`)
      .bind(storedLegacyScopes, registration.client_id)
      .run();
    await workerEnv.AUTH_DB.prepare(
      `UPDATE "oauthResource" SET "allowedScopes" = ? WHERE "identifier" = ?`,
    )
      .bind(storedLegacyScopes, `${origin}/mcp`)
      .run();

    const { consentPage, token } = await completeOAuthFlow(
      workerEnv,
      legacyScopeClaim,
      registration.client_id,
    );
    const refreshableToken = refreshableTokenSchema.parse(token);

    expect(consentPage).toContain("Existing client access");
    expect(token.scope).toBe(legacyScopeClaim);
    expect((await callMcp(workerEnv, token.access_token)).status).toBe(200);

    const migration = readAuthTestMigrations().find(
      (candidate) => candidate.name === "0012_access_levels.sql",
    );

    if (migration === undefined) {
      throw new Error("Expected access-level migration.");
    }

    for (const query of migration.queries) {
      await workerEnv.AUTH_DB.prepare(query).run();
    }

    const refreshedResponse = await request(workerEnv, "/api/auth/oauth2/token", {
      body: new URLSearchParams({
        client_id: registration.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshableToken.refresh_token,
        resource: `${origin}/mcp`,
      }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    const refreshedToken = refreshableTokenSchema.parse(await refreshedResponse.json());

    expect(refreshedResponse.status).toBe(200);
    expect(refreshedToken.scope).toBe(legacyScopeClaim);
    expect(refreshedToken.refresh_token).not.toBe(refreshableToken.refresh_token);
    expect((await callMcp(workerEnv, token.access_token)).status).toBe(200);
    expect((await callMcp(workerEnv, refreshedToken.access_token)).status).toBe(200);
  });

  it("maps View only to read capabilities without mutation access", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123457");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, VIEW_ACCESS_SCOPE);
    const claims = await verifyMcpAccessToken(
      workerEnv,
      createCrewhelmAuth(workerEnv, origin),
      origin,
      token.access_token,
    );

    expect(token.scope).toBe(VIEW_ACCESS_SCOPE);
    expect(consentPage).toContain("<strong>View only:</strong>");
    expect(consentPage).not.toContain("<strong>Use agents:</strong>");
    expect(consentPage).not.toContain("<strong>Full control:</strong>");
    expect(claims?.scope).toBe(
      [
        OWNER_READ_SCOPE,
        AGENTS_READ_SCOPE,
        CONNECTIONS_READ_SCOPE,
        CONNECTION_CONFIGS_READ_SCOPE,
        INTEGRATIONS_READ_SCOPE,
      ].join(" "),
    );

    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        idempotencyKey: "view-only-create-agent",
        instructions: "This Agent must not be created.",
        name: "Denied Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(true);
    expect(createAgentResultSchema.parse(JSON.parse(createResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
  });

  it("maps Use agents to run operations without configuration access", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123458");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, USE_ACCESS_SCOPE);
    const claims = await verifyMcpAccessToken(
      workerEnv,
      createCrewhelmAuth(workerEnv, origin),
      origin,
      token.access_token,
    );

    expect(token.scope).toBe(USE_ACCESS_SCOPE);
    expect(consentPage).toContain("<strong>Use agents:</strong>");
    expect(consentPage).not.toContain("<strong>Full control:</strong>");
    expect(claims?.scope).toBe(
      [
        OWNER_READ_SCOPE,
        AGENTS_READ_SCOPE,
        RUNS_WRITE_SCOPE,
        CONNECTIONS_READ_SCOPE,
        CONNECTION_CONFIGS_READ_SCOPE,
        INTEGRATIONS_READ_SCOPE,
      ].join(" "),
    );
    if (claims === null) {
      throw new Error("Expected verified Use agents claims.");
    }
    const controlPlane = workerEnv.OWNER_CONTROL_PLANE.getByName(claims.sub);
    const seeded = await controlPlane.createAgent(
      {
        clientId: "test-seed-client",
        ownerKey: claims.sub,
        scopes: [OWNER_WRITE_SCOPE],
      },
      {
        idempotencyKey: "use-agents-seed",
        instructions: "Run only when admitted through Use agents.",
        name: "Use agents seed",
      },
    );

    if (!seeded.ok) {
      throw new Error("Expected Use agents fixture.");
    }

    const prompt = "Prove that Use agents can admit a bounded run.";
    const admission = await controlPlane.createRunAdmission(
      ownerAuthoritySchema.parse({
        clientId: claims.azp,
        ownerKey: claims.sub,
        scopes: claims.scope.split(" "),
      }),
      {
        agentId: seeded.agent.id,
        expectedRevision: seeded.agent.revision,
        idempotencyKey: "use-agents-admission",
        promptCharacters: prompt.length,
        promptDigest: await digestRunPrompt(prompt),
      },
    );

    expect(admission).toMatchObject({ created: true, ok: true, state: "issued" });

    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        idempotencyKey: "use-agents-create-agent",
        instructions: "Use agents must not create definitions.",
        name: "Denied Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(true);
    expect(createAgentResultSchema.parse(JSON.parse(createResult.content[0].text))).toEqual({
      error: { code: "insufficient_scope", message: "Agent request denied." },
      ok: false,
    });
  }, 90_000);

  it("maps Full control to every owner capability", async () => {
    const workerEnv = integrationEnv(allowRateLimit(), "123459");
    const { consentPage, token } = await completeOAuthFlow(workerEnv, FULL_ACCESS_SCOPE);
    const claims = await verifyMcpAccessToken(
      workerEnv,
      createCrewhelmAuth(workerEnv, origin),
      origin,
      token.access_token,
    );

    expect(token.scope).toBe(FULL_ACCESS_SCOPE);
    expect(consentPage).toContain("<strong>Full control:</strong>");
    expect(claims?.scope).toBe(
      [
        OWNER_READ_SCOPE,
        OWNER_WRITE_SCOPE,
        AGENTS_READ_SCOPE,
        AGENTS_WRITE_SCOPE,
        RUNS_WRITE_SCOPE,
        AUTONOMY_WRITE_SCOPE,
        CONNECTIONS_READ_SCOPE,
        CONNECTIONS_WRITE_SCOPE,
        CONNECTION_CONFIGS_READ_SCOPE,
        CONNECTION_CONFIGS_WRITE_SCOPE,
        INTEGRATIONS_READ_SCOPE,
      ].join(" "),
    );

    const createResponse = await callMcp(
      workerEnv,
      token.access_token,
      MCP_CREATE_AGENT_TOOL_NAME,
      {
        idempotencyKey: "full-control-create-agent",
        instructions: "Full control may create Agent definitions.",
        name: "Full control Agent",
      },
    );
    const createResult = toolResultSchema.parse(await createResponse.json()).result;

    expect(createResult.isError).toBe(false);
    expect(createAgentResultSchema.parse(JSON.parse(createResult.content[0].text))).toMatchObject({
      agent: { name: "Full control Agent" },
      created: true,
      ok: true,
    });
  }, 90_000);

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
        scope: VIEW_ACCESS_SCOPE,
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
    authorize.searchParams.set("scope", VIEW_ACCESS_SCOPE);
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
