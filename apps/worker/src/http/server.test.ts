import { SELF, env } from "cloudflare:test";
import {
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  healthReportSchema,
  ownerAuthoritySchema,
} from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";

import { createConnectionAuthorizationCallback } from "../owner/connections/index.js";
import { createWorker } from "./server.js";
import { deriveOwnerKey } from "../owner/identity.js";
import { OAUTH_SCOPES } from "../oauth/scopes.js";
import { registerAuthTestDatabase } from "../oauth/testkit.js";

const origin = "https://crewhelm.test";
const worker = createWorker();

registerAuthTestDatabase();

function request(path: string, init?: RequestInit): Promise<Response> | Response {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

async function connectionAuthorizationFixture(subject: string) {
  const ownerKey = await deriveOwnerKey({
    issuer: "https://github.com",
    subject,
  });
  const authority = ownerAuthoritySchema.parse({
    clientId: `client-${subject}`,
    ownerKey,
    scopes: [CONNECTIONS_READ_SCOPE, CONNECTIONS_WRITE_SCOPE],
  });
  const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
  const reservation = await controlPlane.reserveConnectionLink(authority, {
    authConfigId: "ac_github_managed",
    idempotencyKey: `callback-${subject}`,
  });

  if (!reservation.ok || reservation.state !== "dispatch") {
    throw new Error("Expected a connection authorization reservation.");
  }

  const providerConnectionId = `ca_callback_${subject}`;
  const completion = await controlPlane.completeConnectionLink(authority, {
    authorizationToken: reservation.authorizationToken,
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    providerConnectionId,
    reservationId: reservation.reservationId,
    url: `https://connect.composio.dev/link/ln_callback_${subject}`,
  });

  if (!completion.ok) {
    throw new Error("Expected a completed connection link.");
  }

  const callback = await createConnectionAuthorizationCallback({
    authorizationExpiresAt: reservation.authorizationExpiresAt,
    authorizationToken: reservation.authorizationToken,
    ownerKey,
    origin,
    reservationId: reservation.reservationId,
    signingSecret: env.BETTER_AUTH_SECRET,
  });

  return {
    authority,
    callbackUrl: callback.callbackUrl,
    connectionId: completion.connectionLink.connectionId,
    controlPlane,
    providerConnectionId,
    reservation,
  };
}

describe("Crewhelm Worker", () => {
  it("routes public health and challenges unauthenticated MCP requests", async () => {
    const healthResponse = await SELF.fetch(`${origin}/health`);
    const mcpResponse = await SELF.fetch(`${origin}/mcp`, {
      method: "POST",
    });

    expect(healthResponse.status).toBe(200);
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
    expect(await mcpResponse.text()).not.toContain("/mcp");
  });

  it.each(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])(
    "advertises exact protected-resource metadata at %s",
    async (path) => {
      const response = await SELF.fetch(`${origin}${path}`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        authorization_servers: [`${origin}/api/auth`],
        bearer_methods_supported: ["header"],
        resource: `${origin}/mcp`,
        scopes_supported: [...OAUTH_SCOPES],
      });
    },
  );

  it("reports fixed liveness metadata without caching", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload: unknown = await response.json();

    expect(healthReportSchema.parse(payload)).toEqual({
      deployment: {
        fingerprint: "0000000000000000000000000000000000000000000000000000000000000000",
        protocolVersion: 1,
      },
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

  it("records a successful Composio browser return without claiming activation", async () => {
    const fixture = await connectionAuthorizationFixture("callback-success");
    const returnUrl = new URL(fixture.callbackUrl);

    returnUrl.searchParams.set("status", "success");
    returnUrl.searchParams.set("connected_account_id", fixture.providerConnectionId);
    const response = await worker.fetch(new Request(returnUrl), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(body).toContain("Connection authorization returned.");
    expect(body).toContain('href="/oauth/styles.css"');
    expect(body).toContain('data-tone="positive"');
    expect(body).toContain('class="ch-brand" role="img" aria-label="Crewhelm"');
    expect(body).not.toMatch(/active|connected/i);
    expect(body).not.toContain(fixture.providerConnectionId);
    expect(body).not.toContain(fixture.reservation.authorizationToken);
    await expect(fixture.controlPlane.listConnections(fixture.authority, {})).resolves.toEqual({
      connections: [
        {
          accountLabel: null,
          authorizationOutcome: "returned",
          authConfigId: "ac_github_managed",
          connectionId: fixture.connectionId,
          createdAt: expect.any(String),
          integrationSlug: null,
          providerConnectionId: fixture.providerConnectionId,
          status: "initiated",
        },
      ],
      nextCursor: null,
      ok: true,
    });

    const replay = await worker.fetch(new Request(returnUrl), env);

    expect(replay.status).toBe(200);
    await expect(replay.text()).resolves.toBe(body);
    returnUrl.searchParams.set("status", "failed");
    const oppositeReturn = await worker.fetch(new Request(returnUrl), env);

    expect(oppositeReturn.status).toBe(400);
    expect(await oppositeReturn.text()).not.toContain(fixture.providerConnectionId);
  });

  it("records a failed return and rejects malformed or unsupported callback requests", async () => {
    const fixture = await connectionAuthorizationFixture("callback-failed");
    const failedUrl = new URL(fixture.callbackUrl);

    failedUrl.searchParams.set("status", "failed");
    const failedResponse = await worker.fetch(new Request(failedUrl), env);
    const failedBody = await failedResponse.text();

    expect(failedResponse.status).toBe(200);
    expect(failedBody).toContain("Connection authorization stopped.");
    expect(failedBody).toContain('data-tone="warning"');
    expect(failedBody).not.toContain(fixture.reservation.authorizationToken);
    await expect(
      fixture.controlPlane.listConnections(fixture.authority, {}),
    ).resolves.toMatchObject({
      connections: [{ authorizationOutcome: "failed", status: "initiated" }],
      ok: true,
    });

    const malformedUrl = new URL(fixture.callbackUrl);

    malformedUrl.searchParams.append("status", "success");
    malformedUrl.searchParams.append("status", "success");
    malformedUrl.searchParams.append("connected_account_id", fixture.providerConnectionId);
    const malformedResponse = await worker.fetch(new Request(malformedUrl), env);
    const malformedBody = await malformedResponse.text();

    expect(malformedResponse.status).toBe(400);
    expect(malformedBody).toContain('data-tone="negative"');
    expect(malformedBody).not.toContain(fixture.providerConnectionId);

    const unknownParameterUrl = new URL(fixture.callbackUrl);

    unknownParameterUrl.searchParams.set("status", "failed");
    unknownParameterUrl.searchParams.set("credential", "do-not-reflect-this");
    const unknownParameterResponse = await worker.fetch(new Request(unknownParameterUrl), env);
    const unknownParameterBody = await unknownParameterResponse.text();

    expect(unknownParameterResponse.status).toBe(400);
    expect(unknownParameterBody).not.toContain("do-not-reflect-this");

    const headResponse = await worker.fetch(
      new Request(fixture.callbackUrl, { method: "HEAD" }),
      env,
    );

    expect(headResponse.status).toBe(405);
    expect(headResponse.headers.get("allow")).toBe("GET");
    await expect(headResponse.text()).resolves.toBe("");
  });

  it("rejects forged or expired callback authenticators before owner-object dispatch", async () => {
    const getByName = vi.spyOn(env.OWNER_CONTROL_PLANE, "getByName");
    const ownerKey = `owner_${"b".repeat(43)}`;
    const reservationId = "connection_link_00000000-0000-4000-8000-000000000000";
    const authorizationToken = "a".repeat(43);
    const signedCallback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
      authorizationToken,
      ownerKey,
      origin,
      reservationId,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const forgedUrl = new URL(
      signedCallback.callbackUrl.replace(ownerKey, `owner_${"c".repeat(43)}`),
    );

    forgedUrl.searchParams.set("status", "success");
    forgedUrl.searchParams.set("connected_account_id", "ca_forged_callback");
    const forgedResponse = await worker.fetch(new Request(forgedUrl), env);

    expect(forgedResponse.status).toBe(400);
    expect(getByName).not.toHaveBeenCalled();

    const expiredCallback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
      authorizationToken,
      ownerKey,
      origin,
      reservationId,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const expiredUrl = new URL(expiredCallback.callbackUrl);

    expiredUrl.searchParams.set("status", "failed");
    const expiredResponse = await worker.fetch(new Request(expiredUrl), env);

    expect(expiredResponse.status).toBe(400);
    expect(getByName).not.toHaveBeenCalled();
    getByName.mockRestore();
  });
});
