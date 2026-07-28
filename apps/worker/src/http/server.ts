import { healthReportSchema, ownerAuthoritySchema } from "@crewhelm/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import * as z from "zod";

import { CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX } from "../owner/connections/authorization-return.js";
import { createCrewhelmAuth, verifyMcpAccessToken } from "../oauth/auth.js";
import type { WorkerEnv } from "../env.js";
import { handleAuthenticatedMcpRequest } from "../mcp/server.js";
import {
  protectedResourceMetadata,
  purgeExpiredAuthRecords,
  registerAuthServerRoutes,
} from "../oauth/server.js";
import { registerOAuthUiRoutes } from "../oauth/ui.js";
import { registerConnectionAuthorizationReturnRoutes } from "./connection-authorization-return.js";

const HEALTH_REPORT = healthReportSchema.parse({
  service: "crewhelm",
  status: "ok",
});
const HEALTH_BODY = `${JSON.stringify(HEALTH_REPORT)}\n`;
const METHOD_NOT_ALLOWED_BODY = `${JSON.stringify({
  error: {
    code: "method_not_allowed",
    message: "Method not allowed.",
  },
})}\n`;
const NOT_FOUND_BODY = `${JSON.stringify({
  error: {
    code: "not_found",
    message: "Not found.",
  },
})}\n`;
const INTERNAL_ERROR_BODY = `${JSON.stringify({
  error: {
    code: "internal_error",
    message: "Internal server error.",
  },
})}\n`;
const RATE_LIMITED_BODY = `${JSON.stringify({
  error: {
    code: "rate_limited",
    message: "Request denied.",
  },
})}\n`;
const INVALID_AUTH_BODY = `${JSON.stringify({
  error: {
    code: "invalid_token",
    message: "Authentication required.",
  },
})}\n`;
const MISDIRECTED_BODY = `${JSON.stringify({
  error: {
    code: "misdirected_request",
    message: "Request denied.",
  },
})}\n`;
const publicOriginSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  });

function jsonResponse(
  body: string | null,
  bodyLength: number,
  status: number,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-length", String(bodyLength));
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");

  return new Response(body, { headers, status });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const HEALTH_BODY_LENGTH = byteLength(HEALTH_BODY);
const METHOD_NOT_ALLOWED_BODY_LENGTH = byteLength(METHOD_NOT_ALLOWED_BODY);
const NOT_FOUND_BODY_LENGTH = byteLength(NOT_FOUND_BODY);
const INTERNAL_ERROR_BODY_LENGTH = byteLength(INTERNAL_ERROR_BODY);
const RATE_LIMITED_BODY_LENGTH = byteLength(RATE_LIMITED_BODY);
const INVALID_AUTH_BODY_LENGTH = byteLength(INVALID_AUTH_BODY);
const MISDIRECTED_BODY_LENGTH = byteLength(MISDIRECTED_BODY);

function publicOrigin(env: Pick<WorkerEnv, "PUBLIC_ORIGIN">): string {
  return publicOriginSchema.parse(env.PUBLIC_ORIGIN);
}

function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");

  if (header === null || header.length > 8_192) {
    return null;
  }

  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(header);
  return match?.[1] ?? null;
}

function invalidTokenResponse(origin: string): Response {
  return jsonResponse(INVALID_AUTH_BODY, INVALID_AUTH_BODY_LENGTH, 401, {
    "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`,
  });
}

async function handleMcpRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const origin = publicOrigin(env);
  const token = readBearerToken(request);

  if (token === null) {
    return invalidTokenResponse(origin);
  }

  let claims: Awaited<ReturnType<typeof verifyMcpAccessToken>>;

  try {
    const auth = createCrewhelmAuth(env, origin);
    claims = await verifyMcpAccessToken(env, auth, origin, token);
  } catch {
    return invalidTokenResponse(origin);
  }

  if (claims === null) {
    return invalidTokenResponse(origin);
  }

  const authority = ownerAuthoritySchema.safeParse({
    clientId: claims.azp,
    ownerKey: claims.sub,
    scopes: claims.scope.split(" "),
  });

  if (!authority.success) {
    return invalidTokenResponse(origin);
  }

  return handleAuthenticatedMcpRequest(request, env, {
    authority: authority.data,
  });
}

