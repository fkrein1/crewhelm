import { OWNER_READ_SCOPE } from "@crewhelm/contracts";
import type { Context, Hono } from "hono";
import * as z from "zod";

import type { CrewhelmAuth } from "./auth.js";
import type { WorkerEnv } from "./env.js";
import { readBoundedPostRequest } from "./request-body.js";

const MAX_OAUTH_FORM_BYTES = 8 * 1024;
const SIGNED_QUERY_PATTERN = /^[A-Za-z0-9%._~!$&'()*+,;=:@/?-]+$/;
const signedQuerySchema = z.string().min(1).max(8_192).regex(SIGNED_QUERY_PATTERN);
const loginFormSchema = z.strictObject({
  oauth_query: signedQuerySchema,
});
const consentFormSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  oauth_query: signedQuerySchema,
});
const consentQuerySchema = z.looseObject({
  client_id: z.string().min(1).max(2_048),
  redirect_uri: z.url().max(2_048),
  scope: z.literal(OWNER_READ_SCOPE),
});
const publicClientSchema = z.looseObject({
  client_id: z.string().min(1).max(2_048),
  client_name: z.string().min(1).max(160).optional(),
});
const navigationResultSchema = z.looseObject({
  redirect_uri: z.url().max(2_048).optional(),
  url: z.url().max(2_048).optional(),
});

type OAuthApp = Hono<{ Bindings: WorkerEnv }>;
type WorkerContext = Context<{ Bindings: WorkerEnv }>;
type AuthFactory = (context: WorkerContext) => CrewhelmAuth;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
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

function authorizationDenied(): Response {
  return fixedResponse("Authorization request denied.\n", 400);
}

function authorizationError(): Response {
  return fixedResponse("Authorization could not be completed.\n", 400);
}

function authorizationUnavailable(stage: "consent" | "login"): Response {
  console.error("crewhelm.authorization_unavailable", { stage });
  return fixedResponse("Authorization is temporarily unavailable.\n", 503);
}

function signedQuery(request: Request): string | null {
  const query = new URL(request.url).search.slice(1);
  const result = signedQuerySchema.safeParse(query);
  return result.success ? result.data : null;
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

async function readForm(
  request: Request,
  allowedKeys: ReadonlySet<string>,
): Promise<Record<string, string> | null> {
  if (
    !isSameOrigin(request) ||
    !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
  ) {
    return null;
  }

  const boundedRequest = await readBoundedPostRequest(request, MAX_OAUTH_FORM_BYTES);

  if (boundedRequest === null) {
    return null;
  }

  const form = await boundedRequest.formData();
  const keys = [...form.keys()];

  if (
    keys.some((key) => !allowedKeys.has(key)) ||
    [...allowedKeys].some((key) => form.getAll(key).length !== 1)
  ) {
    return null;
  }

  const values: Record<string, string> = {};

  for (const key of allowedKeys) {
    const value = form.get(key);

    if (typeof value !== "string") {
      return null;
    }

    values[key] = value;
  }

  return values;
}

function navigationHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.set("accept", "text/html");
  headers.set("content-type", "application/json");
  return headers;
}

function authUrl(request: Request, path: string): string {
  return new URL(`/api/auth${path}`, request.url).toString();
}

async function navigationResponse(response: Response): Promise<Response> {
  const location = response.headers.get("location");

  if (location !== null && response.status >= 300 && response.status < 400) {
    return response;
  }

  let target = location;

  if (target === null && response.ok) {
    try {
      const result = navigationResultSchema.safeParse(await response.clone().json());
      target = result.success ? (result.data.redirect_uri ?? result.data.url ?? null) : null;
    } catch {
      target = null;
    }
  }

  if (target === null) {
    return response;
  }

  const targetUrl = new URL(target);

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return authorizationDenied();
  }

  const headers = new Headers(response.headers);
  headers.set("location", targetUrl.toString());
  return new Response(null, { headers, status: 302 });
}

