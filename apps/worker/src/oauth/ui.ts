import type { Context, Hono } from "hono";
import * as z from "zod";

import {
  FULL_ACCESS_SCOPE,
  USE_ACCESS_SCOPE,
  VIEW_ACCESS_SCOPE,
  accessLevelScopeSchema,
} from "./access-levels.js";
import type { CrewhelmAuth } from "./auth.js";
import { OFFLINE_ACCESS_SCOPE, oauthScopeClaimSchema } from "./scopes.js";
import type { WorkerEnv } from "../env.js";
import {
  escapePageHtml,
  renderWorkerPage,
  workerPageResponse,
  workerStylesheetResponse,
} from "../http/page.js";
import { readBoundedPostRequest } from "../http/request-body.js";

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
  scope: oauthScopeClaimSchema,
});
const publicClientSchema = z.looseObject({
  client_id: z.string().min(1).max(2_048),
  client_name: z.string().min(1).max(160).optional(),
});
const navigationResultSchema = z.looseObject({
  redirect_uri: z.url().max(2_048).optional(),
  url: z.url().max(2_048).optional(),
});
const navigationJsonSchema = z.strictObject({
  redirectUrl: z.url().max(2_048),
});
export const OAUTH_ACTIONS_SCRIPT = `
const consentForms = document.querySelectorAll("[data-consent-form]");
const navigationStarts = document.querySelectorAll("[data-navigation-start]");

navigationStarts.forEach((link) => {
  link.addEventListener("click", (event) => {
    if (link.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
      return;
    }

    link.setAttribute("aria-disabled", "true");
    link.setAttribute("aria-busy", "true");
    const pendingLabel = link.getAttribute("data-pending-label");
    if (pendingLabel) {
      link.textContent = pendingLabel;
    }
  });
});

consentForms.forEach((consentForm) => {
  consentForm.addEventListener("submit", () => {
    const submittingButton = consentForm.querySelector("button[type=submit]");
    const buttons = document.querySelectorAll("[data-consent-form] button");
    buttons.forEach((button) => {
      button.disabled = true;
    });
    if (submittingButton) {
      submittingButton.setAttribute("aria-busy", "true");
      const pendingLabel = submittingButton.getAttribute("data-pending-label");
      if (pendingLabel) {
        submittingButton.textContent = pendingLabel;
      }
    }
  });
});
`.trim();

type OAuthApp = Hono<{ Bindings: WorkerEnv }>;
type WorkerContext = Context<{ Bindings: WorkerEnv }>;
type AuthFactory = (context: WorkerContext) => CrewhelmAuth;

