import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  AUTONOMY_WRITE_SCOPE,
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
} from "@crewhelm/contracts";
import type { Context, Hono } from "hono";
import * as z from "zod";

import type { CrewhelmAuth } from "./auth.js";
import { OFFLINE_ACCESS_SCOPE, oauthScopeClaimSchema } from "./scopes.js";
import type { WorkerEnv } from "../env.js";
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
const OAUTH_STYLES = `
:root {
  color-scheme: light;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #18212f;
  background: #f4f6f8;
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

body {
  min-height: 100vh;
  margin: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  background:
    radial-gradient(circle at top, #ffffff 0, #f4f6f8 52%),
    #f4f6f8;
}

main {
  width: min(100%, 560px);
  padding: 36px;
  border: 1px solid #dfe4ea;
  border-radius: 16px;
  background: #ffffff;
  box-shadow: 0 18px 50px rgb(25 35 50 / 9%);
}

.eyebrow {
  margin: 0 0 12px;
  color: #526071;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 12px;
  color: #111827;
  font-size: clamp(28px, 5vw, 36px);
  line-height: 1.12;
  letter-spacing: -0.025em;
}

p,
li {
  color: #526071;
  line-height: 1.6;
}

ul {
  margin: 20px 0;
  padding: 18px 18px 18px 38px;
  border-radius: 10px;
  background: #f7f8fa;
}

li + li {
  margin-top: 8px;
}

.meta {
  padding-top: 16px;
  border-top: 1px solid #e6e9ee;
  font-size: 14px;
}

code {
  overflow-wrap: anywhere;
  color: #263244;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 26px;
}

.actions form {
  margin: 0;
}

button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid transparent;
  border-radius: 9px;
  text-decoration: none;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}

button:hover,
.button:hover {
  transform: translateY(-1px);
}

button:focus-visible,
.button:focus-visible {
  outline: 3px solid rgb(37 99 235 / 28%);
  outline-offset: 2px;
}

button:disabled,
.button[aria-disabled="true"] {
  cursor: wait;
  opacity: 0.62;
  transform: none;
  box-shadow: none;
}

.primary {
  color: #ffffff;
  background: #18212f;
  box-shadow: 0 6px 16px rgb(24 33 47 / 18%);
}

.secondary {
  color: #344054;
  border-color: #d0d5dd;
  background: #ffffff;
}

@media (max-width: 520px) {
  body {
    padding: 14px;
  }

  main {
    padding: 26px 22px;
    border-radius: 13px;
  }

  .actions button,
  .actions .button,
  .actions form {
    width: 100%;
  }
}
`.trim();
const OAUTH_ACTIONS_SCRIPT = `
const consentForms = document.querySelectorAll("[data-consent-form]");
const navigationLink = document.querySelector("[data-navigation-link]");
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
  consentForm.addEventListener("submit", async (event) => {
    event.preventDefault();

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

    try {
      const response = await fetch(consentForm.action, {
        body: new URLSearchParams(new FormData(consentForm)),
        headers: { accept: "application/json" },
        method: "POST",
      });
      const result = await response.json();

      if (
        !response.ok ||
        typeof result !== "object" ||
        result === null ||
        typeof result.redirectUrl !== "string" ||
        navigationLink?.tagName !== "A"
      ) {
        throw new Error("Authorization failed.");
      }

      navigationLink.href = result.redirectUrl;
      navigationLink.hidden = false;
      consentForms.forEach((form) => {
        form.hidden = true;
      });
      navigationLink.focus();
    } catch {
      window.location.assign("/oauth/error");
    }
  });
});
`.trim();

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
        "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

