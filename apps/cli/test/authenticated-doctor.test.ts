import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  authenticatedDoctorReportSchema,
  diagnoseAuthenticatedDeployment,
} from "../src/authenticated-doctor.js";
import { parseDeploymentOrigin } from "../src/doctor.js";

const origin = "https://crewhelm.example";
const clientId = "doctor-client";
const authorizationCode = "temporary-authorization-code";
const accessToken = "temporary-view-token";
const mcpRequestSchema = z.looseObject({
  id: z.number(),
  method: z.string(),
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }

  return new URL(typeof input === "string" ? input : input.url);
}

function publicPayload(path: string): unknown {
  if (path === "/health") {
    return { service: "crewhelm", status: "ok" };
  }

  if (path === "/.well-known/oauth-protected-resource") {
    return {
      authorization_servers: [`${origin}/api/auth`],
      bearer_methods_supported: ["header"],
      resource: `${origin}/mcp`,
      scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    };
  }

  return {
    authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer: `${origin}/api/auth`,
    jwks_uri: `${origin}/api/auth/jwks`,
    registration_endpoint: `${origin}/api/auth/oauth2/register`,
    response_modes_supported: ["query"],
    response_types_supported: ["code"],
    revocation_endpoint: `${origin}/api/auth/oauth2/revoke`,
    scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
    token_endpoint: `${origin}/api/auth/oauth2/token`,
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function fleetStatus() {
  return {
    ok: true,
    status: {
      capacity: {
        maxAgents: 100,
        maxConcurrentRuns: 25,
        maxConnections: 100,
        retention: {
          inboxSeconds: 2_592_000,
          runSeconds: 86_400,
        },
      },
      configurationRevision: 1,
      schemaVersion: 15,
      status: "ready",
      usage: {
        agents: { active: 2, total: 3 },
        connections: { active: 1, pending: 0, total: 1 },
        diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
        inbox: {
          actionRequired: 0,
          attention: {
            needsAction: 0,
            oldestNeedsActionAt: null,
            warnings: 0,
          },
          deferred: 0,
          exceptions: 0,
          outcomes: 2,
          total: 2,
        },
        runs: { active: 1 },
      },
    },
  };
}

interface FetchHarness {
  fetch: typeof globalThis.fetch;
  requests: Array<{ body: string; headers: Headers; method: string; url: URL }>;
}

function authenticatedFetch(
  options: {
    omitStatusTool?: boolean;
    revokeStatus?: number;
    revokeWithoutEffect?: boolean;
  } = {},
): FetchHarness {
  const requests: FetchHarness["requests"] = [];
  const revokedTokens = new Set<string>();
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "";

    requests.push({ body, headers, method, url });

    if (
      url.pathname === "/health" ||
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-authorization-server/api/auth"
    ) {
      return jsonResponse(publicPayload(url.pathname));
    }

    if (url.pathname === "/api/auth/oauth2/register") {
      return jsonResponse(
        {
          client_id: clientId,
          token_endpoint_auth_method: "none",
        },
        201,
      );
    }

    if (url.pathname === "/api/auth/oauth2/token") {
      return jsonResponse({
        access_token: accessToken,
        expires_in: 900,
        scope: "crewhelm:view",
        token_type: "Bearer",
      });
    }

    if (url.pathname === "/api/auth/oauth2/revoke") {
      const status = options.revokeStatus ?? 200;

      if (status >= 200 && status < 300 && !options.revokeWithoutEffect) {
        const token = new URLSearchParams(body).get("token");

        if (token) {
          revokedTokens.add(token);
        }
      }

      return new Response(null, { status });
    }

    if (url.pathname === "/mcp") {
      const bearer = headers.get("authorization")?.replace(/^Bearer /u, "");

      if (bearer && revokedTokens.has(bearer)) {
        return jsonResponse(
          {
            error: {
              code: "invalid_token",
              message: "MCP request denied.",
            },
          },
          401,
        );
      }

      const request = mcpRequestSchema.parse(JSON.parse(body));

      if (request.method === "initialize") {
        return jsonResponse({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-11-25",
            serverInfo: { name: "crewhelm", version: "0.1.0" },
          },
        });
      }

      if (request.method === "tools/list") {
        return jsonResponse({
          id: request.id,
          jsonrpc: "2.0",
          result: {
            tools: options.omitStatusTool
              ? []
              : [
                  {
                    annotations: {
                      destructiveHint: false,
                      idempotentHint: true,
                      openWorldHint: false,
                      readOnlyHint: true,
                    },
                    inputSchema: {
                      additionalProperties: false,
                      properties: {},
                      type: "object",
                    },
                    name: "crewhelm_status",
                  },
                ],
          },
        });
      }

      return jsonResponse({
        id: request.id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(fleetStatus()), type: "text" }],
          isError: false,
        },
      });
    }

    throw new Error(`Unexpected request path: ${url.pathname}`);
  });

  return { fetch, requests };
}

