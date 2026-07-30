import { describe, expect, it, vi } from "vitest";

import { diagnoseDeployment, parseDeploymentOrigin } from "../src/doctor.js";

const origin = "https://crewhelm.example";

function jsonResponse(payload: unknown): Response {
  return new Response(`${JSON.stringify(payload)}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}

function healthyResponse(
  deployment: { fingerprint: string; protocolVersion: number } = {
    fingerprint: "a".repeat(64),
    protocolVersion: 1,
  },
): Response {
  return jsonResponse({
    deployment,
    service: "crewhelm",
    status: "ok",
  });
}

function protectedResourceResponse(): Response {
  return jsonResponse({
    authorization_servers: [`${origin}/api/auth`],
    bearer_methods_supported: ["header"],
    resource: `${origin}/mcp`,
    scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
  });
}

function authorizationServerResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
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
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
    ...overrides,
  });
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }

  return new URL(typeof input === "string" ? input : input.url);
}

function deploymentFetch(
  responseForPath: (path: string) => Response = (path) => {
    if (path === "/health") {
      return healthyResponse();
    }

    if (path === "/.well-known/oauth-protected-resource") {
      return protectedResourceResponse();
    }

    return authorizationServerResponse();
  },
): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    return responseForPath(requestUrl(input).pathname);
  });
}

describe("deployment diagnosis", () => {
  it("validates health and the MCP OAuth discovery contract", async () => {
    const fetch = deploymentFetch();
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin("https://Crewhelm.Example:443"),
        timeoutMs: 1_000,
      },
      { fetch },
    );

    expect(report).toEqual({
      schemaVersion: 3,
      ok: true,
      checks: [
        {
          code: "valid",
          endpoint: `${origin}/health`,
          message: "Worker health contract is valid.",
          name: "worker-health",
          status: "pass",
        },
        {
          code: "valid",
          endpoint: `${origin}/.well-known/oauth-protected-resource`,
          message: "MCP protected-resource metadata is valid.",
          name: "mcp-protected-resource",
          status: "pass",
        },
        {
          code: "valid",
          endpoint: `${origin}/.well-known/oauth-authorization-server/api/auth`,
          message: "OAuth authorization-server metadata is valid.",
          name: "oauth-authorization-server",
          status: "pass",
        },
      ],
      deployment: {
        alignment: "unverified",
        worker: {
          fingerprint: "a".repeat(64),
          protocolVersion: 1,
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(3);

    for (const call of vi.mocked(fetch).mock.calls) {
      expect(requestUrl(call[0]).searchParams.get("crewhelm-doctor")).toMatch(/^[a-z0-9]+$/);
      expect(call[1]).toEqual(
        expect.objectContaining({
          headers: {
            accept: "application/json",
          },
          method: "GET",
          redirect: "manual",
        }),
      );
    }
  });

  it.each([
    {
      alignment: "aligned",
      deployment: { fingerprint: "a".repeat(64), protocolVersion: 1 },
      ok: true,
    },
    {
      alignment: "different",
      deployment: { fingerprint: "b".repeat(64), protocolVersion: 1 },
      ok: false,
    },
    {
      alignment: "cli_outdated",
      deployment: { fingerprint: "b".repeat(64), protocolVersion: 2 },
      ok: false,
    },
  ])("classifies a valid Worker build as $alignment", async ({ alignment, deployment, ok }) => {
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        expectedDeploymentFingerprint: "a".repeat(64),
        fetch: deploymentFetch((path) =>
          path === "/health"
            ? healthyResponse(deployment)
            : path === "/.well-known/oauth-protected-resource"
              ? protectedResourceResponse()
              : authorizationServerResponse(),
        ),
      },
    );

    expect(report).toMatchObject({
      deployment: { alignment, worker: deployment },
      ok,
    });
  });

  it("classifies a pre-fingerprint Worker as outdated without rejecting its liveness contract", async () => {
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        expectedDeploymentFingerprint: "a".repeat(64),
        fetch: deploymentFetch((path) =>
          path === "/health"
            ? jsonResponse({ service: "crewhelm", status: "ok" })
            : path === "/.well-known/oauth-protected-resource"
              ? protectedResourceResponse()
              : authorizationServerResponse(),
        ),
      },
    );

    expect(report).toMatchObject({
      deployment: { alignment: "worker_outdated", worker: null },
      ok: false,
    });
    expect(report.checks[0]).toMatchObject({ code: "valid", status: "pass" });
  });

  it.each([
    {
      endpoint: "http://example.com",
      message: "Use HTTPS, or HTTP only for an exact loopback host.",
    },
    {
      endpoint: "https://user:secret@example.com",
      message: "The endpoint must not include credentials.",
    },
    {
      endpoint: "https://example.com/deployment",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "https://example.com?token=secret",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "https://example.com#fragment",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "file:///tmp/crewhelm",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
  ])("rejects unsafe deployment origin $endpoint", ({ endpoint, message }) => {
    expect(() => parseDeploymentOrigin(endpoint)).toThrow(message);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "allows exact loopback development origin %s",
    (endpoint) => {
      expect(parseDeploymentOrigin(endpoint).origin).toBe(endpoint);
    },
  );

  it("bounds every response body before parsing it", async () => {
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: deploymentFetch((path) =>
          path === "/.well-known/oauth-protected-resource"
            ? new Response("x".repeat(4_097), {
                headers: {
                  "content-type": "application/json",
                },
              })
            : path === "/health"
              ? healthyResponse()
              : authorizationServerResponse(),
        ),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.code)).toEqual([
      "valid",
      "response_too_large",
      "valid",
    ]);
  });

  it("rejects malformed or widened health payloads without hiding valid discovery", async () => {
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: deploymentFetch((path) =>
          path === "/health"
            ? jsonResponse({ service: "crewhelm", status: "ok", secret: "no" })
            : path === "/.well-known/oauth-protected-resource"
              ? protectedResourceResponse()
              : authorizationServerResponse(),
        ),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.code)).toEqual(["invalid_payload", "valid", "valid"]);
  });

  it("rejects cross-origin OAuth endpoints", async () => {
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      {
        fetch: deploymentFetch((path) =>
          path === "/health"
            ? healthyResponse()
            : path === "/.well-known/oauth-protected-resource"
              ? protectedResourceResponse()
              : authorizationServerResponse({
                  token_endpoint: "https://attacker.example/token",
                }),
        ),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.code)).toEqual(["valid", "valid", "invalid_payload"]);
    expect(JSON.stringify(report)).not.toContain("attacker.example");
  });

  it("does not reflect network exceptions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("secret-provider-diagnostic"));
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      { fetch },
    );

    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.code)).toEqual([
      "request_failed",
      "request_failed",
      "request_failed",
    ]);
    expect(JSON.stringify(report)).not.toContain("secret-provider-diagnostic");
  });

  it("classifies timeouts without reflecting their message", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException("secret-timeout-detail", "TimeoutError"));
    const report = await diagnoseDeployment(
      {
        origin: parseDeploymentOrigin(origin),
        timeoutMs: 1_000,
      },
      { fetch },
    );

    expect(report.checks.map((check) => check.code)).toEqual(["timeout", "timeout", "timeout"]);
    expect(JSON.stringify(report)).not.toContain("secret-timeout-detail");
  });
});
