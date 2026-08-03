import { applyD1Migrations, env, SELF } from "cloudflare:test";
import {
  recipeRegistryProjectionSchema,
  registryArtifactVersionEnvelopeSchema,
  registryPublishResultSchema,
  registryRecipeSearchResponseSchema,
} from "@crewhelm/contracts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { canonicalPackage, packageObjectKey, sha256Hex } from "./packages.js";
import { recipeFixture, skillFixture } from "./fixtures.test-double.js";
import {
  cleanupExpiredPublishIntents,
  publishBundle,
  searchRecipes,
  type RegistrySearchEnv,
} from "./registry.js";

const session = "test-publisher-session";

beforeAll(async () => {
  await applyD1Migrations(env.REGISTRY_DB, env.TEST_MIGRATIONS);
  const now = Math.floor(Date.now() / 1_000);
  await env.REGISTRY_DB.batch([
    env.REGISTRY_DB.prepare(
      `INSERT INTO publishers
        (github_user_id, github_login, namespace, display_name, profile_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(123, "octocat", "octocat", "The Octocat", "https://github.com/octocat", now, now),
    env.REGISTRY_DB.prepare(
      "INSERT INTO publisher_sessions (token_hash, github_user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256Hex(new TextEncoder().encode(session)), 123, now + 3_600, now),
  ]);
});

describe("public Recipe Registry", () => {
  it("uses the same-origin gateway callback for GitHub OAuth", async () => {
    const response = await SELF.fetch(
      "https://registry.crewhelm.test/auth/github/start?return_to=/publish",
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get("location") ?? "https://invalid.test");
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://registry.crewhelm.test/api/registry/auth/github/callback",
    );
    const oauthState = authorization.searchParams.get("state");
    expect(oauthState).not.toBeNull();
    expect(response.headers.get("set-cookie")).toContain("crewhelm_registry_oauth_state=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const unboundCallback = await SELF.fetch(
      `https://registry.crewhelm.test/auth/github/callback?code=attacker&state=${encodeURIComponent(oauthState ?? "")}`,
    );
    expect(unboundCallback.status).toBe(404);

    const hostile = await SELF.fetch(
      "https://registry.crewhelm.test/auth/github/start?return_to=/%5Cevil.example/path",
      { redirect: "manual" },
    );
    expect(hostile.status).toBe(302);
    const state = await env.REGISTRY_DB.prepare(
      "SELECT return_to FROM oauth_states ORDER BY rowid DESC LIMIT 1",
    ).first<{ return_to: string }>();
    expect(state?.return_to).toBe("/publish");
  });

  it("bounds a chunked GitHub response before buffering it", async () => {
    const start = await SELF.fetch("https://registry.crewhelm.test/auth/github/start", {
      redirect: "manual",
    });
    const authorization = new URL(start.headers.get("location") ?? "https://invalid.test");
    const oauthState = authorization.searchParams.get("state");
    const cookie = start.headers
      .get("set-cookie")
      ?.match(/crewhelm_registry_oauth_state=([^;]+)/u)?.[1];
    if (!oauthState || !cookie) throw new Error("Expected browser-bound OAuth state.");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10_000));
        controller.enqueue(new Uint8Array(10_000));
        controller.close();
      },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status: 200 }));

    const callback = await SELF.fetch(
      `https://registry.crewhelm.test/auth/github/callback?code=test&state=${encodeURIComponent(oauthState)}`,
      { headers: { cookie: `crewhelm_registry_oauth_state=${cookie}` } },
    );

    expect(callback.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("publishes immutable bytes and discovers the public outcome without telemetry", async () => {
    const body = {
      idempotencyKey: "c9ed38bf-3b48-4ec7-86fd-d5f854237589",
      namespace: "octocat",
      recipe: { package: recipeFixture(), version: 1 },
      skills: [],
    };
    const publish = await SELF.fetch("https://registry.crewhelm.test/v1/publish", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: `crewhelm_registry_session=${session}`,
        origin: "https://registry.crewhelm.test",
      },
      method: "POST",
    });
    expect(publish.status).toBe(201);
    const publicationBody: unknown = await publish.json();
    const publication = registryPublishResultSchema.parse(publicationBody);
    expect(publication.semanticIndex).toBe("pending");
    expect(publication.artifacts).toHaveLength(1);

    const latest = await SELF.fetch(
      "https://registry.crewhelm.test/v1/recipes/octocat/research-brief-steward",
    );
    expect(latest.status).toBe(200);
    expect(latest.headers.get("cache-control")).toContain("s-maxage=600");
    const latestBody: unknown = await latest.json();
    expect(recipeRegistryProjectionSchema.parse(latestBody)).toMatchObject({
      outcome: expect.stringContaining("evidence-backed brief"),
      publisher: { namespace: "octocat" },
    });

    const envelopeResponse = await SELF.fetch(
      "https://registry.crewhelm.test/v1/artifacts/recipe/octocat/research-brief-steward/1",
    );
    const exactBody: unknown = await envelopeResponse.json();
    const exact = z
      .strictObject({ envelope: registryArtifactVersionEnvelopeSchema, projection: z.unknown() })
      .parse(exactBody);
    expect(exact.envelope.publishedAt).toBe(publication.artifacts[0]?.publishedAt);
    const object = await env.REGISTRY_PACKAGES.get(packageObjectKey(exact.envelope));
    if (!object) throw new Error("Expected the immutable R2 object.");
    expect(new Uint8Array(await object.arrayBuffer())).toEqual(
      canonicalPackage(body.recipe.package),
    );

    const packageResponse = await SELF.fetch(
      "https://registry.crewhelm.test/v1/artifacts/recipe/octocat/research-brief-steward/1/package",
    );
    expect(packageResponse.headers.get("cache-control")).toContain("immutable");
    const firstArtifact = publication.artifacts[0];
    if (!firstArtifact) throw new Error("Expected the Recipe artifact.");
    expect(packageResponse.headers.get("etag")).toBe(`"${firstArtifact.package.digest}"`);

    const search = await SELF.fetch(
      "https://registry.crewhelm.test/v1/recipes/search?q=decision-ready%20research&limit=10",
    );
    expect(search.status).toBe(200);
    const searchBody: unknown = await search.json();
    expect(registryRecipeSearchResponseSchema.parse(searchBody)).toMatchObject({
      results: [{ recipe: { title: "Research Brief Steward" } }],
      retrieval: "lexical_fallback",
      searchVersion: 1,
    });

    const semanticEnv = {
      AI: {
        run: async () => ({ data: [Array.from({ length: 384 }, () => 0.01)] }),
      },
      RECIPE_SEARCH_INDEX: {
        query: async () => ({
          count: 1,
          matches: [
            {
              id: "recipe:octocat:research-brief-steward",
              metadata: { name: "research-brief-steward", namespace: "octocat", version: 1 },
              score: 0.91,
              values: [],
            },
          ],
        }),
        upsert: async () => undefined,
      },
      REGISTRY_DB: env.REGISTRY_DB,
    } satisfies RegistrySearchEnv;
    await expect(
      searchRecipes(semanticEnv, "help me research a decision", 10),
    ).resolves.toMatchObject({
      results: [{ recipe: { title: "Research Brief Steward" }, score: 0.91 }],
      retrieval: "semantic",
    });

    const replay = await SELF.fetch("https://registry.crewhelm.test/v1/publish", {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: `crewhelm_registry_session=${session}`,
        origin: "https://registry.crewhelm.test",
      },
      method: "POST",
    });
    expect(replay.status).toBe(201);
    const count = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM artifact_versions",
    ).first<{ count: number }>();
    expect(count?.count).toBe(1);
    const pending = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM publish_upload_intents",
    ).first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("caps a streaming publish body before buffering the complete request", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(900_000));
        controller.enqueue(new Uint8Array(900_000));
        controller.close();
      },
    });
    const request = new Request("https://registry.crewhelm.test/v1/publish", {
      body,
      headers: {
        "content-type": "application/json",
        cookie: `crewhelm_registry_session=${session}`,
        origin: "https://registry.crewhelm.test",
      },
      method: "POST",
    });
    const response = await SELF.fetch(request);

    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("resumes an upload intent after object storage fails", async () => {
    const recipe = recipeFixture();
    recipe.name = "interrupted-publication";
    const body = {
      idempotencyKey: "8ecb1818-7533-48e5-a05b-167868248a8d",
      namespace: "octocat",
      recipe: { package: recipe, version: 1 },
      skills: [],
    };
    const failingEnv = new Proxy(env, {
      get(target, property, receiver) {
        if (property !== "REGISTRY_PACKAGES") return Reflect.get(target, property, receiver);
        return new Proxy(target.REGISTRY_PACKAGES, {
          get(bucket, method, bucketReceiver) {
            if (method === "put") return async () => Promise.reject(new Error("injected outage"));
            const value: unknown = Reflect.get(bucket, method, bucketReceiver);
            return typeof value === "function" ? value.bind(bucket) : value;
          },
        });
      },
    });
    const publisher = {
      displayName: "The Octocat",
      githubUserId: 123,
      namespace: "octocat",
      profileUrl: "https://github.com/octocat",
    };

    await expect(publishBundle(failingEnv, publisher, body)).rejects.toThrow("injected outage");
    const retained = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM publish_upload_intents WHERE github_user_id = ? AND idempotency_key = ?",
    )
      .bind(123, body.idempotencyKey)
      .first<{ count: number }>();
    expect(retained?.count).toBe(1);

    const publication = await publishBundle(env, publisher, body);
    expect(publication.recipe.artifact.name).toBe("interrupted-publication");
    const pending = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM publish_upload_intents WHERE github_user_id = ? AND idempotency_key = ?",
    )
      .bind(123, body.idempotencyKey)
      .first<{ count: number }>();
    expect(pending?.count).toBe(0);
    const usage = await env.REGISTRY_DB.prepare(
      "SELECT artifact_count FROM publisher_daily_usage WHERE github_user_id = ?",
    )
      .bind(123)
      .first<{ artifact_count: number }>();
    expect(usage?.artifact_count).toBe(2);
  });

  it("denies cross-origin publishing before parsing untrusted bytes", async () => {
    const response = await SELF.fetch("https://registry.crewhelm.test/v1/publish", {
      body: "{}",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a public Skill that appears to contain a secret", async () => {
    const skill = skillFixture();
    skill.provenance = {
      kind: "web",
      source: "https://example.com/token/not-a-real-secret-value",
    };
    const response = await SELF.fetch("https://registry.crewhelm.test/v1/publish", {
      body: JSON.stringify({
        idempotencyKey: "7be0e202-b731-43a8-b777-cfe1d60c1bd2",
        namespace: "octocat",
        recipe: { package: recipeFixture(), version: 2 },
        skills: [{ package: skill, version: 1 }],
      }),
      headers: {
        "content-type": "application/json",
        cookie: `crewhelm_registry_session=${session}`,
        origin: "https://registry.crewhelm.test",
      },
      method: "POST",
    });
    expect(response.status).toBe(403);
    const count = await env.REGISTRY_DB.prepare(
      "SELECT COUNT(*) AS count FROM artifact_versions WHERE name = ?",
    )
      .bind("evidence-review")
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("removes exact objects retained by an expired publication intent", async () => {
    const digest = "c".repeat(64);
    const key = `v1/recipe/octocat/expired-upload/1/${digest}.json`;
    const now = Math.floor(Date.now() / 1_000);
    await env.REGISTRY_PACKAGES.put(key, "{}", { customMetadata: { digest } });
    await env.REGISTRY_DB.batch([
      env.REGISTRY_DB.prepare(
        `INSERT INTO publish_upload_intents
          (github_user_id, idempotency_key, request_digest, response_json, artifact_count,
           byte_count, usage_day, touched_at, phase, lease_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', NULL)`,
      ).bind(
        123,
        "3e1759a2-1e54-4606-a9cd-7c8d67ec5f37",
        "d".repeat(64),
        "{}",
        1,
        2,
        "2026-08-02",
        now - 7_200,
      ),
      env.REGISTRY_DB.prepare(
        `INSERT INTO publish_upload_artifacts
          (github_user_id, idempotency_key, kind, namespace, name, version, digest, object_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        123,
        "3e1759a2-1e54-4606-a9cd-7c8d67ec5f37",
        "recipe",
        "octocat",
        "expired-upload",
        1,
        digest,
        key,
      ),
    ]);

    await expect(cleanupExpiredPublishIntents(env, now)).resolves.toBe(0);
    await expect(env.REGISTRY_PACKAGES.head(key)).resolves.not.toBeNull();
    const quarantined = await env.REGISTRY_DB.prepare(
      "SELECT phase FROM publish_upload_intents WHERE github_user_id = ? AND idempotency_key = ?",
    )
      .bind(123, "3e1759a2-1e54-4606-a9cd-7c8d67ec5f37")
      .first<{ phase: string }>();
    expect(quarantined?.phase).toBe("quarantine");

    await env.REGISTRY_PACKAGES.put(key, '{"late":true}', { customMetadata: { digest } });
    await expect(cleanupExpiredPublishIntents(env, now + 7_200)).resolves.toBe(1);
    await expect(env.REGISTRY_PACKAGES.head(key)).resolves.toBeNull();
    const intent = await env.REGISTRY_DB.prepare(
      "SELECT 1 AS present FROM publish_upload_intents WHERE github_user_id = ? AND idempotency_key = ?",
    )
      .bind(123, "3e1759a2-1e54-4606-a9cd-7c8d67ec5f37")
      .first<{ present: number }>();
    expect(intent).toBeNull();
  });

  it("does not clean objects protected by an active finalization lease", async () => {
    const digest = "e".repeat(64);
    const key = `v1/recipe/octocat/finalizing-upload/1/${digest}.json`;
    const now = Math.floor(Date.now() / 1_000);
    const idempotencyKey = "4ef755bf-2089-4bc5-85d9-b2e571d63dd7";
    await env.REGISTRY_PACKAGES.put(key, "{}", { customMetadata: { digest } });
    await env.REGISTRY_DB.batch([
      env.REGISTRY_DB.prepare(
        `INSERT INTO publish_upload_intents
          (github_user_id, idempotency_key, request_digest, response_json, artifact_count,
           byte_count, usage_day, touched_at, phase, lease_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'finalizing', NULL)`,
      ).bind(123, idempotencyKey, "f".repeat(64), "{}", 1, 2, "2026-08-02", now),
      env.REGISTRY_DB.prepare(
        `INSERT INTO publish_upload_artifacts
          (github_user_id, idempotency_key, kind, namespace, name, version, digest, object_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(123, idempotencyKey, "recipe", "octocat", "finalizing-upload", 1, digest, key),
    ]);

    await expect(cleanupExpiredPublishIntents(env, now)).resolves.toBe(0);
    await expect(env.REGISTRY_PACKAGES.head(key)).resolves.not.toBeNull();

    await expect(cleanupExpiredPublishIntents(env, now + 7_200)).resolves.toBe(0);
    await expect(env.REGISTRY_PACKAGES.head(key)).resolves.not.toBeNull();
    await expect(cleanupExpiredPublishIntents(env, now + 14_400)).resolves.toBe(1);
    await expect(env.REGISTRY_PACKAGES.head(key)).resolves.toBeNull();
  });
});
