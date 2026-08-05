import {
  MAXIMUM_RECIPE_BYTES,
  MAXIMUM_SKILL_PACKAGE_BYTES,
  registryResolvePublishAuthorizationSchema,
  registryArtifactPathSchema,
  registryRecipeListQuerySchema,
  registrySearchQuerySchema,
} from "@crewhelm/contracts";
import { CREWHELM_COMPACT_BRAND_HTML, CREWHELM_WEB_STYLES } from "@crewhelm/design/web";
import { Hono, type Context } from "hono";

import {
  authenticatePublisher,
  authenticatePublishAuthorization,
  approvePublishAuthorization,
  createPublishAuthorization,
  endPublisherSession,
  finishGithubAuth,
  inspectPublishAuthorization,
  publicRegistryPath,
  resolvePublishAuthorization,
  startGithubAuth,
} from "./auth.js";
import type { RegistryEnv } from "./env.js";
import {
  artifactVersion,
  latestRecipe,
  latestSkill,
  publishBundle,
  RegistryConflictError,
  RegistryDeniedError,
  listRecipes,
  searchRecipes,
} from "./registry.js";

const MAXIMUM_PUBLISH_BODY_BYTES =
  MAXIMUM_RECIPE_BYTES + 8 * MAXIMUM_SKILL_PACKAGE_BYTES + 64 * 1_024;
