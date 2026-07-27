import { OWNER_READ_SCOPE, ownerAuthoritySchema, type OwnerAuthority } from "@crewhelm/contracts";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import type { Context, Hono } from "hono";
import * as z from "zod";

import type { WorkerEnv } from "./env.js";
import { deriveOwnerKey } from "./owner-identity.js";

const GITHUB_ISSUER = "https://github.com";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const STATE_TTL_SECONDS = 10 * 60;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024;
const STATE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONSENT_COOKIE = "__Host-crewhelm-consent";
const GITHUB_STATE_COOKIE = "__Host-crewhelm-github-state";

const authRequestSchema = z.strictObject({
  clientId: z.string().min(1).max(2_048),
  codeChallenge: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  codeChallengeMethod: z.literal("S256"),
  redirectUri: z.url().max(2_048),
  resource: z.url().max(2_048),
  responseType: z.literal("code"),
  scope: z.tuple([z.literal(OWNER_READ_SCOPE)]),
  state: z.string().min(1).max(2_048),
});
const consentStateSchema = z.strictObject({
  client: z.strictObject({
    id: z.string().min(1).max(2_048),
    name: z.string().min(1).max(160),
    redirectOrigin: z.url().max(2_048),
  }),
  request: authRequestSchema,
});
const githubStateSchema = z.strictObject({
  request: authRequestSchema,
});
const authorizationFormSchema = z.strictObject({
  consent: z.string().regex(STATE_TOKEN_PATTERN),
  decision: z.enum(["approve", "deny"]),
});
const githubCallbackSchema = z.strictObject({
  code: z.string().min(1).max(1_024),
  state: z.string().regex(STATE_TOKEN_PATTERN),
});
const githubTokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4_096),
  scope: z.literal(""),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});
const githubUserSchema = z.looseObject({
  id: z.number().int().positive().safe(),
});
const configurationSchema = z.strictObject({
  GITHUB_CLIENT_ID: z.string().min(1).max(255),
  GITHUB_CLIENT_SECRET: z.string().min(1).max(1_024),
  OWNER_GITHUB_USER_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
});

type AuthorizationApp = Hono<{ Bindings: WorkerEnv }>;
type WorkerContext = Context<{ Bindings: WorkerEnv }>;
type AuthorizationUnavailableStage =
  | "callback_github_identity"
  | "callback_grant_write"
  | "callback_provider_binding"
  | "callback_state_read"
  | "consent_client_lookup"
  | "consent_provider_binding"
  | "consent_state_read"
  | "consent_state_write"
  | "github_configuration"
  | "github_state_write";

function readConfiguration(env: WorkerEnv): z.infer<typeof configurationSchema> | null {
  const result = configurationSchema.safeParse({
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    OWNER_GITHUB_USER_ID: env.OWNER_GITHUB_USER_ID,
  });

  return result.success ? result.data : null;
}

function fixedResponse(message: string, status: number): Response {
  return new Response(message, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
    status,
  });
}

function invalidAuthorizationRequest(): Response {
  return fixedResponse("Authorization request denied.\n", 400);
}

function authorizationUnavailable(stage: AuthorizationUnavailableStage): Response {
  console.error("crewhelm.authorization_unavailable", { stage });

  return fixedResponse("Authorization is temporarily unavailable.\n", 503);
}

function unauthorizedOwner(): Response {
  return fixedResponse("Authorization request denied.\n", 403);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function createStateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  return encodeBase64Url(bytes);
}

function stateKey(kind: "consent" | "github", token: string): string {
  return `crewhelm:oauth-state:${kind}:${token}`;
}

function stateCookie(name: string, value: string, maxAge = STATE_TTL_SECONDS): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

function clearStateCookie(name: string): string {
  return stateCookie(name, "", 0);
}

