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
import { OAUTH_SCOPES, oauthScopeClaimSchema } from "./scopes.js";
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
} from "./schema.js";
import type { WorkerEnv } from "../env.js";
import { readBoundedPostRequest } from "../http/request-body.js";

const MAX_OAUTH_REQUEST_BYTES = 8 * 1024;
const CLIENT_REGISTRATION_TTL_SECONDS = 30 * 24 * 60 * 60;
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
const storedClientMetadataSchema = z.record(z.string(), z.unknown());
const oauthErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const registrationGrantTypesSchema = z
  .array(z.enum(["authorization_code", "refresh_token"]))
  .min(1)
  .max(2)
  .refine(
    (grantTypes) =>
      grantTypes.includes("authorization_code") && new Set(grantTypes).size === grantTypes.length,
    "Unsupported client grant types.",
  );
const registrationApplicationTypeSchema = z.enum(["native", "web"]);
const registrationRequestSchema = z.object({
  application_type: registrationApplicationTypeSchema.optional(),
  backchannel_logout_session_required: z.never().optional(),
  backchannel_logout_uri: z.never().optional(),
  client_name: z.string().min(1).max(160).optional(),
  dpop_bound_access_tokens: z.never().optional(),
  grant_types: registrationGrantTypesSchema.optional(),
  redirect_uris: z.array(z.string().min(1).max(2_048)).min(1).max(8),
  require_pkce: z.literal(true).optional(),
  resources: z.array(z.url().max(2_048)).max(1).optional(),
  response_types: z.tuple([z.literal("code")]).optional(),
  scope: oauthScopeClaimSchema.optional(),
  skip_consent: z.never().optional(),
  token_endpoint_auth_method: z.literal("none").optional(),
  type: z.never().optional(),
});
const tokenClientSchema = z.string().min(1).max(2_048);
const authorizationRequestSchema = z.strictObject({
  clientId: tokenClientSchema,
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  codeChallengeMethod: z.literal("S256"),
  resource: z.url().max(2_048),
  responseType: z.literal("code"),
  scope: oauthScopeClaimSchema,
});
const tokenRequestSchema = z.discriminatedUnion("grantType", [
  z.strictObject({
    clientId: tokenClientSchema,
    grantType: z.literal("authorization_code"),
    refreshToken: z.undefined(),
    resource: z.url().max(2_048),
  }),
  z.strictObject({
    clientId: tokenClientSchema,
    grantType: z.literal("refresh_token"),
    refreshToken: z.string().min(1).max(8_192),
    resource: z.url().max(2_048).optional(),
  }),
]);
const revocationRequestSchema = z.strictObject({
  clientId: tokenClientSchema,
  token: z.string().min(1).max(8_192),
  tokenTypeHint: z.enum(["access_token", "refresh_token"]).optional(),
});

type AuthApp = Hono<{ Bindings: WorkerEnv }>;
type WorkerContext = Context<{ Bindings: WorkerEnv }>;
type AuthFactory = (context: WorkerContext) => Pick<CrewhelmAuth, "handler">;
type RegistrationApplicationType = z.infer<typeof registrationApplicationTypeSchema>;
type NormalizedRegistration = {
  applicationType: RegistrationApplicationType | undefined;
  request: Request;
};

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

function hasDuplicateJsonObjectMembers(source: string): boolean {
  const containers: Array<{ kind: "array" } | { kind: "object"; members: Set<string> }> = [];

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === "{") {
      containers.push({ kind: "object", members: new Set() });
      continue;
    }

    if (character === "[") {
      containers.push({ kind: "array" });
      continue;
    }

    if (character === "}" || character === "]") {
      containers.pop();
      continue;
    }

    if (character !== '"') {
      continue;
    }

    const start = index;

    for (index += 1; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
      } else if (source[index] === '"') {
        break;
      }
    }

    let next = index + 1;

    while (next < source.length && /\s/u.test(source[next] ?? "")) {
      next += 1;
    }

    const container = containers.at(-1);

    if (source[next] !== ":" || container?.kind !== "object") {
      continue;
    }

    let member: unknown;

    try {
      member = JSON.parse(source.slice(start, index + 1));
    } catch {
      continue;
    }

    if (typeof member !== "string") {
      continue;
    }

    if (container.members.has(member)) {
      return true;
    }

    container.members.add(member);
  }

  return false;
}

