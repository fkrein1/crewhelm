import {
  MAXIMUM_RECIPE_BYTES,
  MAXIMUM_SKILL_PACKAGE_BYTES,
  registryArtifactPathSchema,
  registrySearchQuerySchema,
} from "@crewhelm/contracts";
import { Hono, type Context } from "hono";

import {
  authenticatePublisher,
  endPublisherSession,
  finishGithubAuth,
  startGithubAuth,
} from "./auth.js";
import type { RegistryEnv } from "./env.js";
import {
  artifactVersion,
  latestRecipe,
  publishBundle,
  RegistryConflictError,
  RegistryDeniedError,
  searchRecipes,
} from "./registry.js";

const MAXIMUM_PUBLISH_BODY_BYTES =
  MAXIMUM_RECIPE_BYTES + 8 * MAXIMUM_SKILL_PACKAGE_BYTES + 64 * 1_024;

type App = Hono<{ Bindings: RegistryEnv }>;

class RegistryRequestTooLargeError extends Error {
  override readonly name = "RegistryRequestTooLargeError";
}

function clientKey(context: Context): string {
  return context.req.header("cf-connecting-ip") ?? "unknown";
}

async function allow(rateLimit: RateLimit, key: string): Promise<boolean> {
  return (await rateLimit.limit({ key })).success;
}

function compactError(context: Context, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500) {
  context.header("cache-control", "no-store");
  if (status === 429) context.header("retry-after", "60");
  return context.json({ error: status === 500 ? "unavailable" : "request_denied" }, status);
}

function sameOrigin(context: Context<{ Bindings: RegistryEnv }>): boolean {
  return context.req.header("origin") === new URL(context.env.PUBLIC_ORIGIN).origin;
}

async function boundedJson(context: Context, maximumBytes: number): Promise<unknown> {
  const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new RegistryDeniedError("invalid_body");
  const contentLengthValue = context.req.header("content-length");
  if (contentLengthValue !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLengthValue)) {
      throw new RegistryDeniedError("invalid_body");
    }
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength)) throw new RegistryDeniedError("invalid_body");
    if (contentLength > maximumBytes) throw new RegistryRequestTooLargeError();
  }
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  if (reader) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new RegistryDeniedError("invalid_body");
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded-body denial.
        }
        throw new RegistryRequestTooLargeError();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  ) as unknown;
}

