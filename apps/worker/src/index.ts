import { healthReportSchema, OWNER_READ_SCOPE } from "@crewhelm/contracts";
import {
  OAuthError,
  OAuthProvider,
  type ClientRegistrationCallbackOptions,
  type ClientRegistrationCallbackResult,
  type TokenExchangeCallbackOptions,
  type TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";

import type { WorkerEnv } from "./env.js";
import { registerGithubAuthorizationRoutes } from "./github-authorization.js";
import { mcpApiHandler, mcpAuthPropsSchema } from "./mcp-handler.js";
import { readBoundedPostRequest } from "./request-body.js";

export { OwnerControlPlane } from "./owner-control-plane.js";

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
const MAX_CLIENT_REGISTRATION_BYTES = 8 * 1024;
const RATE_LIMITED_BODY = `${JSON.stringify({
  error: {
    code: "rate_limited",
    message: "OAuth request denied.",
  },
})}\n`;
const OAUTH_REQUEST_TOO_LARGE_BODY = `${JSON.stringify({
  error: {
    code: "request_too_large",
    message: "OAuth request denied.",
  },
})}\n`;
const RATE_LIMITED_BODY_LENGTH = byteLength(RATE_LIMITED_BODY);
const OAUTH_REQUEST_TOO_LARGE_BODY_LENGTH = byteLength(OAUTH_REQUEST_TOO_LARGE_BODY);

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^[0-9]{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isAllowedClientRedirect(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_048) {
    return false;
  }

  try {
    const url = new URL(value);
    const hasForbiddenComponents = url.username !== "" || url.password !== "" || url.hash !== "";

    if (hasForbiddenComponents) {
      return false;
    }

    return (
      url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

export function validateClientRegistration(
  options: ClientRegistrationCallbackOptions,
): ClientRegistrationCallbackResult | undefined {
  const declaredLength = Number(options.request.headers.get("content-length") ?? "0");
  const redirectUris = options.clientMetadata.redirect_uris;
  const validLength =
    Number.isSafeInteger(declaredLength) &&
    declaredLength >= 0 &&
    declaredLength <= MAX_CLIENT_REGISTRATION_BYTES;
  const validRedirects =
    Array.isArray(redirectUris) &&
    redirectUris.length >= 1 &&
    redirectUris.length <= 8 &&
    redirectUris.every(isAllowedClientRedirect);

  if (!validLength || !validRedirects) {
    return {
      code: "invalid_client_metadata",
      description: "Client registration denied.",
      status: 400,
    };
  }

  return undefined;
}

export function bindAccessTokenAuthority(
  options: TokenExchangeCallbackOptions,
): TokenExchangeCallbackResult {
  const props = mcpAuthPropsSchema.safeParse(options.props);
  const hasReadScope =
    options.requestedScope.length === 1 && options.requestedScope[0] === OWNER_READ_SCOPE;

  if (
    !props.success ||
    !hasReadScope ||
    props.data.authority.clientId !== options.clientId ||
    props.data.authority.ownerKey !== options.userId
  ) {
    throw new OAuthError("invalid_scope", {
      description: "Requested scope denied.",
    });
  }

  return {
    accessTokenProps: {
      authority: {
        ...props.data.authority,
        scopes: [OWNER_READ_SCOPE],
      },
    },
    accessTokenScope: [OWNER_READ_SCOPE],
    refreshTokenTTL: 0,
  };
}

export function createWorker(): Hono<{ Bindings: WorkerEnv }> {
  const worker = new Hono<{ Bindings: WorkerEnv }>({
    getPath: (request) => new URL(request.url).pathname,
  });

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

  registerGithubAuthorizationRoutes(worker);

  worker.notFound((context) =>
    jsonResponse(context.req.method === "HEAD" ? null : NOT_FOUND_BODY, NOT_FOUND_BODY_LENGTH, 404),
  );

  return worker;
}

const defaultApp = createWorker();
const defaultHandler = {
  fetch(request, env, context) {
    return defaultApp.fetch(request, env, context);
  },
} satisfies ExportedHandler<WorkerEnv>;

const oauthProvider = new OAuthProvider<WorkerEnv>({
  accessTokenTTL: 15 * 60,
  allowImplicitFlow: false,
  allowPlainPKCE: false,
  allowTokenExchangeGrant: false,
  apiHandler: mcpApiHandler,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientIdMetadataDocumentEnabled: false,
  clientRegistrationCallback: validateClientRegistration,
  clientRegistrationEndpoint: "/oauth/register",
  clientRegistrationTTL: 24 * 60 * 60,
  defaultHandler,
  disallowPublicClientRegistration: false,
  onError: (error) => {
    const body = `${JSON.stringify({
      error: error.code,
      error_description: "OAuth request denied.",
    })}\n`;

    return jsonResponse(body, byteLength(body), error.status, error.headers);
  },
  refreshTokenTTL: 0,
  scopesSupported: [OWNER_READ_SCOPE],
  tokenExchangeCallback: bindAccessTokenAuthority,
  tokenEndpoint: "/oauth/token",
});

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  context: ExecutionContext,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const isAuthorizationRequest =
    path === "/authorize" ||
    path === "/oauth/github/callback" ||
    path === "/oauth/register" ||
    path === "/oauth/token";
  const isMcpRequest = path === "/mcp";
  const isBoundedOAuthPost =
    request.method === "POST" && (path === "/oauth/register" || path === "/oauth/token");

  if (isAuthorizationRequest || isMcpRequest) {
    const clientAddress = request.headers.get("cf-connecting-ip") ?? "unknown";
    let rateLimit: RateLimitOutcome;

    try {
      rateLimit = await (isMcpRequest ? env.MCP_RATE_LIMIT : env.AUTH_RATE_LIMIT).limit({
        key: `${path}:${clientAddress.slice(0, 64)}`,
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

  if (!isBoundedOAuthPost) {
    return oauthProvider.fetch(request, env, context);
  }

  const boundedRequest = await readBoundedPostRequest(request, MAX_CLIENT_REGISTRATION_BYTES);

  if (boundedRequest === null) {
    return jsonResponse(OAUTH_REQUEST_TOO_LARGE_BODY, OAUTH_REQUEST_TOO_LARGE_BODY_LENGTH, 413);
  }

  return oauthProvider.fetch(boundedRequest, env, context);
}

export async function purgeOAuthRecords(env: WorkerEnv): Promise<void> {
  const result = await oauthProvider.purgeExpiredData(env, {
    batchSize: 50,
    purgeOrphanedGrants: true,
    purgeOrphanedTokens: false,
  });

  if (!result.done) {
    throw new Error("OAuth record purge did not complete.");
  }
}

export default class CrewhelmWorker extends WorkerEntrypoint {
  override fetch(request: Request): Promise<Response> {
    return handleWorkerRequest(request, this.env, this.ctx);
  }

  override scheduled(_controller: ScheduledController): void {
    this.ctx.waitUntil(purgeOAuthRecords(this.env));
  }
}