export function createWorker(): Hono<{ Bindings: WorkerEnv }> {
  const worker = new Hono<{ Bindings: WorkerEnv }>({
    getPath: (request) => new URL(request.url).pathname,
  });
  const createAuth = (context: Context<{ Bindings: WorkerEnv }>) =>
    createCrewhelmAuth(context.env, publicOrigin(context.env));

  worker.onError((_error, context) =>
    jsonResponse(
      context.req.method === "HEAD" ? null : INTERNAL_ERROR_BODY,
      INTERNAL_ERROR_BODY_LENGTH,
      500,
    ),
  );

  worker.on(["GET", "HEAD"], "/health", (context) =>
    jsonResponse(context.req.method === "HEAD" ? null : HEALTH_BODY, HEALTH_BODY_LENGTH, 200),
  );

  worker.all("/health", () =>
    jsonResponse(METHOD_NOT_ALLOWED_BODY, METHOD_NOT_ALLOWED_BODY_LENGTH, 405, {
      allow: "GET, HEAD",
    }),
  );

  worker.on(["GET", "HEAD"], "/.well-known/oauth-protected-resource", (context) => {
    const response = protectedResourceMetadata(publicOrigin(context.env));
    return context.req.method === "HEAD"
      ? new Response(null, { headers: response.headers, status: response.status })
      : response;
  });
  worker.on(["GET", "HEAD"], "/.well-known/oauth-protected-resource/mcp", (context) => {
    const response = protectedResourceMetadata(publicOrigin(context.env));
    return context.req.method === "HEAD"
      ? new Response(null, { headers: response.headers, status: response.status })
      : response;
  });

  registerOAuthUiRoutes(worker, createAuth);
  registerAuthServerRoutes(worker, createAuth);
  registerConnectionAuthorizationReturnRoutes(worker);
  worker.all("/mcp", (context) => handleMcpRequest(context.req.raw, context.env));

  worker.notFound((context) =>
    jsonResponse(context.req.method === "HEAD" ? null : NOT_FOUND_BODY, NOT_FOUND_BODY_LENGTH, 404),
  );

  return worker;
}

const defaultApp = createWorker();

function isRateLimitedPath(path: string): "auth" | "mcp" | null {
  if (path === "/mcp") {
    return "mcp";
  }

  if (
    path.startsWith("/api/auth/") ||
    path.startsWith(CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX) ||
    path === "/oauth/login" ||
    path === "/oauth/login/continue" ||
    path === "/oauth/consent" ||
    path === "/oauth/consent/decision" ||
    path === "/.well-known/oauth-authorization-server/api/auth"
  ) {
    return "auth";
  }

  return null;
}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  context: ExecutionContext,
): Promise<Response> {
  let origin: string;

  try {
    origin = publicOrigin(env);
  } catch {
    return jsonResponse(INTERNAL_ERROR_BODY, INTERNAL_ERROR_BODY_LENGTH, 500);
  }

  if (new URL(request.url).origin !== origin) {
    return jsonResponse(MISDIRECTED_BODY, MISDIRECTED_BODY_LENGTH, 421);
  }

  const path = new URL(request.url).pathname;
  const limitedPath = isRateLimitedPath(path);

  if (limitedPath !== null) {
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
    const rateLimitKeyPath = path.startsWith(CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX)
      ? CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX
      : path;
    let rateLimit: RateLimitOutcome;

    try {
      rateLimit = await (limitedPath === "mcp" ? env.MCP_RATE_LIMIT : env.AUTH_RATE_LIMIT).limit({
        key: `${rateLimitKeyPath}:${clientAddress.slice(0, 64)}`,
      });
    } catch {
      return jsonResponse(RATE_LIMITED_BODY, RATE_LIMITED_BODY_LENGTH, 503, {
        "retry-after": "60",
      });
    }

    if (!rateLimit.success) {
      return jsonResponse(RATE_LIMITED_BODY, RATE_LIMITED_BODY_LENGTH, 429, {
        "retry-after": "60",
      });
    }
  }

  return defaultApp.fetch(request, env, context);
}

export default class CrewhelmWorker extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request, this.env, this.ctx);
  }

  override scheduled(_controller: ScheduledController): void {
    this.ctx.waitUntil(purgeExpiredAuthRecords(this.env));
  }
}
