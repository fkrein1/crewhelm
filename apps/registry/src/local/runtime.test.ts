import { registryPublishAuthorizationSchema } from "@crewhelm/contracts";
import { applyD1Migrations, createExecutionContext, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { localRegistry } from "../local.js";
import { sha256Hex } from "../packages.js";

function environment(): Parameters<NonNullable<typeof localRegistry.fetch>>[1] {
  return {
    ...env,
    PUBLIC_ORIGIN: "http://127.0.0.1:8788/",
  };
}

describe("local Registry", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.REGISTRY_DB, env.TEST_MIGRATIONS);
    const now = Math.floor(Date.now() / 1_000);
    await env.REGISTRY_DB.prepare(
      `INSERT INTO publishers
        (github_user_id, github_login, namespace, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(1, "crewhelm-development-seeds", "crewhelm-labs", "Crewhelm Development", now, now)
      .run();
  });

  it("serves health only at the exact loopback origin", async () => {
    const context = createExecutionContext();
    const accepted = await localRegistry.fetch!(
      new Request("http://127.0.0.1:8788/health"),
      environment(),
      context,
    );
    const denied = await localRegistry.fetch!(
      new Request("http://localhost:8788/health"),
      environment(),
      context,
    );

    expect(accepted.status).toBe(200);
    expect(denied.status).toBe(503);
  });

  it("authorizes only the loopback publication flow without GitHub OAuth", async () => {
    const verifier = "local-publishing-verifier-with-more-than-forty-three-characters";
    const created = await localRegistry.fetch!(
      new Request("http://127.0.0.1:8788/api/registry/v1/publish/authorizations", {
        body: JSON.stringify({
          challenge: await sha256Hex(new TextEncoder().encode(verifier)),
          idempotencyKey: "00000000-0000-4000-8000-000000000003",
          installationLabel: "Local Crewhelm",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      environment(),
      createExecutionContext(),
    );
    expect(created.status).toBe(201);
    const authorization = registryPublishAuthorizationSchema.parse(await created.json());
    const resolved = await localRegistry.fetch!(
      new Request(
        `http://127.0.0.1:8788/api/registry/v1/publish/authorizations/${authorization.id}/resolve`,
        {
          body: JSON.stringify({ verifier }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      ),
      environment(),
      createExecutionContext(),
    );
    expect(resolved.status).toBe(200);
    await expect(resolved.json()).resolves.toMatchObject({
      publisher: { namespace: "crewhelm-labs" },
    });
  });
});