function actionsScriptResponse(): Response {
  return new Response(`${OAUTH_ACTIONS_SCRIPT}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

function stylesheetResponse(): Response {
  return new Response(`${OAUTH_STYLES}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/css; charset=utf-8",
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

  if (origin !== null) {
    return origin === new URL(request.url).origin;
  }

  return (
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate"
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

function loginPage(query: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in to Crewhelm</title>
    <link rel="stylesheet" href="/oauth/styles.css">
    <script src="/oauth/actions.js" defer></script>
  </head>
  <body>
    <main>
      <p class="eyebrow">Crewhelm</p>
      <h1>Sign in to Crewhelm</h1>
      <p>Continue with the GitHub account configured as this Crewhelm deployment's owner.</p>
      <input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
      <div class="actions">
        <a class="button primary" href="/oauth/login/continue?${escapeHtml(query)}" data-navigation-start data-pending-label="Opening GitHub…">Continue with GitHub</a>
      </div>
    </main>
  </body>
</html>
`;
}

function consentPage(
  query: string,
  client: { id: string; name: string },
  redirectOrigin: string,
  scope: z.infer<typeof oauthScopeClaimSchema>,
): string {
  const requestedScopes = scope.split(" ");
  const permissions = [
    requestedScopes.includes(OWNER_READ_SCOPE)
      ? "<li>View control-plane status and Agent summaries.</li>"
      : "",
    requestedScopes.includes(OWNER_WRITE_SCOPE)
      ? "<li>Create Agent definitions with bounded configuration and no capability grants.</li>"
      : "",
    requestedScopes.includes(AGENTS_READ_SCOPE)
      ? "<li>View full Agent definitions, including instructions.</li>"
      : "",
    requestedScopes.includes(AGENTS_WRITE_SCOPE)
      ? "<li>Start runs, decide approvals, and replace Agent definitions or exposed connection tools through immutable revisions.</li>"
      : "",
    requestedScopes.includes(AUTONOMY_WRITE_SCOPE)
      ? "<li>Grant exact tools standing authority and create recurring Agent schedules that continue after this session.</li>"
      : "",
    requestedScopes.includes(CONNECTIONS_READ_SCOPE)
      ? "<li>View bounded Crewhelm connection summaries. Provider account identifiers and credentials are not returned.</li>"
      : "",
    requestedScopes.includes(CONNECTIONS_WRITE_SCOPE)
      ? "<li>Create private, short-lived Composio Connect Links. The selected auth configuration and an opaque owner key are sent to Composio; provider credentials stay with Composio.</li>"
      : "",
    requestedScopes.includes(CONNECTION_CONFIGS_READ_SCOPE) &&
    requestedScopes.includes(INTEGRATIONS_READ_SCOPE)
      ? "<li>List enabled Composio auth configurations for a selected integration. The integration slug is sent to Composio; provider credentials are not returned.</li>"
      : "",
    requestedScopes.includes(CONNECTION_CONFIGS_WRITE_SCOPE)
      ? "<li>Enable Composio-managed authentication for a selected integration. The integration slug is sent to Composio; provider credentials are not returned.</li>"
      : "",
    requestedScopes.includes(INTEGRATIONS_READ_SCOPE)
      ? "<li>Search the Composio integration catalog and inspect exact tool schemas. Search terms and selected integration slugs are sent to Composio.</li>"
      : "",
    requestedScopes.includes(OFFLINE_ACCESS_SCOPE)
      ? "<li>Keep this MCP client signed in using a rotating, revocable refresh token.</li>"
      : "",
  ].join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize Crewhelm</title>
    <link rel="stylesheet" href="/oauth/styles.css">
    <script src="/oauth/actions.js" defer></script>
  </head>
  <body>
    <main>
      <p class="eyebrow">Crewhelm</p>
      <h1>Authorize Crewhelm</h1>
      <p><strong>${escapeHtml(client.name)}</strong> is requesting these permissions:</p>
      <ul>${permissions}</ul>
      <div class="meta">
        <p>Client: <code>${escapeHtml(client.id)}</code></p>
        <p>After authorization, Crewhelm will return you to <code>${escapeHtml(redirectOrigin)}</code>.</p>
      </div>
      <div class="actions">
        <form method="post" action="/oauth/consent" data-consent-form>
          <input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
          <input type="hidden" name="decision" value="approve">
          <button class="primary" type="submit" data-pending-label="Authorizing…">Authorize</button>
        </form>
        <form method="post" action="/oauth/consent" data-consent-form>
          <input type="hidden" name="oauth_query" value="${escapeHtml(query)}">
          <input type="hidden" name="decision" value="deny">
          <button class="secondary" type="submit" data-pending-label="Denying…">Deny</button>
        </form>
        <a class="button primary" data-navigation-link hidden>Continue to client</a>
      </div>
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

    return htmlResponse(
      consentPage(
        query,
        {
          id: client.data.client_id,
          name: client.data.client_name ?? "An MCP client",
        },
        new URL(parsedQuery.data.redirect_uri).origin,
        parsedQuery.data.scope,
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
  worker.get("/oauth/styles.css", stylesheetResponse);
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