function readCookie(request: Request, name: string): string | null {
  if (!COOKIE_NAME_PATTERN.test(name)) {
    return null;
  }

  const header = request.headers.get("cookie");

  if (header === null || header.length > 4_096) {
    return null;
  }

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");

    if (rawName === name) {
      const value = rawValue.join("=");
      return STATE_TOKEN_PATTERN.test(value) ? value : null;
    }
  }

  return null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function consentPage(
  client: { id: string; name: string; redirectOrigin: string },
  consent: string,
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize Crewhelm</title>
  </head>
  <body>
    <main>
      <h1>Authorize Crewhelm</h1>
      <p><strong>${escapeHtml(client.name)}</strong> is requesting read-only access to your Crewhelm control-plane status.</p>
      <p>Client: <code>${escapeHtml(client.id)}</code></p>
      <p>After authorization, Crewhelm will return you to <code>${escapeHtml(client.redirectOrigin)}</code>.</p>
      <form method="post" action="/authorize">
        <input type="hidden" name="consent" value="${consent}">
        <button type="submit" name="decision" value="approve">Continue with GitHub</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </main>
  </body>
</html>
`;
}

function consentResponse(body: string, consent: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "set-cookie": stateCookie(CONSENT_COOKIE, consent),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
    status: 200,
  });
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string | null> {
  if (stream === null) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      body += decoder.decode();
      return body;
    }

    bytesRead += value.byteLength;

    if (bytesRead > maximumBytes) {
      await reader.cancel();
      return null;
    }

    body += decoder.decode(value, { stream: true });
  }
}

async function readAuthorizationForm(
  request: Request,
): Promise<z.infer<typeof authorizationFormSchema> | null> {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return null;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");

  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > MAX_FORM_BYTES
  ) {
    return null;
  }

  const body = await readBoundedText(request.body, MAX_FORM_BYTES);

  if (body === null) {
    return null;
  }

  const form = new URLSearchParams(body);

  if ([...form.keys()].some((key) => key !== "consent" && key !== "decision")) {
    return null;
  }

  if (form.getAll("consent").length !== 1 || form.getAll("decision").length !== 1) {
    return null;
  }

  const result = authorizationFormSchema.safeParse({
    consent: form.get("consent"),
    decision: form.get("decision"),
  });

  return result.success ? result.data : null;
}

async function getState<T>(
  namespace: KVNamespace,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const rawState = await namespace.get(key);

  if (rawState === null || rawState.length > 16 * 1_024) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(rawState);
  } catch {
    return null;
  }

  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

async function putState(namespace: KVNamespace, key: string, value: unknown): Promise<void> {
  await namespace.put(key, JSON.stringify(value), {
    expirationTtl: STATE_TTL_SECONDS,
  });
}

function normalizeAuthRequest(input: AuthRequest): z.infer<typeof authRequestSchema> | null {
  const result = authRequestSchema.safeParse(input);
  return result.success ? result.data : null;
}

function displayClient(
  client: ClientInfo,
  fallbackId: string,
  redirectUri: string,
): { id: string; name: string; redirectOrigin: string } {
  const name = client.clientName?.trim() || "An MCP client";

  return {
    id: fallbackId.slice(0, 2_048),
    name: Array.from(name).slice(0, 160).join(""),
    redirectOrigin: new URL(redirectUri).origin,
  };
}

function callbackUrl(request: Request): string {
  return new URL("/oauth/github/callback", request.url).toString();
}

function mcpResourceUrl(request: Request): string {
  return new URL("/mcp", request.url).toString();
}

function redirectResponse(location: string, cookies: string[] = []): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
    "referrer-policy": "no-referrer",
  });

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }

  return new Response(null, { headers, status: 302 });
}

function deniedAuthorization(): Response {
  const response = fixedResponse("Authorization denied. You may close this window.\n", 403);
  response.headers.append("set-cookie", clearStateCookie(CONSENT_COOKIE));
  return response;
}

function toOAuthAuthRequest(request: z.infer<typeof authRequestSchema>): AuthRequest {
  return {
    clientId: request.clientId,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    redirectUri: request.redirectUri,
    resource: request.resource,
    responseType: request.responseType,
    scope: request.scope,
    state: request.state,
  };
}

function githubAuthorizeRedirect(context: WorkerContext, githubState: string): Response | null {
  const configuration = readConfiguration(context.env);

  if (configuration === null) {
    return null;
  }

  const target = new URL(GITHUB_AUTHORIZE_URL);
  target.searchParams.set("client_id", configuration.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", callbackUrl(context.req.raw));
  target.searchParams.set("scope", "");
  target.searchParams.set("state", githubState);
  target.searchParams.set("allow_signup", "false");

  return new Response(null, {
    headers: {
      "cache-control": "no-store",
      location: target.toString(),
      "referrer-policy": "no-referrer",
      "set-cookie": stateCookie(GITHUB_STATE_COOKIE, githubState),
    },
    status: 302,
  });
}

async function exchangeGithubCode(context: WorkerContext, code: string): Promise<string | null> {
  const configuration = readConfiguration(context.env);

  if (configuration === null) {
    return null;
  }

  const response = await fetch(GITHUB_TOKEN_URL, {
    body: new URLSearchParams({
      client_id: configuration.GITHUB_CLIENT_ID,
      client_secret: configuration.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(context.req.raw),
    }),
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "crewhelm-worker",
    },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    return null;
  }

  const rawBody = await readBoundedText(response.body, MAX_GITHUB_RESPONSE_BYTES);

  if (rawBody === null) {
    return null;
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const token = githubTokenSchema.safeParse(body);
  return token.success ? token.data.access_token : null;
}

async function fetchGithubUserId(accessToken: string): Promise<string | null> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "crewhelm-worker",
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    return null;
  }

  const rawBody = await readBoundedText(response.body, MAX_GITHUB_RESPONSE_BYTES);

  if (rawBody === null) {
    return null;
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }

  const user = githubUserSchema.safeParse(body);
  return user.success ? String(user.data.id) : null;
}

async function authenticateGithubOwner(
  context: WorkerContext,
  code: string,
): Promise<string | null> {
  const accessToken = await exchangeGithubCode(context, code);

  if (accessToken === null) {
    return null;
  }

  return fetchGithubUserId(accessToken);
}

async function buildOwnerAuthority(
  context: WorkerContext,
  ownerGithubUserId: string,
  request: z.infer<typeof authRequestSchema>,
): Promise<OwnerAuthority | null> {
  const configuration = readConfiguration(context.env);

  if (configuration === null || ownerGithubUserId !== configuration.OWNER_GITHUB_USER_ID) {
    return null;
  }

  const ownerKey = await deriveOwnerKey({
    issuer: GITHUB_ISSUER,
    subject: ownerGithubUserId,
  });

  return ownerAuthoritySchema.parse({
    clientId: request.clientId,
    ownerKey,
    scopes: request.scope,
  });
}

async function showConsent(context: WorkerContext): Promise<Response> {
  const oauth = context.env.OAUTH_PROVIDER;

  if (oauth === undefined) {
    return authorizationUnavailable("consent_provider_binding");
  }

  let parsedRequest: AuthRequest;

  try {
    parsedRequest = await oauth.parseAuthRequest(context.req.raw);
  } catch {
    return invalidAuthorizationRequest();
  }

  const request = normalizeAuthRequest(parsedRequest);

  if (request === null || request.resource !== mcpResourceUrl(context.req.raw)) {
    return invalidAuthorizationRequest();
  }

  let client: ClientInfo | null;

  try {
    client = await oauth.lookupClient(request.clientId);
  } catch {
    return authorizationUnavailable("consent_client_lookup");
  }

  if (client === null) {
    return invalidAuthorizationRequest();
  }

  const consent = createStateToken();
  const storedState = consentStateSchema.parse({
    client: displayClient(client, request.clientId, request.redirectUri),
    request,
  });

  try {
    await putState(context.env.OAUTH_KV, stateKey("consent", consent), storedState);
  } catch {
    return authorizationUnavailable("consent_state_write");
  }

  return consentResponse(consentPage(storedState.client, consent), consent);
}

async function submitConsent(context: WorkerContext): Promise<Response> {
  const form = await readAuthorizationForm(context.req.raw);

  if (form === null || readCookie(context.req.raw, CONSENT_COOKIE) !== form.consent) {
    return invalidAuthorizationRequest();
  }

  const key = stateKey("consent", form.consent);
  let storedState: z.infer<typeof consentStateSchema> | null;

  try {
    storedState = await getState(context.env.OAUTH_KV, key, consentStateSchema);
    await context.env.OAUTH_KV.delete(key);
  } catch {
    return authorizationUnavailable("consent_state_read");
  }

  if (storedState === null) {
    return invalidAuthorizationRequest();
  }

  if (form.decision === "deny") {
    return deniedAuthorization();
  }

  const githubState = createStateToken();

  try {
    await putState(
      context.env.OAUTH_KV,
      stateKey("github", githubState),
      githubStateSchema.parse({ request: storedState.request }),
    );
  } catch {
    return authorizationUnavailable("github_state_write");
  }

  const response = githubAuthorizeRedirect(context, githubState);

  if (response === null) {
    await context.env.OAUTH_KV.delete(stateKey("github", githubState));
    return authorizationUnavailable("github_configuration");
  }

  response.headers.append("set-cookie", clearStateCookie(CONSENT_COOKIE));
  return response;
}

async function completeGithubAuthorization(context: WorkerContext): Promise<Response> {
  const oauth = context.env.OAUTH_PROVIDER;

  if (oauth === undefined) {
    return authorizationUnavailable("callback_provider_binding");
  }

  const callback = githubCallbackSchema.safeParse({
    code: context.req.query("code"),
    state: context.req.query("state"),
  });

  if (
    !callback.success ||
    readCookie(context.req.raw, GITHUB_STATE_COOKIE) !== callback.data.state
  ) {
    return invalidAuthorizationRequest();
  }

  const key = stateKey("github", callback.data.state);
  let storedState: z.infer<typeof githubStateSchema> | null;

  try {
    storedState = await getState(context.env.OAUTH_KV, key, githubStateSchema);
    await context.env.OAUTH_KV.delete(key);
  } catch {
    return authorizationUnavailable("callback_state_read");
  }

  if (storedState === null) {
    return invalidAuthorizationRequest();
  }

  let githubUserId: string | null;

  try {
    githubUserId = await authenticateGithubOwner(context, callback.data.code);
  } catch {
    return authorizationUnavailable("callback_github_identity");
  }

  if (githubUserId === null) {
    return unauthorizedOwner();
  }

  const authority = await buildOwnerAuthority(context, githubUserId, storedState.request);

  if (authority === null) {
    return unauthorizedOwner();
  }

  let redirectTo: string;

  try {
    ({ redirectTo } = await oauth.completeAuthorization({
      metadata: {
        identityProvider: "github",
      },
      props: {
        authority,
      },
      request: toOAuthAuthRequest(storedState.request),
      revokeExistingGrants: true,
      scope: authority.scopes,
      userId: authority.ownerKey,
    }));
  } catch {
    return authorizationUnavailable("callback_grant_write");
  }

  return redirectResponse(redirectTo, [clearStateCookie(GITHUB_STATE_COOKIE)]);
}

export function registerGithubAuthorizationRoutes(worker: AuthorizationApp): void {
  worker.get("/authorize", showConsent);
  worker.post("/authorize", submitConsent);
  worker.all("/authorize", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/github/callback", completeGithubAuthorization);
  worker.all("/oauth/github/callback", () => fixedResponse("Method not allowed.\n", 405));
}
