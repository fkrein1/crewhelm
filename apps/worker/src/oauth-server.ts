import { OWNER_READ_SCOPE } from "@crewhelm/contracts";
import { APIError } from "better-auth/api";
import type { Context, Hono } from "hono";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  notInArray,
} from "drizzle-orm/sql/expressions/conditions";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";

import { revokeMcpAccessToken, type CrewhelmAuth } from "./auth.js";
import {
  authSchema,
  jwks,
  mcpClientRegistration,
  mcpTokenRevocation,
  oauthAccessToken,
  oauthClient,
  oauthClientAssertion,
  oauthConsent,
  oauthRefreshToken,
  session,
  verification,
} from "./auth-schema.js";
import type { WorkerEnv } from "./env.js";
import { readBoundedPostRequest } from "./request-body.js";

const MAX_OAUTH_REQUEST_BYTES = 8 * 1024;
const CLIENT_REGISTRATION_TTL_SECONDS = 24 * 60 * 60;
const AUTH_BASE_PATH = "/api/auth";
const AUTH_SERVER_PATHS = new Set([
  `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server`,
  `${AUTH_BASE_PATH}/callback/github`,
  `${AUTH_BASE_PATH}/jwks`,
  `${AUTH_BASE_PATH}/oauth2/authorize`,
  `${AUTH_BASE_PATH}/oauth2/introspect`,
  `${AUTH_BASE_PATH}/oauth2/register`,
  `${AUTH_BASE_PATH}/oauth2/revoke`,
  `${AUTH_BASE_PATH}/oauth2/token`,
  `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`,
]);
const registrationResponseSchema = z.looseObject({
  client_id: z.string().min(1).max(2_048),
  token_endpoint_auth_method: z.literal("none"),
});
const oauthErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const registrationRequestSchema = z.strictObject({
  client_name: z.string().min(1).max(160).optional(),
  grant_types: z.tuple([z.literal("authorization_code")]).optional(),
  redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(8),
  require_pkce: z.literal(true).optional(),
  resources: z.array(z.url().max(2_048)).max(1).optional(),
  response_types: z.tuple([z.literal("code")]).optional(),
  scope: z.literal(OWNER_READ_SCOPE).optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
});
const tokenClientSchema = z.string().min(1).max(2_048);
const authorizationRequestSchema = z.strictObject({
  clientId: tokenClientSchema,
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal("S256"),
  resource: z.url().max(2_048),
  responseType: z.literal("code"),
  scope: z.literal(OWNER_READ_SCOPE),
});
const tokenRequestSchema = z.strictObject({
  clientId: tokenClientSchema,
  grantType: z.literal("authorization_code"),
  resource: z.url().max(2_048),
});
const revocationRequestSchema = z.strictObject({
  clientId: tokenClientSchema,
  token: z.string().min(1).max(8_192),
  tokenTypeHint: z.literal("access_token").optional(),
});

type AuthApp = Hono<{ Bindings: WorkerEnv }>;
type WorkerContext = Context<{ Bindings: WorkerEnv }>;
type AuthFactory = (context: WorkerContext) => CrewhelmAuth;

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

function isAllowedClientRedirect(value: string): boolean {
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

function fixedJsonResponse(
  body: unknown,
  status: number,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");

  return new Response(`${JSON.stringify(body)}\n`, { headers, status });
}

function authorizationUnavailable(stage: "client_lease" | "provider"): Response {
  console.error("crewhelm.authorization_unavailable", { stage });
  return fixedJsonResponse(
    {
      error: "temporarily_unavailable",
      error_description: "OAuth request denied.",
    },
    503,
  );
}

function protocolError(error: unknown): Response | null {
  if (!(error instanceof APIError) || error.statusCode < 400 || error.statusCode >= 500) {
    return null;
  }

  const code = oauthErrorCodeSchema.safeParse(error.body?.error);

  return fixedJsonResponse(
    {
      error: code.success ? code.data : "invalid_request",
      error_description: "OAuth request denied.",
    },
    error.statusCode,
  );
}

async function normalizeProtocolErrorResponse(response: Response): Promise<Response> {
  if (response.status < 400 || response.status >= 500) {
    return response;
  }

  let body: unknown;

  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }

  const candidate =
    typeof body === "object" && body !== null && "error" in body
      ? Reflect.get(body, "error")
      : undefined;
  const code = oauthErrorCodeSchema.safeParse(candidate);

  return fixedJsonResponse(
    {
      error: code.success ? code.data : "invalid_request",
      error_description: "OAuth request denied.",
    },
    response.status,
  );
}

function invalidClient(): Response {
  return fixedJsonResponse(
    {
      error: "invalid_client",
      error_description: "OAuth request denied.",
    },
    400,
  );
}

