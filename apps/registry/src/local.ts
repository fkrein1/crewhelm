import { registryPublishAuthorizationIdSchema } from "@crewhelm/contracts";
import { and, eq, gte } from "drizzle-orm";

import type { RegistryEnv } from "./env.js";
import { localCatalogStressDefinitionsA } from "./local-catalog-stress-seed-a.js";
import { localCatalogStressDefinitionsB } from "./local-catalog-stress-seed-b.js";
import { publishBundle } from "./registry.js";
import { publishAuthorizations, publishers, registryDatabase } from "./schema.js";
import { createRegistryServer } from "./server.js";
import {
  localCatalogStressSeedBundles,
  TESTING_SEED_ARTIFACT_VERSION,
  testingSeedBundles,
} from "./testing-seed.js";

type LocalBindings = Pick<
  RegistryEnv,
  "PUBLIC_API_PREFIX" | "PUBLIC_ORIGIN" | "REGISTRY_DB" | "REGISTRY_PACKAGES"
>;

const publisher = {
  displayName: "Crewhelm Development Seeds",
  githubUserId: 1,
  githubLogin: "crewhelm-development-seeds",
  namespace: "crewhelm-labs",
};
const stressPublisher = {
  displayName: "Crewhelm Catalog Stress Seeds",
  githubUserId: 2,
  githubLogin: "crewhelm-catalog-stress-seeds",
  namespace: "crewhelm-stress",
};
const allowAll: RateLimit = { limit: () => Promise.resolve({ success: true }) };
const unavailableAi = {
  run: () => Promise.reject(new Error("Semantic search is disabled locally.")),
};
const unavailableIndex = {
  query: () => Promise.reject(new Error("Semantic search is disabled locally.")),
  upsert: () => Promise.reject(new Error("Semantic search is disabled locally.")),
};

function environment(bindings: LocalBindings): RegistryEnv {
  return {
    ...bindings,
    AI: unavailableAi,
    GITHUB_CLIENT_ID: "local-disabled",
    GITHUB_CLIENT_SECRET: "local-disabled",
    PUBLIC_READ_RATE_LIMIT: allowAll,
    PUBLISH_RATE_LIMIT: allowAll,
    RECIPE_SEARCH_INDEX: unavailableIndex,
    SEARCH_RATE_LIMIT: allowAll,
  };
}

function publicRequest(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith(`${prefix}/`)) url.pathname = url.pathname.slice(prefix.length);
  return new Request(url, request);
}

function internalPath(request: Request, prefix: string): string {
  const pathname = new URL(request.url).pathname;
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length) : pathname;
}

function localEnvironment(bindings: LocalBindings): boolean {
  return bindings.PUBLIC_ORIGIN === "http://127.0.0.1:8788/";
}

export const localRegistry: ExportedHandler<LocalBindings> = {
  async fetch(request, bindings, context): Promise<Response> {
    if (!localEnvironment(bindings)) {
      return Response.json({ error: "local_environment_required" }, { status: 503 });
    }
    const env = environment(bindings);
    const url = new URL(request.url);
    const stressOnly = url.pathname === "/development/seed/stress";
    if (url.pathname === "/development/seed" || stressOnly) {
      if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
      }
      const now = Math.floor(Date.now() / 1_000);
      for (const seedPublisher of stressOnly ? [stressPublisher] : [publisher, stressPublisher]) {
        await registryDatabase(env.REGISTRY_DB)
          .insert(publishers)
          .values({
            createdAt: now,
            displayName: seedPublisher.displayName,
            githubLogin: seedPublisher.githubLogin,
            githubUserId: seedPublisher.githubUserId,
            namespace: seedPublisher.namespace,
            profileUrl: null,
            status: "active",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: {
              displayName: seedPublisher.displayName,
              githubLogin: seedPublisher.githubLogin,
              updatedAt: now,
            },
            target: publishers.githubUserId,
          });
      }
      const recipes = [];
      if (!stressOnly) {
        for (const bundle of await testingSeedBundles(env.PUBLIC_ORIGIN)) {
          const result = await publishBundle(env, publisher, bundle);
          if (result.recipe.artifact.version === TESTING_SEED_ARTIFACT_VERSION) {
            recipes.push(result.recipe.artifact.name);
          }
        }
      }
      const stressDefinitions = [
        ...localCatalogStressDefinitionsA,
        ...localCatalogStressDefinitionsB,
      ];
      for (const bundle of await localCatalogStressSeedBundles(
        env.PUBLIC_ORIGIN,
        stressDefinitions,
      )) {
        const result = await publishBundle(env, stressPublisher, bundle);
        recipes.push(result.recipe.artifact.name);
      }
      return Response.json({
        namespace: stressOnly ? stressPublisher.namespace : publisher.namespace,
        recipes,
        seeded: recipes.length,
      });
    }
    const resolveMatch = internalPath(request, bindings.PUBLIC_API_PREFIX).match(
      /^\/v1\/publish\/authorizations\/([^/]+)\/resolve$/u,
    );
    if (request.method === "POST" && resolveMatch?.[1] !== undefined) {
      const authorizationId = registryPublishAuthorizationIdSchema.safeParse(resolveMatch[1]);
      if (authorizationId.success) {
        const now = Math.floor(Date.now() / 1_000);
        await registryDatabase(env.REGISTRY_DB)
          .update(publishAuthorizations)
          .set({ authorizedAt: now, githubUserId: publisher.githubUserId })
          .where(
            and(
              eq(publishAuthorizations.authorizationId, authorizationId.data),
              gte(publishAuthorizations.expiresAt, now),
            ),
          );
      }
    }
    return createRegistryServer().fetch(
      publicRequest(request, bindings.PUBLIC_API_PREFIX),
      env,
      context,
    );
  },
};

export default localRegistry;
