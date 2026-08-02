import { describe, expect, it, vi } from "vitest";

import {
  beginRemoteMcpOAuthAuthorization,
  completeRemoteMcpOAuthAuthorization,
  refreshRemoteMcpOAuthCredential,
  revokeRemoteMcpOAuthCredential,
} from "./oauth.js";

const endpoint = "https://mcp.example.com/rpc";
const redirectUrl = "https://crewhelm.example/connections/remote-mcp/oauth/callback";
const clientMetadataUrl = "https://crewhelm.example/.well-known/oauth-client/crewhelm";

function fixtureRequires(condition: unknown): asserts condition {
  if (!condition) throw new Error("OAuth fixture received an invalid request.");
}

function requestParts(input: RequestInfo | URL, init?: RequestInit) {
  return {
    body:
      init?.body instanceof URLSearchParams
        ? init.body
        : typeof init?.body === "string"
          ? new URLSearchParams(init.body)
          : undefined,
    method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
    url: input instanceof Request ? input.url : input.toString(),
  };
}

function oauthFetch(options?: { dynamicRegistration?: boolean; tokenScopes?: string }) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = requestParts(input, init);
    if (request.url === "https://mcp.example.com/.well-known/oauth-protected-resource/rpc") {
      return Response.json({
        authorization_servers: ["https://auth.example.com"],
        resource: endpoint,
        scopes_supported: ["records.read", "records.write"],
      });
    }
    if (request.url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json({
        authorization_endpoint: "https://auth.example.com/authorize",
        ...(options?.dynamicRegistration === true
          ? { registration_endpoint: "https://auth.example.com/register" }
          : { client_id_metadata_document_supported: true }),
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: "https://auth.example.com",
        response_types_supported: ["code"],
        revocation_endpoint: "https://auth.example.com/revoke",
        token_endpoint: "https://auth.example.com/token",
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (request.url === "https://auth.example.com/register" && request.method === "POST") {
      const registration = JSON.parse(
        typeof init?.body === "string" ? init.body : "null",
      ) as unknown;
      fixtureRequires(typeof registration === "object" && registration !== null);
      fixtureRequires(
        JSON.stringify(Reflect.get(registration, "redirect_uris")) ===
          JSON.stringify([redirectUrl]),
      );
      fixtureRequires(Reflect.get(registration, "scope") === "records.read");
      fixtureRequires(Reflect.get(registration, "token_endpoint_auth_method") === "none");
      return Response.json({ client_id: "registered-client", redirect_uris: [redirectUrl] });
    }
    if (request.url === "https://auth.example.com/token" && request.method === "POST") {
      if (request.body?.get("grant_type") === "authorization_code") {
        fixtureRequires(request.body.get("code") === "authorization-code");
        fixtureRequires(/^[A-Za-z0-9._~-]{43,128}$/.test(request.body.get("code_verifier") ?? ""));
        fixtureRequires(request.body.get("redirect_uri") === redirectUrl);
        fixtureRequires(request.body.get("resource") === endpoint);
        return Response.json({
          access_token: "access-token",
          expires_in: 60,
          refresh_token: "refresh-token",
          scope: "records.read",
          token_type: "Bearer",
        });
      }
      fixtureRequires(request.body?.get("grant_type") === "refresh_token");
      fixtureRequires(request.body?.get("refresh_token") === "refresh-token");
      return Response.json({
        access_token: "refreshed-access-token",
        expires_in: 120,
        scope: options?.tokenScopes ?? "records.read",
        token_type: "Bearer",
      });
    }
    if (request.url === "https://auth.example.com/revoke" && request.method === "POST") {
      fixtureRequires(
        ["access_token", "refresh_token"].includes(request.body?.get("token_type_hint") ?? ""),
      );
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected OAuth request: ${request.method} ${request.url}`);
  });
}

describe("remote MCP OAuth", () => {
  it("discovers metadata, binds PKCE and resource, exchanges, refreshes, and revokes", async () => {
    const fetchImplementation = oauthFetch();
    const started = await beginRemoteMcpOAuthAuthorization({
      clientMetadataUrl,
      endpoint,
      fetchImplementation,
      redirectUrl,
      requestedScopes: ["records.read"],
      signal: new AbortController().signal,
      state: "signed-state",
    });
    const authorizationUrl = new URL(started.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://auth.example.com/authorize",
    );
    expect(authorizationUrl.searchParams).toMatchObject(expect.any(URLSearchParams));
    expect(authorizationUrl.searchParams.get("client_id")).toBe(clientMetadataUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("resource")).toBe(endpoint);
    expect(authorizationUrl.searchParams.get("scope")).toBe("records.read");
    expect(authorizationUrl.searchParams.get("state")).toBe("signed-state");

    const credential = await completeRemoteMcpOAuthAuthorization({
      authorization: started.authorization,
      authorizationCode: "authorization-code",
      fetchImplementation,
      redirectUrl,
      signal: new AbortController().signal,
    });
    expect(credential).toMatchObject({
      authorizationServerUrl: "https://auth.example.com/",
      grantedScopes: ["records.read"],
      tokens: { accessToken: "access-token", refreshToken: "refresh-token" },
    });

    const refreshed = await refreshRemoteMcpOAuthCredential({
      credential,
      fetchImplementation,
      signal: new AbortController().signal,
    });
    expect(refreshed.tokens).toMatchObject({
      accessToken: "refreshed-access-token",
      refreshToken: "refresh-token",
    });
    await expect(
      revokeRemoteMcpOAuthCredential({
        credential: refreshed,
        fetchImplementation,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe("confirmed");
  });

  it("rejects scope widening during refresh", async () => {
    const initialFetch = oauthFetch();
    const started = await beginRemoteMcpOAuthAuthorization({
      clientMetadataUrl,
      endpoint,
      fetchImplementation: initialFetch,
      redirectUrl,
      requestedScopes: ["records.read"],
      signal: new AbortController().signal,
      state: "signed-state",
    });
    const credential = await completeRemoteMcpOAuthAuthorization({
      authorization: started.authorization,
      authorizationCode: "authorization-code",
      fetchImplementation: initialFetch,
      redirectUrl,
      signal: new AbortController().signal,
    });

    await expect(
      refreshRemoteMcpOAuthCredential({
        credential,
        fetchImplementation: oauthFetch({ tokenScopes: "records.read records.write" }),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
  });

  it("uses dynamic client registration when URL client IDs are unavailable", async () => {
    const started = await beginRemoteMcpOAuthAuthorization({
      clientMetadataUrl,
      endpoint,
      fetchImplementation: oauthFetch({ dynamicRegistration: true }),
      redirectUrl,
      requestedScopes: ["records.read"],
      signal: new AbortController().signal,
      state: "signed-state",
    });

    expect(started.authorization.clientInformation.client_id).toBe("registered-client");
    expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(
      "registered-client",
    );
  });

  it("rejects credential endpoints outside the discovered authorization-server origin", async () => {
    const fetchImplementation = oauthFetch();
    fetchImplementation.mockImplementationOnce(async () =>
      Response.json({
        authorization_servers: ["https://auth.example.com"],
        resource: endpoint,
      }),
    );
    fetchImplementation.mockImplementationOnce(async () =>
      Response.json({
        authorization_endpoint: "https://auth.example.com/authorize",
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        issuer: "https://auth.example.com",
        response_types_supported: ["code"],
        token_endpoint: "https://tokens.example.net/token",
      }),
    );

    await expect(
      beginRemoteMcpOAuthAuthorization({
        clientMetadataUrl,
        endpoint,
        fetchImplementation,
        redirectUrl,
        requestedScopes: [],
        signal: new AbortController().signal,
        state: "signed-state",
      }),
    ).rejects.toMatchObject({ code: "invalid_authorization_server" });
  });
});