function invalidClientMetadata(): Response {
  return fixedJsonResponse(
    {
      error: "invalid_client_metadata",
      error_description: "Client registration denied.",
    },
    400,
  );
}

function invalidAuthorizationRequest(): Response {
  return fixedJsonResponse(
    {
      error: "invalid_request",
      error_description: "OAuth request denied.",
    },
    400,
  );
}

async function boundedAuthRequest(request: Request): Promise<Request | null> {
  if (request.method !== "POST") {
    return request;
  }

  return readBoundedPostRequest(request, MAX_OAUTH_REQUEST_BYTES);
}

async function normalizeRegistrationRequest(request: Request): Promise<Request | null> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return null;
  }

  let body: unknown;

  try {
    body = await request.clone().json();
  } catch {
    return null;
  }

  const registration = registrationRequestSchema.safeParse(body);

  if (!registration.success) {
    return null;
  }

  const resource = `${new URL(request.url).origin}/mcp`;

  if (
    !registration.data.redirect_uris.every((redirect) => isAllowedClientRedirect(redirect)) ||
    (registration.data.resources !== undefined &&
      (registration.data.resources.length !== 1 || registration.data.resources[0] !== resource))
  ) {
    return null;
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");

  return new Request(request.url, {
    body: JSON.stringify({
      ...registration.data,
      resources: [resource],
    }),
    headers,
    method: "POST",
  });
}

function singleSearchValue(search: URLSearchParams, name: string): string | null {
  const values = search.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function authorizationClientId(request: Request): string | null {
  const url = new URL(request.url);
  const authorization = authorizationRequestSchema.safeParse({
    clientId: singleSearchValue(url.searchParams, "client_id"),
    codeChallenge: singleSearchValue(url.searchParams, "code_challenge"),
    codeChallengeMethod: singleSearchValue(url.searchParams, "code_challenge_method"),
    resource: singleSearchValue(url.searchParams, "resource"),
    responseType: singleSearchValue(url.searchParams, "response_type"),
    scope: singleSearchValue(url.searchParams, "scope"),
  });

  return authorization.success && authorization.data.resource === `${url.origin}/mcp`
    ? authorization.data.clientId
    : null;
}

async function tokenClientId(request: Request): Promise<string | null> {
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
  ) {
    return null;
  }

  try {
    const form = await request.clone().formData();
    const tokenRequest = tokenRequestSchema.safeParse({
      clientId: form.getAll("client_id").length === 1 ? form.get("client_id") : null,
      grantType: form.getAll("grant_type").length === 1 ? form.get("grant_type") : null,
      resource: form.getAll("resource").length === 1 ? form.get("resource") : null,
    });

    return tokenRequest.success &&
      tokenRequest.data.resource === `${new URL(request.url).origin}/mcp`
      ? tokenRequest.data.clientId
      : null;
  } catch {
    return null;
  }
}