function checksumHex(checksum: ArrayBuffer | undefined): string | null {
  if (!checksum) return null;
  return [...new Uint8Array(checksum)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedSearchQuery(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

function publicCacheKey(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === "/v1/recipes/search") {
    const query = normalizedSearchQuery(url.searchParams.get("q") ?? undefined);
    if (query) url.searchParams.set("q", query);
    if (!url.searchParams.has("limit")) url.searchParams.set("limit", "10");
    url.searchParams.sort();
  }
  return new Request(url, { method: "GET" });
}

export function createRegistryServer(): App {
  const app = new Hono<{ Bindings: RegistryEnv }>();

  app.use("*", async (context, next) => {
    context.header("access-control-allow-origin", "*");
    context.header("access-control-expose-headers", "etag, retry-after");
    context.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    context.header("referrer-policy", "no-referrer");
    context.header("x-content-type-options", "nosniff");
    await next();
  });

  app.use("/v1/*", async (context, next) => {
    if (context.req.method !== "GET") {
      await next();
      return context.res;
    }
    const key = publicCacheKey(context.req.raw);
    const cached = await caches.default.match(key);
    if (cached) return cached;
    await next();
    if (context.res.ok && context.res.headers.get("cache-control")?.includes("public")) {
      context.executionCtx.waitUntil(caches.default.put(key, context.res.clone()));
    }
    return context.res;
  });

  app.options("/v1/*", (context) => {
    context.header("access-control-allow-methods", "GET, HEAD, OPTIONS");
    context.header("access-control-max-age", "86400");
    return context.body(null, 204);
  });

  app.get("/health", (context) => {
    context.header("cache-control", "no-store");
    return context.json({ status: "ok" });
  });

  app.get("/auth/github/start", async (context) => {
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    return startGithubAuth(context);
  });

  app.get("/auth/github/callback", async (context) => {
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    return finishGithubAuth(context);
  });

  app.get("/v1/publisher", async (context) => {
    context.header("cache-control", "no-store");
    const publisher = await authenticatePublisher(context);
    return publisher ? context.json({ publisher }) : compactError(context, 401);
  });

  app.post("/v1/publisher/logout", async (context) => {
    if (!sameOrigin(context)) return compactError(context, 403);
    await endPublisherSession(context);
    return context.body(null, 204);
  });

  app.post("/v1/publish", async (context) => {
    context.header("cache-control", "no-store");
    if (!sameOrigin(context)) return compactError(context, 403);
    const publisher = await authenticatePublisher(context);
    if (!publisher) return compactError(context, 401);
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, `publisher:${publisher.githubUserId}`))) {
      return compactError(context, 429);
    }
    try {
      const result = await publishBundle(
        context.env,
        publisher,
        await boundedJson(context, MAXIMUM_PUBLISH_BODY_BYTES),
      );
      return context.json(result, 201);
    } catch (error) {
      if (error instanceof RegistryRequestTooLargeError) return compactError(context, 413);
      if (error instanceof RegistryConflictError) return compactError(context, 409);
      if (error instanceof RegistryDeniedError) return compactError(context, 403);
      if (error instanceof SyntaxError) return compactError(context, 400);
      if (typeof error === "object" && error !== null && "issues" in error) {
        return compactError(context, 400);
      }
      return compactError(context, 500);
    }
  });

  app.get("/v1/recipes/search", async (context) => {
    if (!(await allow(context.env.SEARCH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registrySearchQuerySchema.safeParse({
      limit:
        context.req.query("limit") === undefined ? undefined : Number(context.req.query("limit")),
      query: normalizedSearchQuery(context.req.query("q")),
    });
    if (!parsed.success) return compactError(context, 400);
    try {
      const result = await searchRecipes(context.env, parsed.data.query, parsed.data.limit);
      context.header(
        "cache-control",
        "public, max-age=30, s-maxage=300, stale-while-revalidate=600",
      );
      return context.json(result);
    } catch {
      return compactError(context, 500);
    }
  });

  app.get("/v1/recipes/:namespace/:name", async (context) => {
    if (!(await allow(context.env.PUBLIC_READ_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registryArtifactPathSchema.omit({ version: true }).safeParse({
      kind: "recipe",
      name: context.req.param("name"),
      namespace: context.req.param("namespace"),
    });
    if (!parsed.success) return compactError(context, 404);
    const recipe = await latestRecipe(context.env, parsed.data.namespace, parsed.data.name);
    if (!recipe) return compactError(context, 404);
    context.header(
      "cache-control",
      "public, max-age=60, s-maxage=600, stale-while-revalidate=3600",
    );
    context.header("etag", `"${recipe.package.digest}"`);
    if (context.req.header("if-none-match") === `"${recipe.package.digest}"`) {
      return context.body(null, 304);
    }
    return context.json(recipe);
  });

  app.get("/v1/artifacts/:kind/:namespace/:name/:version", async (context) => {
    if (!(await allow(context.env.PUBLIC_READ_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registryArtifactPathSchema.safeParse({
      kind: context.req.param("kind"),
      name: context.req.param("name"),
      namespace: context.req.param("namespace"),
      version: Number(context.req.param("version")),
    });
    if (!parsed.success) return compactError(context, 404);
    const artifact = await artifactVersion(
      context.env,
      parsed.data.kind,
      parsed.data.namespace,
      parsed.data.name,
      parsed.data.version,
    );
    if (!artifact) return compactError(context, 404);
    context.header("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
    context.header("etag", `"${artifact.envelope.package.digest}:${artifact.envelope.lifecycle}"`);
    return context.json({ envelope: artifact.envelope, projection: artifact.projection });
  });

  app.get("/v1/artifacts/:kind/:namespace/:name/:version/package", async (context) => {
    if (!(await allow(context.env.PUBLIC_READ_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registryArtifactPathSchema.safeParse({
      kind: context.req.param("kind"),
      name: context.req.param("name"),
      namespace: context.req.param("namespace"),
      version: Number(context.req.param("version")),
    });
    if (!parsed.success) return compactError(context, 404);
    const artifact = await artifactVersion(
      context.env,
      parsed.data.kind,
      parsed.data.namespace,
      parsed.data.name,
      parsed.data.version,
    );
    if (!artifact || artifact.envelope.lifecycle !== "published") return compactError(context, 404);
    const etag = `"${artifact.envelope.package.digest}"`;
    if (context.req.header("if-none-match") === etag) {
      context.header("cache-control", "public, max-age=31536000, immutable");
      context.header("etag", etag);
      return context.body(null, 304);
    }
    const object = await context.env.REGISTRY_PACKAGES.get(artifact.key);
    if (
      !object ||
      object.size !== artifact.envelope.package.sizeBytes ||
      object.customMetadata?.digest !== artifact.envelope.package.digest ||
      checksumHex(object.checksums.sha256) !== artifact.envelope.package.digest
    ) {
      return compactError(context, 500);
    }
    context.header("cache-control", "public, max-age=31536000, immutable");
    context.header("content-type", "application/json; charset=utf-8");
    context.header("etag", etag);
    return context.body(object.body);
  });

  app.notFound((context) => compactError(context, 404));
  app.onError((_error, context) => compactError(context, 500));
  return app;
}
