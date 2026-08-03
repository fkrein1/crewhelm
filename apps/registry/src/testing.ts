import type { RegistryEnv } from "./env.js";
import { runRegistryMaintenance } from "./maintenance.js";
import { publishBundle } from "./registry.js";
import { publishers, registryDatabase } from "./schema.js";
import { createRegistryServer } from "./server.js";
import { TESTING_SEED_ARTIFACT_VERSION, testingSeedBundles } from "./testing-seed.js";

type TestingRegistryBindings = RegistryEnv & { TESTING_SETUP_SECRET?: string };

const testingPublisher = {
  displayName: "Crewhelm Testing Seeds",
  githubUserId: 1,
  namespace: "crewhelm-labs",
};

function isTestingEnvironment(request: Request, env: TestingRegistryBindings): boolean {
  try {
    const configured = new URL(env.PUBLIC_ORIGIN);
    const received = new URL(request.url);
    return (
      configured.protocol === "https:" &&
      configured.hostname === "crewhelm-registry-dev.fkrein.workers.dev" &&
      received.origin === configured.origin
    );
  } catch {
    return false;
  }
}

function publicRegistryRequest(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  if (url.pathname.startsWith(`${prefix}/`)) {
    url.pathname = url.pathname.slice(prefix.length);
  }
  return new Request(url, request);
}

function authorizedSetup(request: Request, secret: string | undefined): boolean {
  if (secret === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return false;
  const received = request.headers.get("authorization");
  const expected = `Bearer ${secret}`;
  if (received === null || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

export const testingRegistry: ExportedHandler<TestingRegistryBindings> = {
  async fetch(request, bindings, context): Promise<Response> {
    if (!isTestingEnvironment(request, bindings)) {
      return Response.json({ error: "testing_environment_required" }, { status: 503 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        deploymentFingerprint: bindings.REGISTRY_DEPLOYMENT_FINGERPRINT,
        status: "ok",
      });
    }
    if (url.pathname === "/development/seed") {
      if (request.method !== "POST") {
        return new Response(null, { headers: { allow: "POST" }, status: 405 });
      }
      if (!authorizedSetup(request, bindings.TESTING_SETUP_SECRET)) {
        return Response.json({ error: "request_denied" }, { status: 403 });
      }
      try {
        const now = Math.floor(Date.now() / 1_000);
        await registryDatabase(bindings.REGISTRY_DB)
          .insert(publishers)
          .values({
            createdAt: now,
            displayName: testingPublisher.displayName,
            githubLogin: "crewhelm-testing-seeds",
            githubUserId: testingPublisher.githubUserId,
            namespace: testingPublisher.namespace,
            profileUrl: null,
            status: "active",
            updatedAt: now,
          })
          .onConflictDoUpdate({
            set: {
              displayName: testingPublisher.displayName,
              githubLogin: "crewhelm-testing-seeds",
              updatedAt: now,
            },
            target: publishers.githubUserId,
          });
        const bundles = await testingSeedBundles(bindings.PUBLIC_ORIGIN);
        const recipes = [];
        for (const bundle of bundles) {
          const result = await publishBundle(bindings, testingPublisher, bundle);
          if (result.recipe.artifact.version === TESTING_SEED_ARTIFACT_VERSION) {
            recipes.push(result.recipe.artifact.name);
          }
        }
        return Response.json({
          namespace: testingPublisher.namespace,
          recipes,
          seeded: recipes.length,
        });
      } catch (error) {
        console.error("Testing Registry seed failed", error);
        return Response.json({ error: "seed_failed" }, { status: 500 });
      }
    }

    const publicPath = url.pathname.startsWith(`${bindings.PUBLIC_API_PREFIX}/`)
      ? url.pathname.slice(bindings.PUBLIC_API_PREFIX.length)
      : url.pathname;
    if (publicPath.startsWith("/auth/")) {
      return Response.json({ error: "publisher_auth_disabled" }, { status: 404 });
    }

    return createRegistryServer().fetch(
      publicRegistryRequest(request, bindings.PUBLIC_API_PREFIX),
      bindings,
      context,
    );
  },
  async scheduled(_controller, bindings): Promise<void> {
    await runRegistryMaintenance(bindings);
  },
};

export default testingRegistry;
