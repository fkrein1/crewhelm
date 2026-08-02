import {
  CREWHELM_DEPLOYMENT_PROTOCOL_VERSION,
  healthReportSchema,
  ownerAuthoritySchema,
} from "@crewhelm/contracts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono, type Context } from "hono";
import * as z from "zod";

import { CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX } from "../owner/connections/index.js";
import { COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME } from "../owner/watches/index.js";
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
const WEBHOOK_ACCEPTED_BODY = `${JSON.stringify({ accepted: true })}\n`;
const WEBHOOK_DENIED_BODY = `${JSON.stringify({
  error: { code: "invalid_webhook", message: "Webhook request denied." },
})}\n`;
const MAXIMUM_COMPOSIO_WEBHOOK_BODY_BYTES = 256 * 1_024;
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

const METHOD_NOT_ALLOWED_BODY_LENGTH = byteLength(METHOD_NOT_ALLOWED_BODY);
const NOT_FOUND_BODY_LENGTH = byteLength(NOT_FOUND_BODY);
const INTERNAL_ERROR_BODY_LENGTH = byteLength(INTERNAL_ERROR_BODY);
const RATE_LIMITED_BODY_LENGTH = byteLength(RATE_LIMITED_BODY);
const INVALID_AUTH_BODY_LENGTH = byteLength(INVALID_AUTH_BODY);
const MISDIRECTED_BODY_LENGTH = byteLength(MISDIRECTED_BODY);
const WEBHOOK_ACCEPTED_BODY_LENGTH = byteLength(WEBHOOK_ACCEPTED_BODY);
const WEBHOOK_DENIED_BODY_LENGTH = byteLength(WEBHOOK_DENIED_BODY);

function publicOrigin(env: Pick<WorkerEnv, "PUBLIC_ORIGIN">): string {
  return publicOriginSchema.parse(env.PUBLIC_ORIGIN);
}

function healthBody(env: Pick<WorkerEnv, "CREWHELM_DEPLOYMENT_FINGERPRINT">): string {
  return `${JSON.stringify(
    healthReportSchema.parse({
      deployment: {
        fingerprint: env.CREWHELM_DEPLOYMENT_FINGERPRINT,
        protocolVersion: CREWHELM_DEPLOYMENT_PROTOCOL_VERSION,
      },
      service: "crewhelm",
      status: "ok",
    }),
  )}\n`;
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

async function readBoundedBody(request: Request, maximumBytes: number): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");

  if (
    declaredLength !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maximumBytes)
  ) {
    return null;
  }

  if (request.body === null) {
    return null;
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const next = await reader.read();

      if (next.done) {
        break;
      }

      length += next.value.byteLength;

      if (length > maximumBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(next.value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

async function handleComposioWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return jsonResponse(WEBHOOK_DENIED_BODY, WEBHOOK_DENIED_BODY_LENGTH, 400);
  }

  const body = await readBoundedBody(request, MAXIMUM_COMPOSIO_WEBHOOK_BODY_BYTES);

  if (body === null) {
    return jsonResponse(WEBHOOK_DENIED_BODY, WEBHOOK_DENIED_BODY_LENGTH, 400);
  }

  const id = request.headers.get("webhook-id");
  const signature = request.headers.get("webhook-signature");
  const timestamp = request.headers.get("webhook-timestamp");

  if (id === null || signature === null || timestamp === null) {
    return jsonResponse(WEBHOOK_DENIED_BODY, WEBHOOK_DENIED_BODY_LENGTH, 401);
  }

  try {
    const ingress = env.OWNER_CONTROL_PLANE.getByName(COMPOSIO_WEBHOOK_INGRESS_OBJECT_NAME);
    const delivered = await ingress.receiveComposioWebhook({
      body,
      headers: { id, signature, timestamp },
    });

    if (delivered.ok) {
      return jsonResponse(WEBHOOK_ACCEPTED_BODY, WEBHOOK_ACCEPTED_BODY_LENGTH, 202);
    }

    return jsonResponse(
      WEBHOOK_DENIED_BODY,
      WEBHOOK_DENIED_BODY_LENGTH,
      delivered.error === "invalid_webhook" ? 401 : 503,
    );
  } catch {
    return jsonResponse(WEBHOOK_DENIED_BODY, WEBHOOK_DENIED_BODY_LENGTH, 503);
  }
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

  worker.on(["GET", "HEAD"], "/health", (context) => {
    const body = healthBody(context.env);
    return jsonResponse(context.req.method === "HEAD" ? null : body, byteLength(body), 200);
  });

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
  worker.post("/webhooks/composio", (context) =>
    handleComposioWebhook(context.req.raw, context.env),
  );
  worker.all("/webhooks/composio", () =>
    jsonResponse(METHOD_NOT_ALLOWED_BODY, METHOD_NOT_ALLOWED_BODY_LENGTH, 405, { allow: "POST" }),
  );
  worker.all("/mcp", (context) => handleMcpRequest(context.req.raw, context.env));

  worker.notFound((context) =>
    jsonResponse(context.req.method === "HEAD" ? null : NOT_FOUND_BODY, NOT_FOUND_BODY_LENGTH, 404),
  );

  return worker;
}

const defaultApp = createWorker();

function isRateLimitedPath(path: string): "auth" | "composio" | "mcp" | null {
  if (path === "/mcp") {
    return "mcp";
  }

  if (path === "/webhooks/composio") {
    return "composio";
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
      const limiter =
        limitedPath === "mcp"
          ? env.MCP_RATE_LIMIT
          : limitedPath === "composio"
            ? env.COMPOSIO_WEBHOOK_RATE_LIMIT
            : env.AUTH_RATE_LIMIT;
      rateLimit = await limiter.limit({
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
