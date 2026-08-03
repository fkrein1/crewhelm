import type { RegistryEnv } from "./env.js";
import { publishBundle } from "./registry.js";
import { publishers, registryDatabase } from "./schema.js";
import { createRegistryServer } from "./server.js";
import { TESTING_SEED_ARTIFACT_VERSION, testingSeedBundles } from "./testing-seed.js";

type LocalBindings = Pick<
  RegistryEnv,
  "PUBLIC_API_PREFIX" | "PUBLIC_ORIGIN" | "REGISTRY_DB" | "REGISTRY_PACKAGES"
>;

const publisher = {
  displayName: "Crewhelm Development Seeds",
  githubUserId: 1,
  namespace: "crewhelm-labs",
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

function exactLoopback(request: Request, bindings: LocalBindings): boolean {
  try {
    return (
      bindings.PUBLIC_ORIGIN === "http://127.0.0.1:8788/" &&
      new URL(request.url).origin === "http://127.0.0.1:8788"
    );
  } catch {
    return false;
  }
}

export const localRegistry: ExportedHandler<LocalBindings> = {
  async fetch(request, bindings, context): Promise<Response> {
    if (!exactLoopback(request, bindings)) {
      return Response.json({ error: "local_environment_required" }, { status: 503 });
    }
    const env = environment(bindings);
    const url = new URL(request.url);
    if (url.pathname === "/development/seed") {
      if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
      }
      const now = Math.floor(Date.now() / 1_000);
      await registryDatabase(env.REGISTRY_DB)
        .insert(publishers)
        .values({
          createdAt: now,
          displayName: publisher.displayName,
          githubLogin: "crewhelm-development-seeds",
          githubUserId: publisher.githubUserId,
          namespace: publisher.namespace,
          profileUrl: null,
          status: "active",
          updatedAt: now,
        })
        .onConflictDoUpdate({
          set: { displayName: publisher.displayName, updatedAt: now },
          target: publishers.githubUserId,
        });
      const recipes = [];
      for (const bundle of await testingSeedBundles(env.PUBLIC_ORIGIN)) {
        const result = await publishBundle(env, publisher, bundle);
        if (result.recipe.artifact.version === TESTING_SEED_ARTIFACT_VERSION) {
          recipes.push(result.recipe.artifact.name);
        }
      }
      return Response.json({ namespace: publisher.namespace, recipes, seeded: recipes.length });
    }
    return createRegistryServer().fetch(
      publicRequest(request, bindings.PUBLIC_API_PREFIX),
      env,
      context,
    );
  },
};

export default localRegistry;