function actionsScriptResponse(): Response {
  return new Response(`${OAUTH_ACTIONS_SCRIPT}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
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

function isTrustedFormNavigation(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (origin !== null && origin !== "null") {
    return origin === new URL(request.url).origin;
  }

  return (
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

async function readForm(
  request: Request,
  allowedKeys: ReadonlySet<string>,
): Promise<Record<string, string> | null> {
  if (
    !isTrustedFormNavigation(request) ||
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
  headers.set("origin", new URL(request.url).origin);
  return headers;
}

function authUrl(request: Request, path: string): string {
  return new URL(`/api/auth${path}`, request.url).toString();
}

async function navigationTarget(response: Response, request: Request): Promise<URL | null> {
  const location = response.headers.get("location");

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
    return null;
  }

  const targetUrl = new URL(target, request.url);

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    return null;
  }

  return targetUrl;
}

async function navigationResponse(response: Response, request: Request): Promise<Response> {
  const targetUrl = await navigationTarget(response, request);

  if (targetUrl === null) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("location", targetUrl.toString());
  return new Response(null, { headers, status: 302 });
}

async function navigationJsonResponse(response: Response, request: Request): Promise<Response> {
  const targetUrl = await navigationTarget(response, request);

  if (targetUrl === null) {
    return response;
  }

  return Response.json(navigationJsonSchema.parse({ redirectUrl: targetUrl.toString() }), {
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export function renderOAuthLoginPage(query: string): string {
  return renderWorkerPage({
    body: `      <p class="ch-copy">Crewhelm uses the GitHub account configured for this deployment to verify owner authority.</p>
      <input type="hidden" name="oauth_query" value="${escapePageHtml(query)}">
      <div class="ch-actions">
        <a class="ch-button ch-button--primary" href="/oauth/login/continue?${escapePageHtml(query)}" data-navigation-start data-pending-label="Opening GitHub…">Continue with GitHub</a>
      </div>`,
    heading: "Continue as the owner.",
    scriptPath: "/oauth/actions.js",
    title: "Sign in to Crewhelm",
  });
}

export function renderOAuthCompletionPage(): string {
  return renderWorkerPage({
    body: '      <p class="ch-copy">Crewhelm completed this handoff. You can close this window and return to your MCP client.</p>',
    heading: "Authorization returned to your client.",
    title: "Crewhelm authorization complete",
  });
}

export function renderOAuthConsentPage(
  query: string,
  client: { id: string; name: string },
  redirectOrigin: string,
  scope: z.infer<typeof oauthScopeClaimSchema>,
): string {
  const requestedScopes = scope.split(" ");
  const usesAccessLevels = requestedScopes.some(
    (requestedScope) => accessLevelScopeSchema.safeParse(requestedScope).success,
  );
  const requestedAccessLevel = requestedScopes.includes(FULL_ACCESS_SCOPE)
    ? FULL_ACCESS_SCOPE
    : requestedScopes.includes(USE_ACCESS_SCOPE)
      ? USE_ACCESS_SCOPE
      : VIEW_ACCESS_SCOPE;
  const permissions = [
    !usesAccessLevels
      ? '<li class="ch-permission"><strong>Existing client access:</strong> keep the Crewhelm permissions granted to this client before the access-level upgrade.</li>'
      : "",
    usesAccessLevels && requestedAccessLevel === VIEW_ACCESS_SCOPE
      ? '<li class="ch-permission"><strong>View only:</strong> inspect Agent configuration, run history, connections, and integration metadata.</li>'
      : "",
    usesAccessLevels && requestedAccessLevel === USE_ACCESS_SCOPE
      ? '<li class="ch-permission"><strong>Use agents:</strong> start and cancel runs, reconcile interrupted work, and decide tool approvals.</li>'
      : "",
    usesAccessLevels && requestedAccessLevel === FULL_ACCESS_SCOPE
      ? '<li class="ch-permission"><strong>Full control:</strong> create and reconfigure Agents, integrations, schedules, standing authority, and fleet policy.</li>'
      : "",
    requestedScopes.includes(OFFLINE_ACCESS_SCOPE)
      ? '<li class="ch-permission">Keep this MCP client signed in using a rotating, revocable refresh token.</li>'
      : "",
  ].join("");

  return renderWorkerPage({
    body: `      <p class="ch-copy"><strong>${escapePageHtml(client.name)}</strong> is requesting this authority:</p>
      <ul class="ch-permissions">${permissions}</ul>
      <div class="ch-meta">
        <p>Client: <code>${escapePageHtml(client.id)}</code></p>
        <p>After authorization, Crewhelm will return you to <code>${escapePageHtml(redirectOrigin)}</code>.</p>
      </div>
      <div class="ch-actions">
        <form method="post" action="/oauth/consent" data-consent-form>
          <input type="hidden" name="oauth_query" value="${escapePageHtml(query)}">
          <input type="hidden" name="decision" value="approve">
          <button class="ch-button ch-button--primary" type="submit" data-pending-label="Granting access…">Grant access</button>
        </form>
        <form method="post" action="/oauth/consent" data-consent-form>
          <input type="hidden" name="oauth_query" value="${escapePageHtml(query)}">
          <input type="hidden" name="decision" value="deny">
          <button class="ch-button ch-button--quiet" type="submit" data-pending-label="Denying…">Deny</button>
        </form>
      </div>`,
    heading: "Review requested authority.",
    scriptPath: "/oauth/actions.js",
    title: "Authorize Crewhelm",
    tone: "warning",
  });
}

async function showLogin(context: WorkerContext): Promise<Response> {
  const query = signedQuery(context.req.raw);
  return query === null
    ? authorizationDenied()
    : workerPageResponse(renderOAuthLoginPage(query), { connections: true, scripts: true });
}

async function submitLogin(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const values = await readForm(context.req.raw, new Set(["oauth_query"]));
  const form = loginFormSchema.safeParse(values);

  if (!form.success) {
    return authorizationDenied();
  }

  return startLogin(context, createAuth, form.data.oauth_query);
}

async function continueLogin(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const query = signedQuery(context.req.raw);
  return query === null ? authorizationDenied() : startLogin(context, createAuth, query);
}

async function startLogin(
  context: WorkerContext,
  createAuth: AuthFactory,
  oauthQuery: string,
): Promise<Response> {
  try {
    return navigationResponse(
      await createAuth(context).handler(
        new Request(authUrl(context.req.raw, "/sign-in/social"), {
          body: JSON.stringify({
            callbackURL: "/",
            oauth_query: oauthQuery,
            provider: "github",
          }),
          headers: navigationHeaders(context.req.raw),
          method: "POST",
        }),
      ),
      context.req.raw,
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

    const redirectOrigin = new URL(parsedQuery.data.redirect_uri).origin;

    return workerPageResponse(
      renderOAuthConsentPage(
        query,
        {
          id: client.data.client_id,
          name: client.data.client_name ?? "An MCP client",
        },
        redirectOrigin,
        parsedQuery.data.scope,
      ),
      {
        connections: true,
        formActionOrigin: redirectOrigin,
        forms: true,
        scripts: true,
      },
    );
  } catch {
    return authorizationUnavailable("consent");
  }
}

async function submitConsent(context: WorkerContext, createAuth: AuthFactory): Promise<Response> {
  const values = await readForm(context.req.raw, new Set(["decision", "oauth_query"]));

  if (values === null) {
    console.warn("crewhelm.authorization_denied", {
      contentLength: context.req.raw.headers.get("content-length"),
      contentType: context.req.raw.headers.get("content-type"),
      hasOrigin: context.req.raw.headers.has("origin"),
      reason: "invalid_form_request",
      secFetchMode: context.req.raw.headers.get("sec-fetch-mode"),
      secFetchSite: context.req.raw.headers.get("sec-fetch-site"),
      stage: "consent",
    });
  }

  const form = consentFormSchema.safeParse(values);

  if (!form.success) {
    if (values !== null) {
      console.warn("crewhelm.authorization_denied", {
        reason: "invalid_form_payload",
        stage: "consent",
      });
    }
    return authorizationDenied();
  }

  return startConsent(
    context,
    createAuth,
    form.data.oauth_query,
    form.data.decision,
    context.req.raw.headers.get("accept") === "application/json",
  );
}

async function startConsent(
  context: WorkerContext,
  createAuth: AuthFactory,
  oauthQuery: string,
  decision: "approve" | "deny",
  jsonNavigation = false,
): Promise<Response> {
  const scopeValues = new URLSearchParams(oauthQuery).getAll("scope");
  const requestedScope = oauthScopeClaimSchema.safeParse(
    scopeValues.length === 1 ? scopeValues[0] : undefined,
  );

  if (!requestedScope.success) {
    console.warn("crewhelm.authorization_denied", {
      reason: "invalid_scope",
      stage: "consent",
    });
    return authorizationDenied();
  }

  try {
    const response = await createAuth(context).handler(
      new Request(authUrl(context.req.raw, "/oauth2/consent"), {
        body: JSON.stringify({
          accept: decision === "approve",
          oauth_query: oauthQuery,
          scope: requestedScope.data,
        }),
        headers: navigationHeaders(context.req.raw),
        method: "POST",
      }),
    );

    return jsonNavigation
      ? navigationJsonResponse(response, context.req.raw)
      : navigationResponse(response, context.req.raw);
  } catch {
    return authorizationUnavailable("consent");
  }
}

export function registerOAuthUiRoutes(worker: OAuthApp, createAuth: AuthFactory): void {
  worker.get("/oauth/error", authorizationError);
  worker.all("/oauth/error", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/complete", () => workerPageResponse(renderOAuthCompletionPage()));
  worker.all("/oauth/complete", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/styles.css", workerStylesheetResponse);
  worker.all("/oauth/styles.css", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/actions.js", actionsScriptResponse);
  worker.all("/oauth/actions.js", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/login/continue", (context) => continueLogin(context, createAuth));
  worker.all("/oauth/login/continue", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/login", showLogin);
  worker.post("/oauth/login", (context) => submitLogin(context, createAuth));
  worker.all("/oauth/login", () => fixedResponse("Method not allowed.\n", 405));
  worker.get("/oauth/consent", (context) => showConsent(context, createAuth));
  worker.post("/oauth/consent", (context) => submitConsent(context, createAuth));
  worker.all("/oauth/consent", () => fixedResponse("Method not allowed.\n", 405));
}