function decodeStoredClientMetadata(value: unknown): Record<string, unknown> | null {
  let decoded = value;

  for (let depth = 0; depth < 2 && typeof decoded === "string"; depth += 1) {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  const metadata = storedClientMetadataSchema.safeParse(decoded);
  return metadata.success ? metadata.data : null;
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

function successfulRevocationResponse(): Response {
  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    status: 200,
  });
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

async function normalizeAuthorizationServerMetadata(response: Response): Promise<Response> {
  if (!response.ok) {
    return response;
  }

  let body: unknown;

  try {
    body = await response.clone().json();
  } catch {
    return response;
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return response;
  }

  const metadata = {
    ...body,
    scopes_supported: [...OAUTH_SCOPES],
  };
  Reflect.deleteProperty(metadata, "authorization_response_iss_parameter_supported");

  return fixedJsonResponse(metadata, response.status, response.headers);
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

async function normalizeRegistrationRequest(
  request: Request,
): Promise<NormalizedRegistration | null> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return null;
  }

  let body: unknown;

  try {
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      await request.clone().arrayBuffer(),
    );

    if (hasDuplicateJsonObjectMembers(source)) {
      return null;
    }

    body = JSON.parse(source);
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
    (registration.data.application_type === "web" &&
      !registration.data.redirect_uris.every(
        (redirect) => new URL(redirect).protocol === "https:",
      )) ||
    (registration.data.resources !== undefined &&
      (registration.data.resources.length !== 1 || registration.data.resources[0] !== resource))
  ) {
    return null;
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");

  return {
    applicationType: registration.data.application_type,
    request: new Request(request.url, {
      body: JSON.stringify({
        client_name: registration.data.client_name,
        grant_types: registration.data.grant_types ?? ["authorization_code"],
        redirect_uris: registration.data.redirect_uris,
        require_pkce: true,
        resources: [resource],
        response_types: ["code"],
        scope: registration.data.scope,
        token_endpoint_auth_method: "none",
      }),
      headers,
      method: "POST",
    }),
  };
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

function normalizeAuthorizationResource(request: Request): Request | null {
  const url = new URL(request.url);
  const resources = url.searchParams.getAll("resource");

  if (resources.length <= 1) {
    return request;
  }

  const resource = resources[0];

  if (resource === undefined || resources.some((candidate) => candidate !== resource)) {
    return null;
  }

  url.searchParams.delete("resource");
  url.searchParams.set("resource", resource);
  return new Request(url, request);
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
      refreshToken:
        form.getAll("refresh_token").length === 0
          ? undefined
          : form.getAll("refresh_token").length === 1
            ? form.get("refresh_token")
            : null,
      resource:
        form.getAll("resource").length === 0
          ? undefined
          : form.getAll("resource").length === 1
            ? form.get("resource")
            : null,
    });

    if (!tokenRequest.success) {
      return null;
    }

    return tokenRequest.data.resource === undefined ||
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

async function finalizeClientRegistration(
  env: WorkerEnv,
  response: Response,
  applicationType: RegistrationApplicationType | undefined,
): Promise<Response | null> {
  let body: unknown;

  try {
    body = await response.clone().json();
  } catch {
    return null;
  }

  const registration = registrationResponseSchema.safeParse(body);

  if (!registration.success) {
    return null;
  }

  const now = new Date();
  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  const leaseInsert = database.insert(mcpClientRegistration).values({
    clientId: registration.data.client_id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CLIENT_REGISTRATION_TTL_SECONDS * 1_000),
  });

  if (applicationType === undefined) {
    await leaseInsert;
  } else {
    const storedClients = await database
      .select({ metadata: oauthClient.metadata })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, registration.data.client_id))
      .limit(1);
    const storedClient = storedClients[0];

    if (storedClient === undefined) {
      return null;
    }

    const metadata = decodeStoredClientMetadata(storedClient.metadata);

    if (metadata === null) {
      return null;
    }

    await database.batch([
      database
        .update(oauthClient)
        .set({
          metadata: {
            ...metadata,
            application_type: applicationType,
          },
        })
        .where(eq(oauthClient.clientId, registration.data.client_id)),
      leaseInsert,
    ]);
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");

  return new Response(
    `${JSON.stringify(
      applicationType === undefined
        ? registration.data
        : { ...registration.data, application_type: applicationType },
    )}\n`,
    {
      headers,
      status: 201,
    },
  );
}

export async function handleAuthServerRequest(
  context: WorkerContext,
  createAuth: AuthFactory,
): Promise<Response> {
  let request = await boundedAuthRequest(context.req.raw);
  let registrationApplicationType: RegistrationApplicationType | undefined;

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

    registrationApplicationType = normalizedRequest.applicationType;
    request = normalizedRequest.request;
  }

  if (path === `${AUTH_BASE_PATH}/oauth2/authorize`) {
    const normalizedRequest = normalizeAuthorizationResource(request);

    if (normalizedRequest === null) {
      return invalidAuthorizationRequest();
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
      const recognizedAccessToken =
        revocation.tokenTypeHint === "refresh_token"
          ? false
          : await revokeMcpAccessToken(
              context.env,
              auth,
              new URL(request.url).origin,
              revocation.token,
              revocation.clientId,
            );

      if (recognizedAccessToken || revocation.tokenTypeHint === "access_token") {
        return successfulRevocationResponse();
      }

      return await normalizeProtocolErrorResponse(await auth.handler(request));
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
    path === `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server` ||
    path === `/.well-known/oauth-authorization-server${AUTH_BASE_PATH}`
  ) {
    response = await normalizeAuthorizationServerMetadata(response);
  }

  if (
    path !== `${AUTH_BASE_PATH}/oauth2/register` ||
    (response.status !== 200 && response.status !== 201)
  ) {
    return response;
  }

  try {
    const registration = await finalizeClientRegistration(
      context.env,
      response,
      registrationApplicationType,
    );

    if (registration === null) {
      return authorizationUnavailable("client_lease");
    }

    return registration;
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
      scopes_supported: [...OAUTH_SCOPES],
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
