import { describe, expect, it, vi } from "vitest";

import {
  authorizeRefreshableOwnerCredential,
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseTemporaryOwnerSessionFailure,
  runRefreshableOwnerSession,
  type RefreshableOwnerCredential,
} from "../src/temporary-owner-session.js";

const origin = new URL("https://crewhelm-testing.example");
const credential = {
  clientId: "persistent-client",
  origin: origin.origin,
  refreshToken: "old-refresh-token",
  schemaVersion: 1 as const,
  scope: "crewhelm:full" as const,
};

function requestBodyText(body: BodyInit | null | undefined): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unexpected request body type.");
}

describe("refreshable owner sessions", () => {
  it("validates explicit session failures without trusting hostile thrown values", () => {
    expect(
      parseTemporaryOwnerSessionFailure({ code: "timeout", message: "Authorization timed out." }),
    ).toEqual({ code: "timeout", message: "Authorization timed out." });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile getter");
        },
      },
    );

    expect(parseTemporaryOwnerSessionFailure(hostile)).toBeNull();
  });

  it("requests offline access once and retains only the refresh credential", async () => {
    const persisted = vi.fn<(value: RefreshableOwnerCredential) => Promise<void>>(
      async () => undefined,
    );
    const revoked = new Set<string>();
    const requests: Array<{ body: string; path: string }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      const body = requestBodyText(init?.body);
      requests.push({ body, path: url.pathname });
      if (url.pathname.endsWith("/oauth2/register")) {
        return Response.json({
          client_id: credential.clientId,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "bootstrap-access",
          expires_in: 900,
          refresh_token: "bootstrap-refresh",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(body).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/mcp") {
        const bearer =
          new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        if (revoked.has(bearer)) return new Response(null, { status: 401 });
        return Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: { name: "crewhelm", version: "test" },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const openUrl = async (authorizeUrl: URL) => {
      expect(authorizeUrl.searchParams.get("scope")).toBe("crewhelm:full offline_access");
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("iss", `${origin.origin}/api/auth`);
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
      await globalThis.fetch(callback, { redirect: "manual" });
    };

    const result = await authorizeRefreshableOwnerCredential(
      {
        clientName: "Combined authentication test",
        origin,
        persistCredential: persisted,
        scope: "crewhelm:full",
        timeoutMs: 5_000,
      },
      { fetch, openUrl },
      (session) =>
        session.call(
          "initialize",
          {
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
          initializeResponseSchema,
        ),
    );

    expect(result).toMatchObject({
      authorization: { ok: true },
      operation: { ok: true, status: "completed" },
      revocation: { ok: true, status: "revoked" },
    });
    expect(persisted).toHaveBeenCalledWith({
      ...credential,
      refreshToken: "bootstrap-refresh",
    });
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      grant_types: ["authorization_code", "refresh_token"],
      scope: "crewhelm:full offline_access",
    });
    expect(requests.filter((request) => request.path.endsWith("/oauth2/revoke"))).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("bootstrap-refresh");
  });

  it("revokes bootstrap refresh authority when credential persistence fails", async () => {
    const revoked = new Set<string>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      const body = requestBodyText(init?.body);
      if (url.pathname.endsWith("/oauth2/register")) {
        return Response.json({
          client_id: credential.clientId,
          token_endpoint_auth_method: "none",
        });
      }
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "orphan-bootstrap-access",
          expires_in: 900,
          refresh_token: "orphan-bootstrap-refresh",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(body).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/mcp") {
        const bearer =
          new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        return new Response(null, { status: revoked.has(bearer) ? 401 : 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const openUrl = async (authorizeUrl: URL) => {
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("iss", `${origin.origin}/api/auth`);
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
      await globalThis.fetch(callback, { redirect: "manual" });
    };

    const result = await authorizeRefreshableOwnerCredential(
      {
        clientName: "Combined authentication test",
        origin,
        persistCredential: async () => {
          throw new Error("Injected persistence failure.");
        },
        scope: "crewhelm:full",
        timeoutMs: 5_000,
      },
      { fetch, openUrl },
      async () => undefined,
    );

    expect(result).toMatchObject({
      authorization: { ok: false },
      operation: { status: "not_run" },
      revocation: { ok: true, status: "revoked" },
    });
    expect(revoked).toEqual(new Set(["orphan-bootstrap-access", "orphan-bootstrap-refresh"]));
  });

  it("rotates refresh authority, keeps tokens out of results, and revokes short-lived access", async () => {
    const persisted = vi.fn<(value: RefreshableOwnerCredential) => Promise<void>>(
      async () => undefined,
    );
    const revoked = new Set<string>();
    const requests: Array<{ body: string; headers: Headers; path: string }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      const body = requestBodyText(init?.body);
      const headers = new Headers(init?.headers);
      requests.push({ body, headers, path: url.pathname });

      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "short-lived-access-token",
          expires_in: 900,
          refresh_token: "new-refresh-token",
          scope: "crewhelm:full offline_access",
          token_type: "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(body).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/mcp") {
        const bearer = headers.get("authorization")?.replace("Bearer ", "") ?? "";
        if (revoked.has(bearer)) return new Response(null, { status: 401 });
        return Response.json({
          id: 1,
          jsonrpc: "2.0",
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            serverInfo: { name: "crewhelm", version: "test" },
          },
        });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const result = await runRefreshableOwnerSession(
      {
        credential,
        origin,
        persistCredential: persisted,
        timeoutMs: 5_000,
      },
      { fetch },
      (session) =>
        session.call(
          "initialize",
          {
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
            protocolVersion: MCP_PROTOCOL_VERSION,
          },
          initializeResponseSchema,
        ),
    );

    expect(result).toMatchObject({
      authorization: { ok: true },
      operation: { ok: true, status: "completed" },
      revocation: { ok: true, status: "revoked" },
    });
    expect(persisted).toHaveBeenCalledWith({ ...credential, refreshToken: "new-refresh-token" });
    expect(requests[0]?.body).toContain("grant_type=refresh_token");
    expect(requests[0]?.body).toContain("refresh_token=old-refresh-token");
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer short-lived-access-token");
    expect(JSON.stringify(result)).not.toContain("access-token");
    expect(JSON.stringify(result)).not.toContain("refresh-token");
  });

  it.each([
    { malformed: false, name: "persistence failure" },
    { malformed: true, name: "response validation failure" },
  ])("revokes rotated refresh authority after $name", async ({ malformed }) => {
    const revoked = new Set<string>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(
        input instanceof URL ? input : typeof input === "string" ? input : input.url,
      );
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({
          access_token: "orphan-rotated-access",
          expires_in: 900,
          refresh_token: "orphan-rotated-refresh",
          scope: "crewhelm:full offline_access",
          token_type: malformed ? "DPoP" : "Bearer",
        });
      }
      if (url.pathname.endsWith("/oauth2/revoke")) {
        revoked.add(new URLSearchParams(requestBodyText(init?.body)).get("token") ?? "");
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/mcp") {
        const bearer =
          new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
        return new Response(null, { status: revoked.has(bearer) ? 401 : 200 });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });

    const result = await runRefreshableOwnerSession(
      {
        credential,
        origin,
        persistCredential: async () => {
          if (!malformed) throw new Error("Injected persistence failure.");
        },
        timeoutMs: 5_000,
      },
      { fetch },
      async () => undefined,
    );

    expect(result).toMatchObject({
      authorization: { ok: false },
      operation: { status: "not_run" },
      revocation: { ok: true, status: "revoked" },
    });
    expect(revoked).toEqual(new Set(["orphan-rotated-access", "orphan-rotated-refresh"]));
  });

  it("rejects a credential pinned to another origin before network access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await runRefreshableOwnerSession(
      {
        credential: { ...credential, origin: "https://other.example" },
        origin,
        persistCredential: vi.fn<(value: RefreshableOwnerCredential) => Promise<void>>(
          async () => undefined,
        ),
        timeoutMs: 5_000,
      },
      { fetch },
      async () => undefined,
    );

    expect(result.authorization).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});
