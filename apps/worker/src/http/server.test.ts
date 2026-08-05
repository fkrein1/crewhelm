import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  healthReportSchema,
  ownerAuthoritySchema,
  OWNER_WRITE_SCOPE,
  remoteMcpConnectionOperationResultSchema,
  PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS,
  PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
  RUNS_WRITE_SCOPE,
} from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";

import { createConnectionAuthorizationCallback } from "../owner/connections/index.js";
import { createRemoteMcpApiKeySetup, createRemoteMcpBearerSetup } from "../remote-mcp/handoff.js";
import {
  createProviderAuthSetupCapability,
  createProviderAuthSetupSession,
} from "../provider-auth-setup/capability.js";
import { createWorker } from "./server.js";
import { deriveOwnerKey } from "../owner/identity.js";
import { OAUTH_SCOPES } from "../oauth/scopes.js";
import { registerAuthTestDatabase } from "../oauth/testkit.js";

const origin = "https://crewhelm.test";
const worker = createWorker();
const encoder = new TextEncoder();

registerAuthTestDatabase();

function request(path: string, init?: RequestInit): Promise<Response> | Response {
  return worker.fetch(new Request(`${origin}${path}`, init), env);
}

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function remoteMcpOAuthFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/rpc") {
      return Response.json({
        authorization_servers: ["https://auth.example.com"],
        resource: "https://mcp.example.com/rpc",
        scopes_supported: ["records.read"],
      });
    }
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
      return Response.json({
        authorization_endpoint: "https://auth.example.com/authorize",
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: "https://auth.example.com",
        response_types_supported: ["code"],
        revocation_endpoint: "https://auth.example.com/revoke",
        token_endpoint: "https://auth.example.com/token",
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url === "https://auth.example.com/token" && method === "POST") {
      const parameters = init?.body instanceof URLSearchParams ? init.body : undefined;
      if (parameters?.get("grant_type") === "refresh_token") {
        return Response.json({
          access_token: "oauth-refreshed-secret",
          expires_in: 3_600,
          refresh_token: "oauth-refresh-secret",
          scope: "records.read",
          token_type: "Bearer",
        });
      }
      return Response.json({
        access_token: "oauth-access-secret",
        expires_in: 1,
        refresh_token: "oauth-refresh-secret",
        scope: "records.read",
        token_type: "Bearer",
      });
    }
    if (url === "https://auth.example.com/revoke" && method === "POST") {
      return new Response(null, { status: 200 });
    }
    if (url === "https://mcp.example.com/rpc" && method === "POST") {
      const authorization = new Headers(init?.headers).get("authorization");
      if (
        authorization !== "Bearer oauth-access-secret" &&
        authorization !== "Bearer oauth-refreshed-secret"
      ) {
        return new Response(null, { status: 401 });
      }
      if (typeof init?.body !== "string") throw new Error("Expected MCP request body.");
      const rpc: unknown = JSON.parse(init.body);
      if (typeof rpc !== "object" || rpc === null || Array.isArray(rpc)) {
        throw new Error("Expected MCP request object.");
      }
      const id = Reflect.get(rpc, "id");
      const rpcMethod = Reflect.get(rpc, "method");
      if (rpcMethod === "initialize") {
        return Response.json({
          id,
          jsonrpc: "2.0",
          result: {
            capabilities: { tools: {} },
            protocolVersion: "2025-06-18",
            serverInfo: { name: "oauth-server", version: "1.0.0" },
          },
        });
      }
      if (rpcMethod === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (rpcMethod === "tools/list") {
        return Response.json({
          id,
          jsonrpc: "2.0",
          result: {
            tools: [{ inputSchema: { type: "object" }, name: "records.read" }],
          },
        });
      }
      if (rpcMethod === "tools/call") {
        return Response.json({
          id,
          jsonrpc: "2.0",
          result: {
            content: [
              {
                text: `refreshed:${authorization === "Bearer oauth-refreshed-secret"}`,
                type: "text",
              },
            ],
          },
        });
      }
    }
    throw new Error(`Unexpected OAuth fixture request: ${method} ${url}`);
  });
}

function remoteMcpApiKeyFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== "https://mcp.example.com/rpc" || init?.method !== "POST") {
      throw new Error(`Unexpected API-key MCP request: ${url}`);
    }
    if (new Headers(init.headers).get("x-api-key") !== "private-api-key") {
      return new Response(null, { status: 401 });
    }
    if (typeof init.body !== "string") throw new Error("Expected MCP request body.");
    const rpc: unknown = JSON.parse(init.body);
    if (typeof rpc !== "object" || rpc === null || Array.isArray(rpc)) {
      throw new Error("Expected MCP request object.");
    }
    const id = Reflect.get(rpc, "id");
    const rpcMethod = Reflect.get(rpc, "method");
    if (rpcMethod === "initialize") {
      return Response.json({
        id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "api-key-server", version: "1.0.0" },
        },
      });
    }
    if (rpcMethod === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpcMethod === "tools/list") {
      return Response.json({
        id,
        jsonrpc: "2.0",
        result: { tools: [{ inputSchema: { type: "object" }, name: "records.read" }] },
      });
    }
    throw new Error(`Unexpected API-key MCP method: ${String(rpcMethod)}`);
  });
}

function remoteMcpBearerFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url !== "https://mcp.example.com/rpc" || init?.method !== "POST") {
      throw new Error(`Unexpected bearer MCP request: ${url}`);
    }
    if (new Headers(init.headers).get("authorization") !== "Bearer private-bearer-token") {
      return new Response(null, { status: 401 });
    }
    if (typeof init.body !== "string") throw new Error("Expected MCP request body.");
    const rpc: unknown = JSON.parse(init.body);
    const id = typeof rpc === "object" && rpc !== null ? Reflect.get(rpc, "id") : undefined;
    const rpcMethod =
      typeof rpc === "object" && rpc !== null ? Reflect.get(rpc, "method") : undefined;
    if (rpcMethod === "initialize") {
      return Response.json({
        id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "bearer-server", version: "1.0.0" },
        },
      });
    }
    if (rpcMethod === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpcMethod === "tools/list") {
      return Response.json({
        id,
        jsonrpc: "2.0",
        result: { tools: [{ inputSchema: { type: "object" }, name: "records.read" }] },
      });
    }
    throw new Error(`Unexpected bearer MCP method: ${String(rpcMethod)}`);
  });
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
  await runInDurableObject(controlPlane, (_instance, state) => {
    state.storage.sql.exec(`
      INSERT INTO provider_auth_configs
        (auth_config_id, integration_slug, auth_scheme, source, display_name, created_at, updated_at)
      VALUES ('ac_github_managed', 'github', 'OAUTH2', 'composio_managed', 'GitHub', 1, 1)
    `);
  });
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

  it("relays browser credentials directly to Composio through a one-time setup session", async () => {
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "provider-auth-browser",
    });
    const authority = ownerAuthoritySchema.parse({
      clientId: "provider-auth-browser-client",
      ownerKey,
      scopes: [CONNECTION_CONFIGS_WRITE_SCOPE, CONNECTIONS_WRITE_SCOPE],
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const now = Date.now();
    const setupId = "provider_auth_setup_12345678-1234-4123-8123-123456789abc";
    const capabilityExpiresAt = now + PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS;
    const setupExpiresAt = now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS;
    const capability = await createProviderAuthSetupCapability({
      claims: { expiresAt: capabilityExpiresAt, ownerKey, setupId },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const plan = {
      authorizeConnection: true,
      authScheme: "OAUTH2" as const,
      callbackUrl: "https://backend.composio.dev/api/v3.1/toolkits/auth/callback",
      fieldSchemaDigest: "a".repeat(64),
      fields: [
        {
          key: "client_secret",
          label: "Client secret",
          maximumLength: 8_192,
          multiline: false,
          required: true,
          secret: true,
          stage: "auth_config" as const,
          type: "string" as const,
        },
      ],
      integrationName: "GitHub",
      integrationSlug: "github",
      support: "supported" as const,
      setupId,
    };
    await expect(
      controlPlane.prepareProviderAuthSetup(authority, {
        capabilityDigest: capability.capabilityDigest,
        capabilityExpiresAt,
        idempotencyKey: "provider-auth-browser",
        plan,
        setupExpiresAt,
      }),
    ).resolves.toMatchObject({ ok: true, state: "prepared" });

    const page = await request("/setup/provider-auth");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const script = await request("/setup/provider-auth/app.js");
    const scriptBody = await script.text();
    expect(script.status).toBe(200);
    expect(scriptBody).toContain('result.plan.support === "unsupported"');
    expect(scriptBody).toContain('input.type = field.secret ? "password" : "text"');
    expect(scriptBody).toContain('reveal.setAttribute("aria-pressed", "false")');
    expect(scriptBody).not.toContain("Space-separated permissions requested by this app.");
    expect(scriptBody).toContain("Crewhelm clears the form and does not store these credentials.");

    const wrongOrigin = await request("/setup/provider-auth/exchange", {
      body: JSON.stringify({ capability: capability.capability }),
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
    });
    expect(wrongOrigin.status).toBe(400);

    const exchanged = await request("/setup/provider-auth/exchange", {
      body: JSON.stringify({ capability: capability.capability }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    });
    expect(exchanged.status).toBe(200);
    const cookie = exchanged.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(capability.capability);
    await expect(exchanged.json()).resolves.toMatchObject({ ok: true, plan, status: "exchanged" });

    const replay = await request("/setup/provider-auth/exchange", {
      body: JSON.stringify({ capability: capability.capability }),
      headers: { "content-type": "application/json", origin },
      method: "POST",
    });
    expect(replay.status).toBe(400);

    const clientSecret = "browser-only-client-secret";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json(
          {
            auth_config: {
              auth_scheme: "OAUTH2",
              id: "ac_github_browser_custom",
              is_composio_managed: false,
            },
            toolkit: { slug: "github" },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            connected_account_id: "ca_github_browser",
            expires_at: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
            link_token: "ln_github_browser",
            redirect_url: "https://connect.composio.dev/link/ln_github_browser",
          },
          { status: 201 },
        ),
      );
    const sessionCookie = cookie.split(";", 1)[0] ?? "";
    const configured = await request("/setup/provider-auth/configure", {
      body: JSON.stringify({ credentials: { client_secret: clientSecret } }),
      headers: { "content-type": "application/json", cookie: sessionCookie, origin },
      method: "POST",
    });
    expect(configured.status).toBe(200);
    const configuredBody = await configured.text();
    expect(configuredBody).not.toContain(clientSecret);
    const [, customInit] = fetchMock.mock.calls[0] ?? [];
    if (typeof customInit?.body !== "string") throw new Error("Expected custom auth body.");
    expect(JSON.parse(customInit.body)).toMatchObject({
      auth_config: {
        credentials: {
          client_secret: clientSecret,
          oauth_redirect_uri: plan.callbackUrl,
        },
        type: "use_custom_auth",
      },
      toolkit: { slug: "github" },
    });

    const connected = await request("/setup/provider-auth/connect", {
      body: "{}",
      headers: { "content-type": "application/json", cookie: sessionCookie, origin },
      method: "POST",
    });
    expect(connected.status).toBe(200);
    await expect(connected.json()).resolves.toEqual({
      ok: true,
      url: "https://connect.composio.dev/link/ln_github_browser",
    });
    const [, connectionInit] = fetchMock.mock.calls[1] ?? [];
    if (typeof connectionInit?.body !== "string") {
      throw new Error("Expected connection-link body.");
    }
    expect(JSON.parse(connectionInit.body)).not.toHaveProperty("connection_data");

    const stored = await runInDurableObject(controlPlane, (_instance, state) => [
      ...state.storage.sql.exec("SELECT * FROM provider_auth_setup_requests").toArray(),
      ...state.storage.sql.exec("SELECT * FROM provider_auth_configs").toArray(),
    ]);
    expect(JSON.stringify(stored)).not.toContain(clientSecret);
    expect(JSON.stringify(stored)).not.toContain(capability.capability);
    fetchMock.mockRestore();
  });

  it("does not widen a credential-setup session into connection authority", async () => {
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "provider-auth-browser-no-connection-scope",
    });
    const authority = ownerAuthoritySchema.parse({
      clientId: "provider-auth-config-only-client",
      ownerKey,
      scopes: [CONNECTION_CONFIGS_WRITE_SCOPE],
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const now = Date.now();
    const setupId = "provider_auth_setup_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const capabilityExpiresAt = now + PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS;
    const capability = await createProviderAuthSetupCapability({
      claims: { expiresAt: capabilityExpiresAt, ownerKey, setupId },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const plan = {
      authorizeConnection: false,
      authScheme: "API_KEY" as const,
      fieldSchemaDigest: "b".repeat(64),
      fields: [
        {
          key: "api_key",
          label: "API key",
          maximumLength: 8_192,
          multiline: false,
          required: true,
          secret: true,
          stage: "auth_config" as const,
          type: "string" as const,
        },
      ],
      integrationName: "Linear",
      integrationSlug: "linear",
      support: "supported" as const,
      setupId,
    };
    await expect(
      controlPlane.prepareProviderAuthSetup(authority, {
        capabilityDigest: capability.capabilityDigest,
        capabilityExpiresAt,
        idempotencyKey: "provider-auth-config-only-widened",
        plan: { ...plan, authorizeConnection: true },
        setupExpiresAt: now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
      }),
    ).resolves.toMatchObject({ error: { code: "insufficient_scope" }, ok: false });
    await expect(
      controlPlane.prepareProviderAuthSetup(authority, {
        capabilityDigest: capability.capabilityDigest,
        capabilityExpiresAt,
        idempotencyKey: "provider-auth-config-only",
        plan,
        setupExpiresAt: now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
      }),
    ).resolves.toMatchObject({ ok: true, state: "prepared" });
    const session = await createProviderAuthSetupSession({
      ownerKey,
      setupId,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    await expect(
      controlPlane.exchangeProviderAuthSetup({
        capabilityDigest: capability.capabilityDigest,
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({ ok: true, status: "exchanged" });
    await expect(
      controlPlane.reserveProviderAuthSetupConfiguration({
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      controlPlane.completeProviderAuthSetup({
        authConfig: {
          authConfigId: "ac_linear_custom",
          authScheme: "API_KEY",
          integrationSlug: "linear",
          name: "Crewhelm linear custom",
          source: "crewhelm_custom",
        },
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({ authConfigId: "ac_linear_custom", ok: true });

    await expect(
      controlPlane.providerAuthSetupAuthority({
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toEqual({ error: "provider_auth_setup_denied", ok: false });
  });

  it("reconciles an interrupted custom-auth submission without resubmitting credentials", async () => {
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "provider-auth-browser-recovery",
    });
    const authority = ownerAuthoritySchema.parse({
      clientId: "provider-auth-browser-recovery-client",
      ownerKey,
      scopes: [CONNECTION_CONFIGS_WRITE_SCOPE],
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const now = Date.now();
    const setupId = "provider_auth_setup_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const capabilityExpiresAt = now + PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS;
    const capability = await createProviderAuthSetupCapability({
      claims: { expiresAt: capabilityExpiresAt, ownerKey, setupId },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const plan = {
      authorizeConnection: false,
      authScheme: "API_KEY" as const,
      fieldSchemaDigest: "c".repeat(64),
      fields: [
        {
          key: "api_key",
          label: "API key",
          maximumLength: 8_192,
          multiline: false,
          required: true,
          secret: true,
          stage: "auth_config" as const,
          type: "string" as const,
        },
      ],
      integrationName: "Linear",
      integrationSlug: "linear",
      support: "supported" as const,
      setupId,
    };
    await expect(
      controlPlane.prepareProviderAuthSetup(authority, {
        capabilityDigest: capability.capabilityDigest,
        capabilityExpiresAt,
        idempotencyKey: "provider-auth-browser-recovery",
        plan,
        setupExpiresAt: now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
      }),
    ).resolves.toMatchObject({ ok: true });
    const session = await createProviderAuthSetupSession({
      ownerKey,
      setupId,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    await expect(
      controlPlane.exchangeProviderAuthSetup({
        capabilityDigest: capability.capabilityDigest,
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({ ok: true, status: "exchanged" });
    await expect(
      controlPlane.reserveProviderAuthSetupConfiguration({
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({ ok: true });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE provider_auth_setup_requests SET recover_after = 1 WHERE setup_id = ?",
        setupId,
      );
    });
    const pending = await controlPlane.readProviderAuthSetup({
      sessionDigest: session.sessionDigest,
      setupId,
    });
    expect(pending).toMatchObject({ ok: true, recoverAfter: 1, status: "outcome_unknown" });
    if (!pending.ok) throw new Error("Expected recoverable provider auth setup.");
    await expect(
      controlPlane.reconcileProviderAuthSetup({
        outcome: "still_unknown",
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId,
      }),
    ).resolves.toMatchObject({
      ok: true,
      sessionExpiresAt: pending.sessionExpiresAt,
      status: "outcome_unknown",
    });
    await runInDurableObject(controlPlane, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE provider_auth_setup_requests SET recover_after = 1 WHERE setup_id = ?",
        setupId,
      );
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        items: [
          {
            auth_scheme: "API_KEY",
            id: "ac_linear_recovered",
            is_composio_managed: false,
            name: "Crewhelm bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            status: "ENABLED",
            toolkit: { slug: "linear" },
          },
        ],
        next_cursor: null,
      }),
    );
    const response = await request("/setup/provider-auth/reconcile", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        cookie: `crewhelm_provider_auth=${session.token}`,
        origin,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("crewhelm_provider_auth=");
    await expect(response.json()).resolves.toMatchObject({
      authConfigId: "ac_linear_recovered",
      ok: true,
      status: "configured",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT status, auth_config_id AS authConfigId FROM provider_auth_setup_requests WHERE setup_id = ?",
            setupId,
          )
          .one(),
      ),
    ).resolves.toEqual({ authConfigId: "ac_linear_recovered", status: "configured" });
    fetchMock.mockRestore();
  });

  it("routes Composio payloads only to the fixed verifier before owner selection", async () => {
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "composio-webhook-routing",
    });
    const getByName = vi.spyOn(env.OWNER_CONTROL_PLANE, "getByName");
    const wrongMethod = await request("/webhooks/composio", { method: "GET" });

    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const wrongMediaType = await request("/webhooks/composio", {
      body: "{}",
      headers: { "content-type": "text/plain" },
      method: "POST",
    });

    expect(wrongMediaType.status).toBe(400);

    const oversized = await request("/webhooks/composio", {
      body: "{}",
      headers: {
        "content-length": String(256 * 1_024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(oversized.status).toBe(400);

    const oversizedHeaders = await request("/webhooks/composio", {
      body: "{}",
      headers: {
        "content-type": "application/json",
        "webhook-id": "webhook_oversized_headers",
        "webhook-signature": "s".repeat(513),
        "webhook-timestamp": String(Math.floor(Date.now() / 1_000)),
      },
      method: "POST",
    });

    expect(oversizedHeaders.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();

    const unsigned = await request("/webhooks/composio", {
      body: JSON.stringify({ metadata: { user_id: ownerKey } }),
      headers: {
        "content-type": "application/json",
        "webhook-id": "webhook_unsigned",
        "webhook-signature": "v1,invalid-signature",
        "webhook-timestamp": String(Math.floor(Date.now() / 1_000)),
      },
      method: "POST",
    });

    expect(unsigned.status).toBe(503);
    expect(await unsigned.text()).not.toContain(ownerKey);
    expect(getByName).toHaveBeenCalled();
    expect(getByName.mock.calls.every(([name]) => name === "system:composio-webhook-ingress")).toBe(
      true,
    );
    getByName.mockRestore();
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

  it("publishes remote MCP OAuth client metadata", async () => {
    const response = await request("/.well-known/oauth-client/crewhelm");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      client_uri: origin,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [`${origin}/connections/remote-mcp/oauth/callback`],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    const head = await request("/.well-known/oauth-client/crewhelm", { method: "HEAD" });
    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
  });

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

  it("records and verifies a successful Composio browser return through its exact callback", async () => {
    const fixture = await connectionAuthorizationFixture("callback-success");
    const returnUrl = new URL(fixture.callbackUrl);

    returnUrl.searchParams.set("status", "success");
    returnUrl.searchParams.set("connected_account_id", fixture.providerConnectionId);
    const response = await worker.fetch(new Request(returnUrl), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(body).toContain("Verifying connection…");
    expect(body).toContain('href="/oauth/styles.css"');
    expect(body).toContain('data-tone="positive"');
    expect(body).toContain('class="ch-brand" role="img" aria-label="Crewhelm"');
    expect(body).toContain('class="ch-brand__mark"');
    expect(body).not.toMatch(/connection ready/i);
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
          integrationSlug: "github",
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

    const script = await request("/connections/composio/callback/app.js");
    const scriptBody = await script.text();
    expect(script.status).toBe(200);
    expect(scriptBody).toContain("void verify(6)");
    expect(scriptBody).toContain("void verify(1)");
    expect(scriptBody).toContain("window.setTimeout(resolve, 2000)");
    expect(body).toContain("Check again");

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          alias: "Test GitHub",
          id: fixture.providerConnectionId,
          status: "ACTIVE",
          toolkit: { slug: "github" },
        }),
      );
    const checkUrl = new URL(returnUrl);
    checkUrl.searchParams.set("check", "1");
    const pending = await worker.fetch(new Request(checkUrl), env);
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toEqual({ state: "pending" });
    const checked = await worker.fetch(new Request(checkUrl), env);
    expect(checked.status).toBe(200);
    await expect(checked.json()).resolves.toEqual({ state: "connected" });
    await expect(
      fixture.controlPlane.listConnections(fixture.authority, {}),
    ).resolves.toMatchObject({
      connections: [{ accountLabel: "Test GitHub", status: "active" }],
      ok: true,
    });
    fetchMock.mockRestore();

    returnUrl.searchParams.set("status", "failed");
    const oppositeReturn = await worker.fetch(new Request(returnUrl), env);

    expect(oppositeReturn.status).toBe(400);
    expect(await oppositeReturn.text()).not.toContain(fixture.providerConnectionId);
  });

  it("serves only authentic, bounded remote MCP bearer handoffs", async () => {
    const ownerKey = `owner_${"r".repeat(43)}`;
    const setup = await createRemoteMcpBearerSetup({
      claims: {
        endpoint: "https://mcp.example.com/rpc",
        expiresAt: Date.now() + 60_000,
        idempotencyKey: "remote-mcp-browser-handoff",
        name: "Project MCP",
        ownerKey,
      },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const response = await worker.fetch(new Request(setup.url), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(body).toContain("Project MCP");
    expect(body).toContain("https://mcp.example.com/rpc");
    expect(body).toContain('class="ch-panel ch-panel--form"');
    expect(body).toContain('class="ch-input"');
    expect(body).toContain('type="password"');

    const getByName = vi.spyOn(env.OWNER_CONTROL_PLANE, "getByName");
    const forgedUrl = `${setup.url.slice(0, -1)}${setup.url.endsWith("A") ? "B" : "A"}`;
    const forged = await worker.fetch(new Request(forgedUrl), env);
    expect(forged.status).toBe(400);

    const malformed = await worker.fetch(
      new Request(setup.url, {
        body: "bearerToken=secret&unexpected=credential",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain("secret");
    expect(getByName).not.toHaveBeenCalled();
    getByName.mockRestore();

    const fetchMock = remoteMcpBearerFetch();
    const connected = await worker.fetch(
      new Request(setup.url, {
        body: "bearerToken=private-bearer-token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
    );
    fetchMock.mockRestore();
    expect(connected.status).toBe(200);
    const mutation = await runInDurableObject(
      env.OWNER_CONTROL_PLANE.getByName(ownerKey),
      (_instance, state) =>
        state.storage.sql.exec(`SELECT client_id FROM remote_mcp_connection_mutations`).one(),
    );
    expect(mutation).toEqual({ client_id: "crewhelm:remote-mcp-bearer-handoff" });
  });

  it("reports a safe, actionable remote MCP upstream denial", async () => {
    const setup = await createRemoteMcpBearerSetup({
      claims: {
        endpoint: "https://mcp.example.com/private/path",
        expiresAt: Date.now() + 60_000,
        idempotencyKey: "remote-mcp-browser-upstream-denial",
        name: "Denied MCP",
        ownerKey: `owner_${"d".repeat(43)}`,
      },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("sensitive upstream body", { status: 403 }));

    const response = await worker.fetch(
      new Request(setup.url, {
        body: "bearerToken=private-bearer-token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
    );
    fetchMock.mockRestore();
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("Remote MCP connection failed");
    expect(body).toContain("HTTP 403");
    expect(body).not.toContain("private-bearer-token");
    expect(body).not.toContain("sensitive upstream body");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-bearer-token");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("sensitive upstream body");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("/private/path");
    warning.mockRestore();
  });

  it("connects a named-header API-key MCP through a bounded browser handoff", async () => {
    const ownerKey = `owner_${"k".repeat(43)}`;
    const setup = await createRemoteMcpApiKeySetup({
      claims: {
        apiKeyHeaderName: "X-API-Key",
        endpoint: "https://mcp.example.com/rpc",
        expiresAt: Date.now() + 60_000,
        idempotencyKey: "remote-mcp-api-key-browser-handoff",
        name: "API Key MCP",
        ownerKey,
      },
      origin,
      signingSecret: env.BETTER_AUTH_SECRET,
    });
    const page = await worker.fetch(new Request(setup.url), env);
    const pageBody = await page.text();

    expect(page.status).toBe(200);
    expect(pageBody).toContain("API key");
    expect(pageBody).toContain("x-api-key");
    expect(pageBody).toContain('class="ch-panel ch-panel--form"');
    expect(pageBody).toContain('class="ch-form"');
    expect(pageBody).toContain('class="ch-field"');
    expect(pageBody).toContain('class="ch-input"');
    expect(pageBody).toContain('class="ch-field-hint"');
    expect(pageBody).toContain('class="ch-trust"');
    expect(pageBody).not.toContain("private-api-key");

    const fetchMock = remoteMcpApiKeyFetch();
    const connected = await worker.fetch(
      new Request(setup.url, {
        body: "apiKey=private-api-key",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }),
      env,
    );
    fetchMock.mockRestore();
    const connectedBody = await connected.text();

    expect(connected.status).toBe(200);
    expect(connectedBody).toContain("Remote MCP connected");
    expect(connectedBody).not.toContain("private-api-key");
    const stored = await runInDurableObject(
      env.OWNER_CONTROL_PLANE.getByName(ownerKey),
      (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT r.auth_kind, r.api_key_header_name, r.credential_ciphertext,
                    r.credential_nonce, m.client_id
             FROM remote_mcp_connections r
             INNER JOIN remote_mcp_connection_mutations m
               ON m.connection_id = r.connection_id`,
          )
          .one(),
    );
    expect(stored).toEqual({
      api_key_header_name: "x-api-key",
      auth_kind: "api_key",
      client_id: "crewhelm:remote-mcp-api-key-handoff",
      credential_ciphertext: expect.any(String),
      credential_nonce: expect.any(String),
    });
    expect(JSON.stringify(stored)).not.toContain("private-api-key");
  });

  it("completes remote MCP OAuth in the browser without exposing stored credentials", async () => {
    const ownerKey = await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "remote-mcp-oauth-browser",
    });
    const authority = ownerAuthoritySchema.parse({
      clientId: "remote-mcp-oauth-browser-client",
      ownerKey,
      scopes: [
        AGENTS_WRITE_SCOPE,
        AUTONOMY_WRITE_SCOPE,
        CONNECTIONS_READ_SCOPE,
        CONNECTIONS_WRITE_SCOPE,
        OWNER_WRITE_SCOPE,
        RUNS_WRITE_SCOPE,
      ],
    });
    const controlPlane = env.OWNER_CONTROL_PLANE.getByName(ownerKey);
    const reservation = remoteMcpConnectionOperationResultSchema.parse(
      await controlPlane.reserveRemoteMcpOAuthSetup(authority, {
        action: "connect",
        authKind: "oauth",
        endpoint: "https://mcp.example.com/rpc",
        idempotencyKey: "remote-mcp-oauth-browser-connect",
        name: "OAuth Project MCP",
        oauthScopes: ["records.read"],
      }),
    );
    if (!reservation.ok || reservation.state !== "setup_required") {
      throw new Error("Expected OAuth setup reservation.");
    }

    const fetchMock = remoteMcpOAuthFetch();
    const setupResponse = await worker.fetch(new Request(reservation.setup.url), env);
    expect(setupResponse.status).toBe(302);
    expect(setupResponse.headers.get("cache-control")).toBe("no-store");
    expect(setupResponse.headers.get("referrer-policy")).toBe("no-referrer");
    const authorizationUrl = new URL(setupResponse.headers.get("location") ?? "");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("scope")).toBe("records.read");

    const callback = new URL(`${origin}/connections/remote-mcp/oauth/callback`);
    callback.searchParams.set("code", "browser-authorization-code");
    callback.searchParams.set("iss", "https://auth.example.com");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    const callbackResponse = await worker.fetch(new Request(callback), env);
    const callbackBody = await callbackResponse.text();
    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.headers.get("cache-control")).toBe("no-store");
    expect(callbackResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(callbackBody).toContain("OAuth Project MCP");
    expect(callbackBody).not.toContain("oauth-access-secret");

    const replay = remoteMcpConnectionOperationResultSchema.parse(
      await controlPlane.reserveRemoteMcpOAuthSetup(authority, {
        action: "connect",
        authKind: "oauth",
        endpoint: "https://mcp.example.com/rpc",
        idempotencyKey: "remote-mcp-oauth-browser-connect",
        name: "OAuth Project MCP",
        oauthScopes: ["records.read"],
      }),
    );
    expect(replay).toMatchObject({
      connection: { authKind: "oauth", oauthScopes: ["records.read"], status: "active" },
      created: false,
      ok: true,
      state: "connected",
    });
    if (!replay.ok || replay.state !== "connected") {
      throw new Error("Expected connected OAuth replay.");
    }

    const stored = await runInDurableObject(controlPlane, (_instance, state) =>
      state.storage.sql
        .exec(
          `SELECT credential_ciphertext, credential_nonce
           FROM remote_mcp_connections WHERE connection_id = ?`,
          replay.connection.connectionId,
        )
        .one(),
    );
    expect(stored).toEqual({
      credential_ciphertext: expect.any(String),
      credential_nonce: expect.any(String),
    });
    expect(JSON.stringify(stored)).not.toContain("oauth-access-secret");
    expect(JSON.stringify(stored)).not.toContain("oauth-refresh-secret");

    const agent = await controlPlane.createAgent(authority, {
      executionLimits: {
        maxDurationSeconds: 45,
        maxModelTokens: 2_000,
        maxToolCalls: 4,
        maxTurns: 4,
      },
      idempotencyKey: "remote-mcp-oauth-browser-agent",
      instructions: "Use the attached remote MCP tool.",
      name: "OAuth remote MCP Agent",
    });
    if (!agent.ok) throw new Error("Expected Agent creation.");
    const configured = await controlPlane.configureAgentRemoteMcpConnection(authority, {
      agentId: agent.agent.id,
      authorization: "standing",
      connectionId: replay.connection.connectionId,
      expectedRevision: agent.agent.revision,
      expiresAt: null,
      idempotencyKey: "remote-mcp-oauth-browser-attachment",
      limits: {
        maxCallsPerRun: 4,
        maxConcurrency: 1,
        maxCostMicrousdPerCall: 0,
        maxDurationMs: 10_000,
        maxOutputBytes: 32_000,
      },
      snapshotDigest: replay.connection.snapshotDigest,
    });
    if (!configured.ok) throw new Error("Expected remote MCP attachment.");
    const prompt = "Read OAuth records.";
    const admission = await controlPlane.createRunAdmission(authority, {
      agentId: configured.agent.id,
      expectedRevision: configured.agent.revision,
      idempotencyKey: "remote-mcp-oauth-browser-run",
      promptCharacters: prompt.length,
      promptDigest: await digest(prompt),
    });
    if (!admission.ok || admission.state !== "issued") {
      throw new Error("Expected OAuth remote MCP Run admission.");
    }
    await controlPlane.confirmRunAdmission(admission.permit);
    const grant = admission.permit.budgetReservation.toolGrants[0];
    if (grant?.capabilityId !== "remote_mcp.tool.execute") {
      throw new Error("Expected OAuth remote MCP grant.");
    }
    const action = {
      agentId: grant.agentId,
      agentRevision: grant.agentRevision,
      capabilityId: grant.capabilityId,
      connectionId: grant.connectionId,
      effect: grant.effect,
      estimatedCostMicrousd: 0 as const,
      grantId: grant.grantId,
      inputDigest: await digest("{}"),
      ownerKey: grant.ownerKey,
      runId: admission.permit.runId,
      snapshotDigest: grant.snapshotDigest,
      targetDigests: grant.targetDigests,
      toolCallId: `tool_call_${crypto.randomUUID()}`,
      toolName: grant.toolName,
    };
    const reserved = await controlPlane.reserveToolExecution({
      agentId: admission.permit.agentId,
      agentRevision: admission.permit.agentRevision,
      budgetReservation: admission.permit.budgetReservation,
      clientId: admission.permit.clientId,
      idempotencyKey: admission.permit.idempotencyKey,
      ownerKey: admission.permit.ownerKey,
      promptDigest: admission.permit.promptDigest,
      runId: admission.permit.runId,
      action,
    });
    if (!reserved.ok || reserved.state !== "allowed") {
      throw new Error("Expected OAuth remote MCP tool reservation.");
    }
    const refreshRequests = () =>
      fetchMock.mock.calls.filter(([, init]) => {
        const body = init?.body;
        return body instanceof URLSearchParams && body.get("grant_type") === "refresh_token";
      }).length;
    const refreshesBeforeForgedPermit = refreshRequests();
    await expect(
      controlPlane.executeRemoteMcpTool({
        arguments: {},
        permit: { ...reserved.permit, actionDigest: "a".repeat(43) },
      }),
    ).resolves.toEqual({
      dispatched: false,
      error: { code: "invalid_execution", message: "Tool execution denied." },
      ok: false,
    });
    expect(refreshRequests()).toBe(refreshesBeforeForgedPermit);

    const executed = await controlPlane.executeRemoteMcpTool({
      arguments: {},
      permit: reserved.permit,
    });
    expect(executed).toMatchObject({ ok: true });
    if (!executed.ok) throw new Error("Expected OAuth remote MCP execution.");
    expect(JSON.parse(executed.outputJson)).toMatchObject({
      content: [{ text: "refreshed:true", type: "text" }],
    });
    await expect(
      controlPlane.completeToolExecution({
        outcome: {
          outputBytes: encoder.encode(executed.outputJson).byteLength,
          status: "completed",
        },
        permit: reserved.permit,
      }),
    ).resolves.toEqual({ completed: true, ok: true });

    const reauthentication = remoteMcpConnectionOperationResultSchema.parse(
      await controlPlane.reserveRemoteMcpOAuthSetup(authority, {
        action: "reauthenticate",
        connectionId: replay.connection.connectionId,
        idempotencyKey: "remote-mcp-oauth-browser-reauthenticate",
        snapshotDigest: replay.connection.snapshotDigest,
      }),
    );
    if (!reauthentication.ok || reauthentication.state !== "setup_required") {
      throw new Error("Expected OAuth reauthentication setup.");
    }
    const reauthenticationSetup = await worker.fetch(new Request(reauthentication.setup.url), env);
    const reauthenticationAuthorization = new URL(
      reauthenticationSetup.headers.get("location") ?? "",
    );
    const reauthenticationCallback = new URL(`${origin}/connections/remote-mcp/oauth/callback`);
    reauthenticationCallback.searchParams.set("code", "reauthorization-code");
    reauthenticationCallback.searchParams.set("iss", "https://auth.example.com");
    reauthenticationCallback.searchParams.set(
      "state",
      reauthenticationAuthorization.searchParams.get("state") ?? "",
    );
    const reauthenticated = await worker.fetch(new Request(reauthenticationCallback), env);
    expect(reauthenticated.status).toBe(200);
    expect(await reauthenticated.text()).toContain("reauthenticated");
    await expect(
      controlPlane.inspectRemoteMcpConnection(authority, {
        connectionId: replay.connection.connectionId,
      }),
    ).resolves.toMatchObject({
      connection: {
        connectionId: replay.connection.connectionId,
        oauthScopes: ["records.read"],
        snapshotDigest: replay.connection.snapshotDigest,
        status: "active",
      },
      ok: true,
    });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            "SELECT connection_id, status FROM capability_grants WHERE grant_id = ?",
            grant.grantId,
          )
          .one(),
      ),
    ).resolves.toEqual({
      connection_id: replay.connection.connectionId,
      status: "active",
    });

    await expect(
      controlPlane.deleteRemoteMcpConnection(authority, {
        connectionId: replay.connection.connectionId,
        idempotencyKey: "remote-mcp-oauth-browser-delete",
        snapshotDigest: replay.connection.snapshotDigest,
      }),
    ).resolves.toEqual({ deleted: true, ok: true });
    await expect(
      runInDurableObject(controlPlane, (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT credential_ciphertext, credential_nonce
             FROM remote_mcp_connections WHERE connection_id = ?`,
            replay.connection.connectionId,
          )
          .one(),
      ),
    ).resolves.toEqual({ credential_ciphertext: null, credential_nonce: null });
    fetchMock.mockRestore();
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