const MAXIMUM_PUBLISH_AUTHORIZATION_BODY_BYTES = 16 * 1_024;

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
  const origin = context.req.header("origin");
  if (origin === new URL(context.env.PUBLIC_ORIGIN).origin) return true;
  return (
    origin === "null" &&
    context.req.header("sec-fetch-site") === "same-origin" &&
    context.req.header("sec-fetch-mode") === "navigate" &&
    context.req.header("sec-fetch-dest") === "document"
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function publishAuthorizationPage(
  context: Context<{ Bindings: RegistryEnv }>,
  input: { body: string; heading: string; status?: 200 | 400; submit?: boolean },
): Response {
  context.header("cache-control", "no-store");
  context.header(
    "content-security-policy",
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; style-src 'self'",
  );
  const tone = input.status === 400 ? "negative" : input.submit === true ? "accent" : "positive";
  return context.html(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>${escapeHtml(input.heading)}</title>
    <link rel="stylesheet" href="${publicRegistryPath(context.env, "/styles.css")}">
  </head>
  <body class="ch-page">
    <main class="ch-panel" data-tone="${tone}">
      <div class="ch-panel__bar">
        <span class="ch-panel__context">Registry publishing</span>
        ${CREWHELM_COMPACT_BRAND_HTML}
      </div>
      <h1>${escapeHtml(input.heading)}</h1>
      <p class="ch-copy">${escapeHtml(input.body)}</p>
      ${input.submit === true ? '<div class="ch-actions"><form method="post"><button class="ch-button ch-button--primary" type="submit">Authorize publishing</button></form></div>' : ""}
    </main>
  </body>
</html>
`,
    input.status ?? 200,
  );
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
    const bypassCache = context.req.header("cache-control") === "no-cache";
    const key = publicCacheKey(context.req.raw);
    if (!bypassCache) {
      const cached = await caches.default.match(key);
      if (cached) return cached;
    }
    await next();
    if (
      !bypassCache &&
      context.res.ok &&
      context.res.headers.get("cache-control")?.includes("public")
    ) {
      context.executionCtx.waitUntil(caches.default.put(key, context.res.clone()));
    }
    return context.res;
  });

  app.get("/styles.css", (context) => {
    context.header("cache-control", "public, max-age=3600");
    context.header("content-type", "text/css; charset=utf-8");
    return context.body(`${CREWHELM_WEB_STYLES}\n`);
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

  app.post("/v1/publish/authorizations", async (context) => {
    context.header("cache-control", "no-store");
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    try {
      return context.json(
        await createPublishAuthorization(
          context.env,
          await boundedJson(context, MAXIMUM_PUBLISH_AUTHORIZATION_BODY_BYTES),
        ),
        201,
      );
    } catch (error) {
      if (error instanceof RegistryRequestTooLargeError) return compactError(context, 413);
      if (error instanceof SyntaxError) return compactError(context, 400);
      if (typeof error === "object" && error !== null && "issues" in error) {
        return compactError(context, 400);
      }
      return compactError(context, 500);
    }
  });

  app.post("/v1/publish/authorizations/:authorizationId/resolve", async (context) => {
    context.header("cache-control", "no-store");
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    try {
      const request = registryResolvePublishAuthorizationSchema.parse(
        await boundedJson(context, MAXIMUM_PUBLISH_AUTHORIZATION_BODY_BYTES),
      );
      const authorization = await resolvePublishAuthorization(
        context.env,
        context.req.param("authorizationId"),
        request.verifier,
      );
      return authorization ? context.json(authorization) : compactError(context, 401);
    } catch (error) {
      if (error instanceof RegistryRequestTooLargeError) return compactError(context, 413);
      if (error instanceof SyntaxError) return compactError(context, 400);
      if (typeof error === "object" && error !== null && "issues" in error) {
        return compactError(context, 400);
      }
      return compactError(context, 500);
    }
  });

  app.get("/publish/authorizations/:authorizationId", async (context) => {
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const authorization = await inspectPublishAuthorization(
      context,
      context.req.param("authorizationId"),
    );
    if (authorization.state === "unavailable") {
      return publishAuthorizationPage(context, {
        body: "Request a new publishing link from your MCP client.",
        heading: "Publishing authorization unavailable",
        status: 400,
      });
    }
    if (authorization.state === "login_required") {
      return context.redirect(authorization.loginUrl, 302);
    }
    return publishAuthorizationPage(context, {
      body: `${authorization.installationLabel} is requesting one-time permission to publish as ${authorization.publisher.namespace}. No Crewhelm owner data or credentials will be shared with the Registry.`,
      heading: "Authorize Recipe publishing",
      submit: true,
    });
  });

  app.post("/publish/authorizations/:authorizationId", async (context) => {
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    if (!sameOrigin(context)) {
      return publishAuthorizationPage(context, {
        body: "Request a new publishing link from your MCP client.",
        heading: "Publishing authorization denied",
        status: 400,
      });
    }
    const approved = await approvePublishAuthorization(
      context,
      context.req.param("authorizationId"),
    );
    return approved
      ? publishAuthorizationPage(context, {
          body: "Return to your MCP client to preview and confirm the exact public package.",
          heading: "Publishing authorized",
        })
      : publishAuthorizationPage(context, {
          body: "Request a new publishing link from your MCP client.",
          heading: "Publishing authorization denied",
          status: 400,
        });
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
    const authorizationId = context.req.header("x-crewhelm-publish-authorization");
    const authorizationVerifier = context.req.header("x-crewhelm-publish-verifier");
    const publisher = await authenticatePublishAuthorization(
      context.env,
      authorizationId,
      authorizationVerifier,
    );
    if (!publisher) return compactError(context, 401);
    if (!(await allow(context.env.PUBLISH_RATE_LIMIT, `publisher:${publisher.githubUserId}`))) {
      return compactError(context, 429);
    }
    try {
      const body = await boundedJson(context, MAXIMUM_PUBLISH_BODY_BYTES);
      if (
        typeof body !== "object" ||
        body === null ||
        !("idempotencyKey" in body) ||
        body.idempotencyKey !== publisher.publishIdempotencyKey
      ) {
        return compactError(context, 403);
      }
      const result = await publishBundle(context.env, publisher, body);
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

  app.get("/v1/recipes", async (context) => {
    if (!(await allow(context.env.PUBLIC_READ_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registryRecipeListQuerySchema.safeParse({
      limit:
        context.req.query("limit") === undefined ? undefined : Number(context.req.query("limit")),
    });
    if (!parsed.success) return compactError(context, 400);
    try {
      const result = await listRecipes(context.env, parsed.data.limit);
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

  app.get("/v1/skills/:namespace/:name", async (context) => {
    if (!(await allow(context.env.PUBLIC_READ_RATE_LIMIT, clientKey(context)))) {
      return compactError(context, 429);
    }
    const parsed = registryArtifactPathSchema.omit({ version: true }).safeParse({
      kind: "skill",
      name: context.req.param("name"),
      namespace: context.req.param("namespace"),
    });
    if (!parsed.success) return compactError(context, 404);
    const skill = await latestSkill(context.env, parsed.data.namespace, parsed.data.name);
    if (!skill) return compactError(context, 404);
    context.header(
      "cache-control",
      "public, max-age=60, s-maxage=600, stale-while-revalidate=3600",
    );
    context.header("etag", `"${skill.package.digest}"`);
    if (context.req.header("if-none-match") === `"${skill.package.digest}"`) {
      return context.body(null, 304);
    }
    return context.json(skill);
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
