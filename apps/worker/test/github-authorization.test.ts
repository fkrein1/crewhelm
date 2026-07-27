import { env } from "cloudflare:test";
import { OWNER_READ_SCOPE, ownerAuthoritySchema } from "@crewhelm/contracts";
import type { AuthRequest, CompleteAuthorizationOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import type { OAuthAuthorizationApi, WorkerEnv } from "../src/env.js";
import { createWorker } from "../src/index.js";

const origin = "https://crewhelm.test";
const githubUserId = "123456";
const githubToken = "github-token-must-not-be-stored";
const oauthRequest: AuthRequest = {
  clientId: "test-client",
  codeChallenge: "A".repeat(43),
  codeChallengeMethod: "S256",
  redirectUri: "https://client.example/oauth/callback",
  resource: `${origin}/mcp`,
  responseType: "code",
  scope: [OWNER_READ_SCOPE],
  state: "client-state",
};
const authorizationPropsSchema = z.strictObject({
  authority: ownerAuthoritySchema,
});

function createOAuthHelpers(overrides?: Partial<OAuthAuthorizationApi>): OAuthAuthorizationApi {
  return {
    completeAuthorization: vi.fn<OAuthAuthorizationApi["completeAuthorization"]>(async () => ({
      redirectTo: "https://client.example/oauth/callback?code=crewhelm-code",
    })),
    lookupClient: vi.fn<OAuthAuthorizationApi["lookupClient"]>(async () => ({
      clientId: oauthRequest.clientId,
      clientName: "<script>untrusted client</script>",
      redirectUris: [oauthRequest.redirectUri],
      tokenEndpointAuthMethod: "none",
    })),
    parseAuthRequest: vi.fn<OAuthAuthorizationApi["parseAuthRequest"]>(async () => oauthRequest),
    ...overrides,
  };
}

function bindings(oauthHelpers: OAuthAuthorizationApi, ownerId = githubUserId): WorkerEnv {
  return {
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
    AUTH_RATE_LIMIT: env.AUTH_RATE_LIMIT,
    MCP_RATE_LIMIT: env.MCP_RATE_LIMIT,
    OAUTH_KV: env.OAUTH_KV,
    OAUTH_PROVIDER: oauthHelpers,
    OWNER_CONTROL_PLANE: env.OWNER_CONTROL_PLANE,
    OWNER_GITHUB_USER_ID: ownerId,
  };
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

async function beginGithubAuthorization(
  oauthHelpers: OAuthAuthorizationApi,
  ownerId = githubUserId,
): Promise<{ githubState: string; workerEnv: WorkerEnv }> {
  const app = createWorker();
  const workerEnv = bindings(oauthHelpers, ownerId);
  const consentResponse = await app.fetch(new Request(`${origin}/authorize`), workerEnv);
  const consent = hiddenConsent(await consentResponse.text());
  const consentCookie = cookieValue(consentResponse, "__Host-crewhelm-consent");
  const body = new URLSearchParams({
    consent,
    decision: "approve",
  });
  const authorizeResponse = await app.fetch(
    new Request(`${origin}/authorize`, {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `__Host-crewhelm-consent=${consentCookie}`,
      },
      method: "POST",
    }),
    workerEnv,
  );
  const location = authorizeResponse.headers.get("location");

  expect(authorizeResponse.status).toBe(302);
  expect(location).not.toBeNull();
  expect(location).not.toContain("github-client-secret");
  const githubState = new URL(location ?? origin).searchParams.get("state");

  if (githubState === null) {
    throw new Error("Expected GitHub state.");
  }

  return { githubState, workerEnv };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub owner authorization", () => {
  it("renders escaped, framed-off, explicit consent for the exact read scope", async () => {
    const app = createWorker();
    const response = await app.fetch(
      new Request(`${origin}/authorize`),
      bindings(createOAuthHelpers()),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("set-cookie")).toContain("__Host-crewhelm-consent=");
    expect(body).toContain("&lt;script&gt;untrusted client&lt;/script&gt;");
    expect(body).not.toContain("<script>");
    expect(body).toContain("read-only access");
  });

  it("rejects OAuth requests that are not S256 and exactly control:read", async () => {
    const app = createWorker();
    const oauthHelpers = createOAuthHelpers({
      parseAuthRequest: vi.fn<OAuthAuthorizationApi["parseAuthRequest"]>(async () => ({
        ...oauthRequest,
        codeChallengeMethod: "plain",
        scope: ["control:write"],
      })),
    });
    const response = await app.fetch(
      new Request(`${origin}/authorize?secret=do-not-reflect`),
      bindings(oauthHelpers),
    );
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toBe("Authorization request denied.\n");
    expect(body).not.toContain("control:write");
    expect(body).not.toContain("do-not-reflect");
  });

  it.each([
    ["missing", undefined],
    ["wrong", "https://other.example/mcp"],
  ])("rejects an OAuth request with a %s MCP resource", async (_label, resource) => {
    const app = createWorker();
    const invalidRequest: AuthRequest = {
      ...oauthRequest,
      ...(resource === undefined ? {} : { resource }),
    };

    if (resource === undefined) {
      delete invalidRequest.resource;
    }

    const oauthHelpers = createOAuthHelpers({
      parseAuthRequest: vi.fn<OAuthAuthorizationApi["parseAuthRequest"]>(
        async () => invalidRequest,
      ),
    });
    const response = await app.fetch(new Request(`${origin}/authorize`), bindings(oauthHelpers));

    expect(response.status).toBe(400);
  });

  it("binds consent to its secure cookie", async () => {
    const app = createWorker();
    const workerEnv = bindings(createOAuthHelpers());
    const consentResponse = await app.fetch(new Request(`${origin}/authorize`), workerEnv);
    const consent = hiddenConsent(await consentResponse.text());
    const response = await app.fetch(
      new Request(`${origin}/authorize`, {
        body: new URLSearchParams({
          consent,
          decision: "approve",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `__Host-crewhelm-consent=${"B".repeat(43)}`,
        },
        method: "POST",
      }),
      workerEnv,
    );

    expect(response.status).toBe(400);
  });

  it("derives owner authority after GitHub verifies the configured numeric user", async () => {
    let completion: CompleteAuthorizationOptions | undefined;
    const oauthHelpers = createOAuthHelpers({
      completeAuthorization: vi.fn<OAuthAuthorizationApi["completeAuthorization"]>(
        async (options) => {
          completion = options;
          return {
            redirectTo: "https://client.example/oauth/callback?code=crewhelm-code",
          };
        },
      ),
    });
    const { githubState, workerEnv } = await beginGithubAuthorization(oauthHelpers);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({
          access_token: githubToken,
          scope: "",
          token_type: "bearer",
        });
      }

      if (url === "https://api.github.com/user") {
        return Response.json({ id: Number(githubUserId) });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });
    const response = await createWorker().fetch(
      new Request(`${origin}/oauth/github/callback?code=github-code&state=${githubState}`, {
        headers: {
          cookie: `__Host-crewhelm-github-state=${githubState}`,
        },
      }),
      workerEnv,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://client.example/oauth/callback?code=crewhelm-code",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    if (completion === undefined) {
      throw new Error("Expected OAuth authorization completion.");
    }
    expect(completion.userId).toMatch(/^owner_[A-Za-z0-9_-]{43}$/);
    expect(completion.scope).toEqual([OWNER_READ_SCOPE]);
    expect(authorizationPropsSchema.parse(completion.props).authority).toEqual({
      clientId: oauthRequest.clientId,
      ownerKey: completion.userId,
      scopes: [OWNER_READ_SCOPE],
    });
    expect(JSON.stringify(completion)).not.toContain(githubToken);
    expect(JSON.stringify(completion)).not.toContain("github-client-secret");
  });

  it("logs only a fixed stage when authorization grant storage fails", async () => {
    const internalFailure = "oauth-provider-secret-that-must-not-appear";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const oauthHelpers = createOAuthHelpers({
      completeAuthorization: vi.fn<OAuthAuthorizationApi["completeAuthorization"]>(async () => {
        throw new Error(internalFailure);
      }),
    });
    const { githubState, workerEnv } = await beginGithubAuthorization(oauthHelpers);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      return url === "https://github.com/login/oauth/access_token"
        ? Response.json({
            access_token: githubToken,
            scope: "",
            token_type: "bearer",
          })
        : Response.json({ id: Number(githubUserId) });
    });
    const response = await createWorker().fetch(
      new Request(`${origin}/oauth/github/callback?code=github-code&state=${githubState}`, {
        headers: {
          cookie: `__Host-crewhelm-github-state=${githubState}`,
        },
      }),
      workerEnv,
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toBe("Authorization is temporarily unavailable.\n");
    expect(consoleError.mock.calls).toEqual([
      ["crewhelm.authorization_unavailable", { stage: "callback_grant_write" }],
    ]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(internalFailure);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(githubToken);
  });

  it("fails closed when GitHub authenticates a different account", async () => {
    const completeAuthorization = vi.fn<OAuthAuthorizationApi["completeAuthorization"]>();
    const oauthHelpers = createOAuthHelpers({ completeAuthorization });
    const { githubState, workerEnv } = await beginGithubAuthorization(oauthHelpers, "999999");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      return url === "https://github.com/login/oauth/access_token"
        ? Response.json({
            access_token: githubToken,
            scope: "",
            token_type: "bearer",
          })
        : Response.json({ id: Number(githubUserId) });
    });
    const response = await createWorker().fetch(
      new Request(`${origin}/oauth/github/callback?code=github-code&state=${githubState}`, {
        headers: {
          cookie: `__Host-crewhelm-github-state=${githubState}`,
        },
      }),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a GitHub token carrying permissions Crewhelm did not request", async () => {
    const completeAuthorization = vi.fn<OAuthAuthorizationApi["completeAuthorization"]>();
    const oauthHelpers = createOAuthHelpers({ completeAuthorization });
    const { githubState, workerEnv } = await beginGithubAuthorization(oauthHelpers);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: githubToken,
        scope: "repo",
        token_type: "bearer",
      }),
    );
    const response = await createWorker().fetch(
      new Request(`${origin}/oauth/github/callback?code=github-code&state=${githubState}`, {
        headers: {
          cookie: `__Host-crewhelm-github-state=${githubState}`,
        },
      }),
      workerEnv,
    );

    expect(response.status).toBe(403);
    expect(completeAuthorization).not.toHaveBeenCalled();
  });
});