async function revocationRequest(
  request: Request,
): Promise<z.infer<typeof revocationRequestSchema> | null> {
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
  ) {
    return null;
  }

  try {
    const form = await request.clone().formData();
    const result = revocationRequestSchema.safeParse({
      clientId: form.getAll("client_id").length === 1 ? form.get("client_id") : null,
      token: form.getAll("token").length === 1 ? form.get("token") : null,
      tokenTypeHint:
        form.getAll("token_type_hint").length === 0
          ? undefined
          : form.getAll("token_type_hint").length === 1
            ? form.get("token_type_hint")
            : null,
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function hasActiveClientRegistration(
  env: Pick<WorkerEnv, "AUTH_DB">,
  clientId: string,
  now = new Date(),
): Promise<boolean> {
  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  const rows = await database
    .select({ clientId: mcpClientRegistration.clientId })
    .from(mcpClientRegistration)
    .where(
      and(eq(mcpClientRegistration.clientId, clientId), gt(mcpClientRegistration.expiresAt, now)),
    )
    .limit(1);

  return rows.length === 1;
}

async function requireActiveClient(
  request: Request,
  env: WorkerEnv,
  path: string,
): Promise<Response | null> {
  let clientId: string | null = null;

  if (path === `${AUTH_BASE_PATH}/oauth2/authorize`) {
    clientId = authorizationClientId(request);
  } else if (path === `${AUTH_BASE_PATH}/oauth2/token`) {
    clientId = await tokenClientId(request);
  }

  if (clientId === null) {
    return invalidAuthorizationRequest();
  }

  try {
    return (await hasActiveClientRegistration(env, clientId)) ? null : invalidClient();
  } catch {
    return authorizationUnavailable("client_lease");
  }
}

async function storeClientRegistrationLease(env: WorkerEnv, response: Response): Promise<boolean> {
  let body: unknown;

  try {
    body = await response.clone().json();
  } catch {
    return false;
  }

  const registration = registrationResponseSchema.safeParse(body);

  if (!registration.success) {
    return false;
  }

  const now = new Date();
  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  await database.insert(mcpClientRegistration).values({
    clientId: registration.data.client_id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLIENT_REGISTRATION_TTL_SECONDS * 1_000),
  });
  return true;
}

export async function handleAuthServerRequest(
  context: WorkerContext,
  createAuth: AuthFactory,
): Promise<Response> {
  let request = await boundedAuthRequest(context.req.raw);

  if (request === null) {
    return fixedJsonResponse(
      {
        error: "request_too_large",
        error_description: "OAuth request denied.",
      },
      413,
    );
  }

  const path = new URL(request.url).pathname;

  if (!AUTH_SERVER_PATHS.has(path)) {
    return fixedJsonResponse(
      {
        error: "not_found",
        error_description: "Not found.",
      },
      404,
    );
  }

  if (path === `${AUTH_BASE_PATH}/oauth2/register`) {
    const normalizedRequest = await normalizeRegistrationRequest(request);

    if (normalizedRequest === null) {
      return invalidClientMetadata();
    }

    request = normalizedRequest;
  }

  if (path === `${AUTH_BASE_PATH}/oauth2/authorize` || path === `${AUTH_BASE_PATH}/oauth2/token`) {
    const denied = await requireActiveClient(request, context.env, path);

    if (denied !== null) {
      return denied;
    }
  }

  let response: Response;
  const auth = createAuth(context);

  if (path === `${AUTH_BASE_PATH}/oauth2/revoke`) {
    const revocation = await revocationRequest(request);

    if (revocation === null) {
      return invalidAuthorizationRequest();
    }

    try {
      await revokeMcpAccessToken(
        context.env,
        auth,
        new URL(request.url).origin,
        revocation.token,
        revocation.clientId,
      );
      return new Response(null, {
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
        status: 200,
      });
    } catch {
      return authorizationUnavailable("provider");
    }
  }

  try {
    response = await auth.handler(request);
  } catch (error) {
    const protocolResponse = protocolError(error);

    if (protocolResponse !== null) {
      return protocolResponse;
    }

    return authorizationUnavailable("provider");
  }
  response = await normalizeProtocolErrorResponse(response);

  if (
    path !== `${AUTH_BASE_PATH}/oauth2/register` ||
    (response.status !== 200 && response.status !== 201)
  ) {
    return response;
  }

  try {
    if (!(await storeClientRegistrationLease(context.env, response))) {
      return authorizationUnavailable("client_lease");
    }

    return response.status === 201
      ? response
      : new Response(response.body, {
          headers: response.headers,
          status: 201,
        });
  } catch {
    return authorizationUnavailable("client_lease");
  }
}

export function registerAuthServerRoutes(worker: AuthApp, createAuth: AuthFactory): void {
  worker.all("/api/auth/*", (context) => handleAuthServerRequest(context, createAuth));
  worker.all("/.well-known/oauth-authorization-server/api/auth", (context) =>
    handleAuthServerRequest(context, createAuth),
  );
}

export function protectedResourceMetadata(origin: string): Response {
  return fixedJsonResponse(
    {
      authorization_servers: [`${origin}${AUTH_BASE_PATH}`],
      bearer_methods_supported: ["header"],
      resource: `${origin}/mcp`,
      scopes_supported: [OWNER_READ_SCOPE],
    },
    200,
  );
}

export async function purgeExpiredAuthRecords(env: Pick<WorkerEnv, "AUTH_DB">): Promise<void> {
  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  const now = new Date();
  const expiredClientIds = database
    .select({ clientId: mcpClientRegistration.clientId })
    .from(mcpClientRegistration)
    .where(lte(mcpClientRegistration.expiresAt, now));
  const activeClientIds = database
    .select({ clientId: mcpClientRegistration.clientId })
    .from(mcpClientRegistration)
    .where(gt(mcpClientRegistration.expiresAt, now));

  await database.delete(oauthAccessToken).where(lte(oauthAccessToken.expiresAt, now));
  await database.delete(oauthRefreshToken).where(lte(oauthRefreshToken.expiresAt, now));
  await database.delete(oauthClientAssertion).where(lte(oauthClientAssertion.expiresAt, now));
  await database.delete(verification).where(lte(verification.expiresAt, now));
  await database.delete(session).where(lte(session.expiresAt, now));
  await database.delete(mcpTokenRevocation).where(lte(mcpTokenRevocation.expiresAt, now));
  await database.delete(jwks).where(and(isNotNull(jwks.expiresAt), lte(jwks.expiresAt, now)));
  await database.delete(oauthConsent).where(inArray(oauthConsent.clientId, expiredClientIds));
  await database.delete(mcpClientRegistration).where(lte(mcpClientRegistration.expiresAt, now));
  await database.delete(oauthClient).where(notInArray(oauthClient.clientId, activeClientIds));
}