function loginPage(query: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to Crewhelm</title>
  </head>
  <body>
    <main>
      <h1>Sign in to Crewhelm</h1>
      <p>Continue with the GitHub account configured as this Crewhelm deployment's owner.</p>
      <form method="post" action="/oauth/login">
        <input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
        <button type="submit">Continue with GitHub</button>
      </form>
    </main>
  </body>
</html>
`;
}

function consentPage(
  query: string,
  client: { id: string; name: string },
  redirectOrigin: string,
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
      <p>After authorization, Crewhelm will return you to <code>${escapeHtml(redirectOrigin)}</code>.</p>
      <form method="post" action="/oauth/consent">
        <input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
        <button type="submit" name="decision" value="approve">Authorize</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </form>
    </main>
  </body>
</html>
`;
}

async function showLogin(context: WorkerContext): Promise<Response> {
  const query = signedQuery(context.req.raw);
  return query === null ? authorizationDenied() : htmlResponse(loginPage(query));
}

async function submitLogin(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const values = await readForm(context.req.raw, new Set(["oauth_query"]));
  const form = loginFormSchema.safeParse(values);

  if (!form.success) {
    return authorizationDenied();
  }

  try {
    return navigationResponse(
      await createAuth(context).handler(
        new Request(authUrl(context.req.raw, "/sign-in/social"), {
          body: JSON.stringify({
            callbackURL: "/",
            oauth_query: form.data.oauth_query,
            provider: "github",
          }),
          headers: navigationHeaders(context.req.raw),
          method: "POST",
        }),
      ),
    );
  } catch {
    return authorizationUnavailable("login");
  }
}

async function showConsent(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const query = signedQuery(context.req.raw);
  const parsedQuery = consentQuerySchema.safeParse({
    client_id: context.req.query("client_id"),
    redirect_uri: context.req.query("redirect_uri"),
    scope: context.req.query("scope"),
  });

  if (query === null || !parsedQuery.success) {
    return authorizationDenied();
  }

  try {
    const headers = new Headers(context.req.raw.headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    headers.set("origin", new URL(context.req.url).origin);
    const clientResponse = await createAuth(context).handler(
      new Request(authUrl(context.req.raw, "/oauth2/public-client-prelogin"), {
        body: JSON.stringify({
          client_id: parsedQuery.data.client_id,
          oauth_query: query,
        }),
        headers,
        method: "POST",
      }),
    );

    if (!clientResponse.ok) {
      return authorizationDenied();
    }

    const rawClient: unknown = await clientResponse.json();
    const client = publicClientSchema.safeParse(rawClient);

    if (!client.success || client.data.client_id !== parsedQuery.data.client_id) {
      return authorizationDenied();
    }

    return htmlResponse(
      consentPage(
        query,
        {
          id: client.data.client_id,
          name: client.data.client_name ?? "An MCP client",
        },
        new URL(parsedQuery.data.redirect_uri).origin,
      ),
    );
  } catch {
    return authorizationUnavailable("consent");
  }
}

async function submitConsent(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const values = await readForm(context.req.raw, new Set(["decision", "oauth_query"]));
  const form = consentFormSchema.safeParse(values);

  if (!form.success) {
    return authorizationDenied();
  }

  try {
    return navigationResponse(
      await createAuth(context).handler(
        new Request(authUrl(context.req.raw, "/oauth2/consent"), {
          body: JSON.stringify({
            accept: form.data.decision === "approve",
            oauth_query: form.data.oauth_query,
            scope: OWNER_READ_SCOPE,
          }),
          headers: navigationHeaders(context.req.raw),
          method: "POST",
        }),
      ),
    );
  } catch {
    return authorizationUnavailable("consent");
  }
}

export function registerOAuthUiRoutes(worker: OAuthApp, createAuth: AuthFactory): void {
  worker.get("/oauth/error", authorizationError);
  worker.all("/oauth/error", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/login", showLogin);
  worker.post("/oauth/login", (context) => submitLogin(context, createAuth));
  worker.all("/oauth/login", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/consent", (context) => showConsent(context, createAuth));
  worker.post("/oauth/consent", (context) => submitConsent(context, createAuth));
  worker.all("/oauth/consent", () => fixedResponse("Method not allowed.\n", 405));
}