function approveAuthorization(openedUrls: URL[]): (url: URL) => Promise<void> {
  return async (url) => {
    openedUrls.push(url);
    const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

    callback.searchParams.set("code", authorizationCode);
    callback.searchParams.set("iss", `${origin}/api/auth`);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    const response = await globalThis.fetch(callback);

    expect(response.status).toBe(200);
  };
}

describe("authenticated deployment diagnosis", () => {
  it("uses exact view-only PKCE access, validates MCP status, and revokes the token", async () => {
    const harness = authenticatedFetch();
    const openedUrls: URL[] = [];
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: approveAuthorization(openedUrls),
      },
    );

    expect(authenticatedDoctorReportSchema.parse(report)).toEqual(report);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);

    const registrationRequest = harness.requests.find(
      (request) => request.url.pathname === "/api/auth/oauth2/register",
    );
    expect(JSON.parse(registrationRequest?.body ?? "")).toEqual({
      application_type: "native",
      client_name: "Crewhelm authenticated doctor",
      grant_types: ["authorization_code"],
      redirect_uris: [openedUrls[0]?.searchParams.get("redirect_uri")],
      require_pkce: true,
      resources: [`${origin}/mcp`],
      response_types: ["code"],
      scope: "crewhelm:view",
      token_endpoint_auth_method: "none",
    });

    const authorizeUrl = openedUrls[0];
    expect(authorizeUrl?.origin).toBe(origin);
    expect(authorizeUrl?.pathname).toBe("/api/auth/oauth2/authorize");
    expect(authorizeUrl?.searchParams.get("scope")).toBe("crewhelm:view");
    expect(authorizeUrl?.searchParams.get("resource")).toBe(`${origin}/mcp`);
    expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl?.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    const tokenRequest = harness.requests.find(
      (request) => request.url.pathname === "/api/auth/oauth2/token",
    );
    const tokenForm = new URLSearchParams(tokenRequest?.body);
    const verifier = tokenForm.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authorizeUrl?.searchParams.get("code_challenge"),
    );
    expect(tokenForm.get("code")).toBe(authorizationCode);
    expect(tokenForm.get("resource")).toBe(`${origin}/mcp`);

    const mcpRequests = harness.requests.filter((request) => request.url.pathname === "/mcp");
    expect(mcpRequests).toHaveLength(4);
    expect(mcpRequests.map((request) => JSON.parse(request.body).method)).toEqual([
      "initialize",
      "tools/list",
      "tools/call",
      "initialize",
    ]);

    for (const request of mcpRequests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(request.headers.get("mcp-protocol-version")).toBe("2025-11-25");
    }

    const revocationRequest = harness.requests.find(
      (request) => request.url.pathname === "/api/auth/oauth2/revoke",
    );
    expect(new URLSearchParams(revocationRequest?.body)).toEqual(
      new URLSearchParams({
        client_id: clientId,
        token: accessToken,
        token_type_hint: "access_token",
      }),
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain(authorizationCode);
    expect(serialized).not.toContain(clientId);
    expect(serialized).not.toContain(verifier);
    expect(serialized).not.toContain(authorizeUrl?.searchParams.get("state"));
  });

  it("revokes issued access after an MCP catalog failure", async () => {
    const harness = authenticatedFetch({ omitStatusTool: true });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => [check.status, check.code])).toEqual([
      ["pass", "valid"],
      ["pass", "valid"],
      ["fail", "invalid_payload"],
      ["skip", "not_run"],
      ["pass", "valid"],
    ]);
    expect(
      harness.requests.some((request) => request.url.pathname === "/api/auth/oauth2/revoke"),
    ).toBe(true);
  });

  it("fails if the temporary token cannot be revoked", async () => {
    const harness = authenticatedFetch({ revokeStatus: 503 });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({
      code: "http_status",
      name: "oauth-token-revocation",
      status: "fail",
    });
  });

  it("fails if revocation returns success but leaves the access token usable", async () => {
    const harness = authenticatedFetch({ revokeWithoutEffect: true });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[4]).toMatchObject({
      code: "http_status",
      name: "oauth-token-revocation",
      status: "fail",
    });
  });

  it("reports owner denial without exchanging or revoking a token", async () => {
    const harness = authenticatedFetch();
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: async (url) => {
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

          callback.searchParams.set("error", "access_denied");
          callback.searchParams.set("iss", `${origin}/api/auth`);
          callback.searchParams.set("state", url.searchParams.get("state") ?? "");
          await globalThis.fetch(callback);
        },
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0]).toMatchObject({
      code: "authorization_denied",
      status: "fail",
    });
    expect(
      harness.requests.some((request) => request.url.pathname === "/api/auth/oauth2/token"),
    ).toBe(false);
    expect(
      harness.requests.some((request) => request.url.pathname === "/api/auth/oauth2/revoke"),
    ).toBe(false);
  });

  it("rejects refresh authority in the temporary token response", async () => {
    const harness = authenticatedFetch();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).pathname === "/api/auth/oauth2/token") {
        return jsonResponse({
          access_token: accessToken,
          expires_in: 900,
          refresh_token: "unexpected-refresh-authority",
          scope: "crewhelm:view",
          token_type: "Bearer",
        });
      }

      return harness.fetch(input, init);
    });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "invalid_payload",
      status: "fail",
    });
    expect(JSON.stringify(report)).not.toContain("unexpected-refresh-authority");
    const revocations = harness.requests.filter(
      (request) => request.url.pathname === "/api/auth/oauth2/revoke",
    );
    expect(
      revocations.map((request) => new URLSearchParams(request.body).get("token_type_hint")),
    ).toEqual(["access_token", "refresh_token"]);
  });

  it("still revokes a valid access token beside an oversized refresh token", async () => {
    const harness = authenticatedFetch();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).pathname === "/api/auth/oauth2/token") {
        return jsonResponse({
          access_token: accessToken,
          expires_in: 900,
          refresh_token: "x".repeat(8_193),
          scope: "crewhelm:view",
          token_type: "Bearer",
        });
      }

      return harness.fetch(input, init);
    });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "invalid_payload",
      status: "fail",
    });
    const revocations = harness.requests.filter(
      (request) => request.url.pathname === "/api/auth/oauth2/revoke",
    );
    expect(revocations).toHaveLength(1);
    expect(new URLSearchParams(revocations[0]?.body).get("token")).toBe(accessToken);
    expect(report.checks[4]).toMatchObject({
      code: "valid",
      status: "pass",
    });
  });

  it("bounds OAuth responses before parsing them", async () => {
    const harness = authenticatedFetch();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).pathname === "/api/auth/oauth2/register") {
        return new Response("x".repeat(16 * 1_024 + 1), {
          headers: { "content-type": "application/json" },
        });
      }

      return harness.fetch(input, init);
    });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "response_too_large",
      status: "fail",
    });
  });

  it("classifies a stalled bounded response as a timeout", async () => {
    const harness = authenticatedFetch();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).pathname === "/api/auth/oauth2/register") {
        const signal = init?.signal;

        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              signal?.addEventListener(
                "abort",
                () => {
                  controller.error(signal.reason);
                },
                { once: true },
              );
            },
          }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }

      return harness.fetch(input, init);
    });
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 20,
      },
      {
        fetch,
        openUrl: approveAuthorization([]),
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "timeout",
      status: "fail",
    });
  });

  it("reports an unavailable browser without exposing the authorization URL", async () => {
    const harness = authenticatedFetch();
    let authorizationUrl: URL | undefined;
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: async (url) => {
          authorizationUrl = url;
          throw new Error("browser-provider-secret");
        },
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "browser_unavailable",
      status: "fail",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(authorizationUrl?.search);
    expect(serialized).not.toContain("browser-provider-secret");
  });

  it("rejects a duplicated callback state without reflecting callback values", async () => {
    const harness = authenticatedFetch();
    const callbackSecret = "callback-secret";
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: async (url) => {
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "");

          callback.searchParams.append("code", callbackSecret);
          callback.searchParams.append("iss", `${origin}/api/auth`);
          callback.searchParams.append("state", url.searchParams.get("state") ?? "");
          callback.searchParams.append("state", "duplicate");
          await globalThis.fetch(callback);
        },
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "invalid_callback",
      status: "fail",
    });
    expect(JSON.stringify(report)).not.toContain(callbackSecret);
  });

  it("ignores requests outside the exact random callback path", async () => {
    const harness = authenticatedFetch();
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: async (url) => {
          const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
          const wrongPath = new URL("/oauth/callback/wrong", callback);

          expect((await globalThis.fetch(wrongPath)).status).toBe(404);
          callback.searchParams.set("code", authorizationCode);
          callback.searchParams.set("iss", `${origin}/api/auth`);
          callback.searchParams.set("state", url.searchParams.get("state") ?? "");
          expect((await globalThis.fetch(callback)).status).toBe(200);
        },
      },
    );

    expect(report.ok).toBe(true);
  });

  it("times out a bounded browser authorization wait", async () => {
    const harness = authenticatedFetch();
    const report = await diagnoseAuthenticatedDeployment(
      {
        authorizationTimeoutMs: 10,
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: harness.fetch,
        openUrl: async () => {},
      },
    );

    expect(report.checks[0]).toMatchObject({
      code: "timeout",
      status: "fail",
    });
  });

  it("does not start authorization when the public diagnosis fails", async () => {
    const openUrl = vi.fn<(url: URL) => Promise<void>>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));
    const report = await diagnoseAuthenticatedDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      { fetch, openUrl },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.every((check) => check.status === "skip")).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
