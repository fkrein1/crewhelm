import { env } from "cloudflare:test";
import { OWNER_READ_SCOPE, OWNER_SCOPES } from "@crewhelm/contracts";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import type { WorkerEnv } from "../env.js";
import { createWorker } from "../http/server.js";
import { hasActiveClientRegistration, purgeExpiredAuthRecords } from "./server.js";
import { readAuthTestMigrations, registerAuthTestDatabase } from "./testkit.js";

const origin = "https://crewhelm.test";
const registrationSchema = z.looseObject({
  application_type: z.enum(["native", "web"]).optional(),
  client_id: z.string().min(1),
  token_endpoint_auth_method: z.literal("none"),
});

registerAuthTestDatabase();

function workerEnv(): WorkerEnv {
  return env;
}

async function register(
  redirectUris: string[],
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return createWorker().fetch(
    new Request(`${origin}/api/auth/oauth2/register`, {
      body: JSON.stringify({
        client_name: "<script>untrusted client</script>",
        grant_types: ["authorization_code"],
        redirect_uris: redirectUris,
        response_types: ["code"],
        scope: OWNER_READ_SCOPE,
        token_endpoint_auth_method: "none",
        ...extra,
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }),
    workerEnv(),
  );
}

async function registerRaw(body: string): Promise<Response> {
  return createWorker().fetch(
    new Request(`${origin}/api/auth/oauth2/register`, {
      body,
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    }),
    workerEnv(),
  );
}

function decodeStoredJson(value: unknown): unknown {
  let decoded = value;

  while (typeof decoded === "string") {
    decoded = JSON.parse(decoded);
  }

  return decoded;
}

describe("OAuth server boundary", () => {
  it.each([
    "https://client.example/oauth/callback",
    "http://localhost:43123/oauth/callback",
    "http://127.0.0.1:43123/oauth/callback",
    "http://[::1]:43123/oauth/callback",
  ])("registers a leased public client with a safe redirect: %s", async (redirectUri) => {
    const response = await register([redirectUri]);
    const registration = registrationSchema.parse(await response.json());

    expect(response.status).toBe(201);
    expect(await hasActiveClientRegistration(workerEnv(), registration.client_id)).toBe(true);
    const resources = await workerEnv()
      .AUTH_DB.prepare(`SELECT "resourceId" FROM "oauthClientResource" WHERE "clientId" = ?`)
      .bind(registration.client_id)
      .all();
    expect(resources.results).toEqual([{ resourceId: `${origin}/mcp` }]);
    const resource = await workerEnv()
      .AUTH_DB.prepare(`SELECT "allowedScopes" FROM "oauthResource" WHERE "identifier" = ?`)
      .bind(`${origin}/mcp`)
      .first();
    expect(resource).not.toBeNull();
    expect(JSON.parse(JSON.parse(String(resource?.allowedScopes)))).toEqual([...OWNER_SCOPES]);
  });

  it("normalizes Codex native client metadata without enabling refresh grants", async () => {
    const response = await register(["http://127.0.0.1:43123/callback/crewhelm"], {
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
    });
    const registration = registrationSchema.parse(await response.json());

    expect(response.status).toBe(201);
    expect(await hasActiveClientRegistration(workerEnv(), registration.client_id)).toBe(true);
    const client = await workerEnv()
      .AUTH_DB.prepare(`SELECT "grantTypes", "metadata" FROM "oauthClient" WHERE "clientId" = ?`)
      .bind(registration.client_id)
      .first();
    const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
    authorize.searchParams.set("client_id", registration.client_id);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1:43123/callback/crewhelm");
    authorize.searchParams.set("resource", `${origin}/mcp`);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", OWNER_READ_SCOPE);
    const authorizeWithoutPkce = await createWorker().fetch(new Request(authorize), workerEnv());

    expect(registration.application_type).toBe("native");
    expect(JSON.parse(JSON.parse(String(client?.grantTypes)))).toEqual(["authorization_code"]);
    expect(decodeStoredJson(client?.metadata)).toEqual({
      application_type: "native",
      resources: [`${origin}/mcp`],
    });
    expect(authorizeWithoutPkce.status).toBe(400);
    await expect(authorizeWithoutPkce.json()).resolves.toMatchObject({ error: "invalid_request" });
    const refreshAttempt = await createWorker().fetch(
      new Request(`${origin}/api/auth/oauth2/token`, {
        body: new URLSearchParams({
          client_id: registration.client_id,
          grant_type: "refresh_token",
          refresh_token: "unsupported",
          resource: `${origin}/mcp`,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      workerEnv(),
    );

    expect(refreshAttempt.status).toBe(400);
    await expect(refreshAttempt.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it("requires an HTTPS redirect for an explicit web client", async () => {
    const accepted = await register(["https://web-client.example/callback"], {
      application_type: "web",
    });
    const rejected = await register(["http://127.0.0.1:43123/callback"], {
      application_type: "web",
    });

    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({ application_type: "web" });
    expect(rejected.status).toBe(400);
  });

  it("ignores harmless unknown client metadata instead of forwarding it", async () => {
    const response = await register(["https://client.example/callback"], {
      harmless_extension: { enabled: true },
    });
    const registration = registrationSchema.parse(await response.json());
    const client = await workerEnv()
      .AUTH_DB.prepare(`SELECT "metadata" FROM "oauthClient" WHERE "clientId" = ?`)
      .bind(registration.client_id)
      .first();

    expect(response.status).toBe(201);
    expect(registration).not.toHaveProperty("harmless_extension");
    expect(decodeStoredJson(client?.metadata)).toEqual({
      resources: [`${origin}/mcp`],
    });
  });

  it.each([
    `{"application_type":"web","application_type":"native","redirect_uris":["http://127.0.0.1:43123/callback"]}`,
    `{"application_type":"web","application_\\u0074ype":"native","redirect_uris":["http://127.0.0.1:43123/callback"]}`,
    `{"grant_types":["client_credentials"],"grant_types":["authorization_code"],"redirect_uris":["https://client.example/callback"]}`,
    `{"redirect_uris":["https://first.example/callback"],"redirect_uris":["https://second.example/callback"]}`,
  ])("rejects duplicate raw registration object members", async (body) => {
    const response = await registerRaw(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client_metadata",
      error_description: "Client registration denied.",
    });
  });

  it("widens the seeded MCP resource through idempotent D1 scope migrations", async () => {
    const registration = registrationSchema.parse(
      await (await register(["https://migration-client.example/callback"])).json(),
    );
    const oldStoredScopes = JSON.stringify(JSON.stringify([OWNER_READ_SCOPE]));

    await workerEnv()
      .AUTH_DB.prepare(
        `UPDATE "oauthResource"
         SET "allowedScopes" = ?
         WHERE "identifier" = ?`,
      )
      .bind(oldStoredScopes, `${origin}/mcp`)
      .run();
    const migrations = readAuthTestMigrations().filter(
      (candidate) =>
        candidate.name === "0002_control_write_scope.sql" ||
        candidate.name === "0003_integration_catalog_scope.sql" ||
        candidate.name === "0004_agent_definition_read_scope.sql" ||
        candidate.name === "0005_agent_update_scope.sql" ||
        candidate.name === "0006_connection_write_scope.sql" ||
        candidate.name === "0007_connection_read_scope.sql" ||
        candidate.name === "0008_connection_config_read_scope.sql",
    );

    expect(migrations.map((migration) => migration.name)).toEqual([
      "0002_control_write_scope.sql",
      "0003_integration_catalog_scope.sql",
      "0004_agent_definition_read_scope.sql",
      "0005_agent_update_scope.sql",
      "0006_connection_write_scope.sql",
      "0007_connection_read_scope.sql",
      "0008_connection_config_read_scope.sql",
    ]);
    for (const migration of migrations) {
      for (const query of migration.queries) {
        await workerEnv().AUTH_DB.prepare(query).run();
      }
      for (const query of migration.queries) {
        await workerEnv().AUTH_DB.prepare(query).run();
      }
    }

    const resource = await workerEnv()
      .AUTH_DB.prepare(`SELECT "allowedScopes" FROM "oauthResource" WHERE "identifier" = ?`)
      .bind(`${origin}/mcp`)
      .first();
    const client = await workerEnv()
      .AUTH_DB.prepare(`SELECT "scopes" FROM "oauthClient" WHERE "clientId" = ?`)
      .bind(registration.client_id)
      .first();

    expect(JSON.parse(JSON.parse(String(resource?.allowedScopes)))).toEqual([...OWNER_SCOPES]);
    expect(JSON.parse(JSON.parse(String(client?.scopes)))).toEqual([OWNER_READ_SCOPE]);
  });

  it.each([
    "http://client.example/oauth/callback",
    "custom-scheme://oauth/callback",
    "https://user:password@client.example/oauth/callback",
    "https://client.example/oauth/callback#fragment",
  ])("rejects an unsafe OAuth redirect: %s", async (redirectUri) => {
    const response = await register([redirectUri]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client_metadata",
      error_description: "Client registration denied.",
    });
  });

  it("rejects more than eight OAuth redirects", async () => {
    const response = await register(
      Array.from({ length: 9 }, (_, index) => `https://client${index}.example/callback`),
    );

    expect(response.status).toBe(400);
  });

  it.each([
    { backchannel_logout_uri: "https://client.example/logout" },
    { dpop_bound_access_tokens: true },
    { application_type: "service" },
    { grant_types: ["authorization_code", "client_credentials"] },
    { grant_types: ["authorization_code", "refresh_token", "refresh_token"] },
  ])("rejects unsupported provider registration metadata: %j", async (metadata) => {
    const response = await register(["https://client.example/callback"], metadata);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_client_metadata",
      error_description: "Client registration denied.",
    });
  });

  it("requires an active registration lease before authorization", async () => {
    const response = await createWorker().fetch(
      new Request(`${origin}/api/auth/oauth2/authorize?client_id=missing&response_type=code`),
      workerEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
  });

  it.each([undefined, "https://other.example/mcp"])(
    "requires the exact MCP resource during authorization: %s",
    async (resource) => {
      const registration = registrationSchema.parse(
        await (await register(["https://client.example/callback"])).json(),
      );
      const authorize = new URL(`${origin}/api/auth/oauth2/authorize`);
      authorize.searchParams.set("client_id", registration.client_id);
      authorize.searchParams.set("code_challenge", "A".repeat(43));
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("redirect_uri", "https://client.example/callback");
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", OWNER_READ_SCOPE);

      if (resource !== undefined) {
        authorize.searchParams.set("resource", resource);
      }

      const response = await createWorker().fetch(new Request(authorize), workerEnv());

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_request" });
    },
  );

  it("publishes OAuth authorization-server metadata for MCP discovery", async () => {
    const response = await createWorker().fetch(
      new Request(`${origin}/.well-known/oauth-authorization-server/api/auth`),
      workerEnv(),
    );
    const metadata: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(metadata).toMatchObject({
      authorization_endpoint: `${origin}/api/auth/oauth2/authorize`,
      grant_types_supported: ["authorization_code"],
      issuer: `${origin}/api/auth`,
      registration_endpoint: `${origin}/api/auth/oauth2/register`,
      scopes_supported: [...OWNER_SCOPES],
      token_endpoint: `${origin}/api/auth/oauth2/token`,
    });
  });

  it("returns a protocol 4xx for an invalid authorization code", async () => {
    const registration = registrationSchema.parse(
      await (await register(["https://client.example/callback"])).json(),
    );
    const response = await createWorker().fetch(
      new Request(`${origin}/api/auth/oauth2/token`, {
        body: new URLSearchParams({
          client_id: registration.client_id,
          code: "invalid-code",
          code_verifier: "A".repeat(43),
          grant_type: "authorization_code",
          redirect_uri: "https://client.example/callback",
          resource: `${origin}/mcp`,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      }),
      workerEnv(),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    await expect(response.json()).resolves.toMatchObject({
      error_description: "OAuth request denied.",
    });
  });

  it("purges expired auth state and leased clients", async () => {
    const registration = registrationSchema.parse(
      await (await register(["https://client.example/callback"])).json(),
    );
    const activeRegistration = registrationSchema.parse(
      await (await register(["https://active-client.example/callback"])).json(),
    );
    await workerEnv()
      .AUTH_DB.prepare(`UPDATE "mcpClientRegistration" SET "expiresAt" = 0 WHERE "clientId" = ?`)
      .bind(registration.client_id)
      .run();
    await workerEnv()
      .AUTH_DB.prepare(
        `INSERT INTO "verification"
          ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
         VALUES ('expired-verification', 'expired', 'expired', 0, 0, 0)`,
      )
      .run();
    await workerEnv()
      .AUTH_DB.prepare(
        `INSERT INTO "oauthClientAssertion" ("id", "expiresAt")
         VALUES ('expired-assertion', 0)`,
      )
      .run();

    await purgeExpiredAuthRecords(workerEnv());

    expect(await hasActiveClientRegistration(workerEnv(), registration.client_id)).toBe(false);
    expect(await hasActiveClientRegistration(workerEnv(), activeRegistration.client_id)).toBe(true);
    const rows = await workerEnv()
      .AUTH_DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM "oauthClient" WHERE "clientId" = ?) AS "clients",
          (SELECT COUNT(*) FROM "verification" WHERE "id" = 'expired-verification')
            AS "verifications",
          (SELECT COUNT(*) FROM "oauthClientAssertion" WHERE "id" = 'expired-assertion')
            AS "assertions"`,
      )
      .bind(registration.client_id)
      .first();
    expect(rows).toEqual({
      assertions: 0,
      clients: 0,
      verifications: 0,
    });
    const activeRows = await workerEnv()
      .AUTH_DB.prepare(
        `SELECT
          (SELECT COUNT(*) FROM "oauthClient" WHERE "clientId" = ?) AS "clients",
          (SELECT COUNT(*) FROM "oauthClientResource" WHERE "clientId" = ?) AS "resources"`,
      )
      .bind(activeRegistration.client_id, activeRegistration.client_id)
      .first();
    expect(activeRows).toEqual({
      clients: 1,
      resources: 1,
    });
  });

  it("bounds chunked OAuth bodies before Better Auth parses them", async () => {
    const response = await createWorker().fetch(
      new Request(`${origin}/api/auth/oauth2/register`, {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(8 * 1024 + 1));
            controller.close();
          },
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      }),
      workerEnv(),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_too_large" });
  });
});
