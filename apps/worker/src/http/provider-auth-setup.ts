import {
  CONNECTIONS_WRITE_SCOPE,
  completeConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  providerAuthSetupAuthorityResultSchema,
  providerAuthSetupMutationResultSchema,
  providerAuthSetupPlanResultSchema,
  reserveConnectionLinkResultSchema,
} from "@crewhelm/contracts";
import { createComposioAuthConfigs, createComposioConnectionLinks } from "@crewhelm/composio";
import type { Hono } from "hono";

import type { WorkerEnv } from "../env.js";
import { createConnectionAuthorizationCallback } from "../owner/connections/index.js";
import {
  PROVIDER_AUTH_SETUP_COOKIE,
  PROVIDER_AUTH_SETUP_PATH,
  createProviderAuthSetupSession,
  readProviderAuthSetupCapability,
  readProviderAuthSetupSession,
} from "../provider-auth-setup/capability.js";
import { renderWorkerPage, workerPageResponse } from "./page.js";
import { readBoundedPostRequest } from "./request-body.js";

const EXCHANGE_PATH = `${PROVIDER_AUTH_SETUP_PATH}/exchange`;
const PLAN_PATH = `${PROVIDER_AUTH_SETUP_PATH}/plan`;
const CONFIGURE_PATH = `${PROVIDER_AUTH_SETUP_PATH}/configure`;
const CONNECT_PATH = `${PROVIDER_AUTH_SETUP_PATH}/connect`;
const RECONCILE_PATH = `${PROVIDER_AUTH_SETUP_PATH}/reconcile`;
const SCRIPT_PATH = `${PROVIDER_AUTH_SETUP_PATH}/app.js`;
const MAXIMUM_JSON_BYTES = 140 * 1_024;
const DENIED = { error: "provider_auth_setup_denied", ok: false } as const;
const PAGE = renderWorkerPage({
  body: `      <p class="ch-copy" id="status">Preparing secure provider authentication…</p>
      <div id="setup"></div>`,
  context: "provider credential handoff",
  heading: "Connect a provider.",
  scriptPath: SCRIPT_PATH,
  title: "Configure provider authentication",
  tone: "warning",
});

const SCRIPT = String.raw`(() => {
  "use strict";
  const status = document.getElementById("status");
  const setup = document.getElementById("setup");
  const heading = document.querySelector("h1");
  document.querySelector(".ch-panel").classList.add("ch-panel--form");
  const text = (value) => document.createTextNode(value);
  const section = (title) => {
    const element = document.createElement("section");
    element.className = "ch-form-section";
    const sectionHeading = document.createElement("h2");
    sectionHeading.append(text(title));
    element.append(sectionHeading);
    return element;
  };
  const renderSteps = (current, authorizeConnection) => {
    if (!authorizeConnection) return document.createDocumentFragment();
    const steps = document.createElement("div");
    steps.className = "ch-steps";
    for (const [number, label] of [[1, "Configure access"], [2, "Authorize account"]]) {
      const step = document.createElement("div");
      step.className = "ch-step";
      if (number === current) step.setAttribute("aria-current", "step");
      step.append(text("Step " + number + " · " + label));
      steps.append(step);
    }
    return steps;
  };
  const fail = (message) => {
    status.textContent = message;
    setup.replaceChildren();
  };
  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...options,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result === null) throw result || new Error("request_failed");
    return result;
  };
  const openProviderAuthorization = async (credentials = {}) => {
    status.textContent = "Opening provider authorization…";
    const connected = await request("${CONNECT_PATH}", {
      body: JSON.stringify({ credentials }),
      method: "POST",
    });
    window.location.assign(connected.url);
  };
  const render = (result) => {
    if (!result.ok) throw result;
    if (result.status === "configured") return renderCompleted(result.plan);
    if (result.status === "rejected") return fail("These credentials were rejected. Request a new setup link and try again.");
    if (result.status === "outcome_unknown") return renderUnknown(result);
    heading.textContent = "Connect " + result.plan.integrationName + ".";
    if (result.plan.support === "unsupported") {
      status.textContent = result.plan.integrationName + " uses " + result.plan.authScheme +
        " authentication, which Crewhelm cannot configure safely yet.";
      const notice = document.createElement("aside");
      notice.className = "ch-trust";
      const title = document.createElement("strong");
      title.append(text("This format is not supported yet"));
      const copy = document.createElement("p");
      copy.append(text("Crewhelm did not request, transmit, or store any credentials. Choose another authentication method when the provider offers one, or request support for this format."));
      notice.append(title, copy);
      setup.replaceChildren(notice);
      return;
    }
    status.textContent = result.plan.authorizeConnection
      ? result.plan.fields.length === 0
        ? "Continue to the provider's secure authorization page."
        : "First, configure the developer app Crewhelm will use. Then you will authorize your account."
      : "Enter the configuration required by " + result.plan.integrationName + ".";
    if (result.plan.fields.length === 0) {
      setup.replaceChildren();
      status.textContent = "Opening the provider's secure authorization page…";
      request("${CONFIGURE_PATH}", {
        body: JSON.stringify({ credentials: {} }),
        method: "POST",
      })
        .then((configured) => configured.plan.authorizeConnection
          ? openProviderAuthorization()
          : renderCompleted(configured.plan))
        .catch(() => fail("Provider authorization could not be started. Request a new setup link and try again."));
      return;
    }
    const form = document.createElement("form");
    form.className = "ch-form";
    if (result.plan.documentationUrl) {
      const help = document.createElement("p");
      help.className = "ch-copy";
      const link = document.createElement("a");
      link.href = result.plan.documentationUrl;
      link.rel = "noreferrer noopener";
      link.target = "_blank";
      link.append(text("Open provider credential instructions"));
      help.append(link);
      form.append(help);
    }
    if (result.plan.callbackUrl) {
      const callback = section("1. Register the callback URL");
      const explanation = document.createElement("p");
      explanation.className = "ch-field-hint";
      explanation.append(text("Add this exact URL as an authorized redirect URI in the provider's developer app."));
      const wrap = document.createElement("div");
      wrap.className = "ch-input-wrap ch-input-wrap--action";
      const callbackInput = document.createElement("input");
      callbackInput.className = "ch-input ch-input--code";
      callbackInput.readOnly = true;
      callbackInput.value = result.plan.callbackUrl;
      callbackInput.setAttribute("aria-label", "OAuth callback URL");
      const copy = document.createElement("button");
      copy.className = "ch-input-action";
      copy.type = "button";
      copy.append(text("Copy"));
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(callbackInput.value);
          copy.textContent = "Copied";
        } catch {
          callbackInput.focus();
          callbackInput.select();
        }
      });
      wrap.append(callbackInput, copy);
      callback.append(explanation, wrap);
      form.append(callback);
    }
    const credentialSection = section(result.plan.callbackUrl ? "2. Enter app credentials" : "Credentials");
    const credentialFields = document.createElement("div");
    credentialFields.className = "ch-field-list";
    for (const field of result.plan.fields) {
      const container = document.createElement("div");
      container.className = "ch-field";
      const label = document.createElement("label");
      label.htmlFor = "field-" + field.key;
      label.append(text(field.label));
      if (field.required) {
        const required = document.createElement("span");
        required.className = "ch-required";
        required.append(text("Required"));
        label.append(required);
      }
      const input = document.createElement(field.multiline ? "textarea" : "input");
      input.autocomplete = "off";
      input.className = "ch-input";
      input.id = label.htmlFor;
      input.maxLength = field.maximumLength;
      input.name = field.key;
      input.required = field.required;
      if (!field.multiline) input.type = field.secret ? "password" : "text";
      if (field.multiline) input.rows = 7;
      if (field.multiline && field.secret) input.classList.add("ch-input--masked");
      if (field.defaultValue !== undefined) input.value = field.defaultValue;
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      const wrap = document.createElement("div");
      wrap.className = "ch-input-wrap";
      wrap.append(input);
      if (field.secret) {
        wrap.classList.add("ch-input-wrap--action");
        const reveal = document.createElement("button");
        reveal.className = "ch-input-action";
        reveal.type = "button";
        reveal.setAttribute("aria-controls", input.id);
        reveal.setAttribute("aria-pressed", "false");
        reveal.append(text("Show"));
        reveal.addEventListener("click", () => {
          const visible = field.multiline
            ? !input.classList.contains("ch-input--masked")
            : input.type === "text";
          if (field.multiline) {
            input.classList.toggle("ch-input--masked", visible);
          } else {
            input.type = visible ? "password" : "text";
          }
          reveal.textContent = visible ? "Show" : "Hide";
          reveal.setAttribute("aria-pressed", String(!visible));
        });
        wrap.append(reveal);
      }
      container.append(label, wrap);
      credentialFields.append(container);
    }
    if (credentialFields.childElementCount > 0) {
      credentialSection.append(credentialFields);
      form.append(credentialSection);
    }
    const trust = document.createElement("aside");
    trust.className = "ch-trust";
    const trustTitle = document.createElement("strong");
    trustTitle.append(text("Security"));
    const trustCopy = document.createElement("p");
    trustCopy.append(text(result.plan.fields.length === 0
      ? "You will enter account credentials on Composio's secure authorization page. They never pass through Crewhelm."
      : "Sent securely to Composio for setup. Crewhelm clears the form and does not store these credentials."));
    trust.append(trustTitle, trustCopy);
    form.append(trust);
    const actions = document.createElement("div");
    actions.className = "ch-actions";
    const submit = document.createElement("button");
    submit.className = "ch-button ch-button--primary";
    submit.type = "submit";
    submit.append(text(result.plan.authorizeConnection
      ? "Connect " + result.plan.integrationName
      : "Save configuration"));
    actions.append(submit);
    form.append(actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "Sending credentials securely to the provider…";
      const authConfigCredentials = {};
      const connectionCredentials = {};
      for (const field of result.plan.fields) {
        const value = form.elements.namedItem(field.key).value;
        if (field.required || value !== "") {
          (field.stage === "auth_config" ? authConfigCredentials : connectionCredentials)[field.key] = value;
        }
      }
      try {
        const configured = await request("${CONFIGURE_PATH}", {
          body: JSON.stringify({ credentials: authConfigCredentials }),
          method: "POST",
        });
        if (configured.plan.authorizeConnection) {
          if (configured.url) {
            window.location.assign(configured.url);
          } else {
            await openProviderAuthorization(connectionCredentials);
          }
        } else {
          renderCompleted(configured.plan);
        }
      } catch (error) {
        if (error && error.error === "credentials_rejected") {
          status.textContent = "The provider rejected these credentials. Check them and try again with a new setup link.";
        } else {
          const pending = await request("${PLAN_PATH}", { headers: {} }).catch(() => null);
          if (pending !== null) return render(pending);
          status.textContent = "The provider outcome is unknown. Reload this page to check it without resubmitting credentials.";
        }
        setup.replaceChildren();
      } finally {
        for (const key of Object.keys(authConfigCredentials)) authConfigCredentials[key] = "";
        for (const key of Object.keys(connectionCredentials)) connectionCredentials[key] = "";
        form.reset();
      }
    });
    setup.replaceChildren(form);
  };
  const renderCompleted = (plan) => {
    heading.textContent = "Connect your " + plan.integrationName + " account.";
    status.textContent = plan.integrationName + " authentication is configured.";
    if (!plan.authorizeConnection) {
      setup.replaceChildren(text("You can close this window and continue from your MCP client."));
      return;
    }
    if (plan.fields.some((field) => field.stage === "connection" && field.required)) {
      setup.replaceChildren(text("Request a new setup link to enter the connection credentials again. Crewhelm did not retain them."));
      return;
    }
    const actions = document.createElement("div");
    actions.className = "ch-actions";
    const button = document.createElement("button");
    button.className = "ch-button ch-button--primary";
    button.append(text("Authorize provider account"));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await openProviderAuthorization();
      } catch {
        fail("Provider authorization could not be started. Request a new setup link and try again.");
      }
    });
    actions.append(button);
    setup.replaceChildren(renderSteps(2, true), actions);
  };
  const renderUnknown = (result) => {
    status.textContent = "The provider may have created the authentication configuration. Do not submit credentials again.";
    const actions = document.createElement("div");
    actions.className = "ch-actions";
    const button = document.createElement("button");
    button.className = "ch-button ch-button--primary";
    button.type = "button";
    button.append(text("Check provider outcome"));
    const enableAt = Number(result.recoverAfter || 0);
    const enable = () => { button.disabled = Date.now() < enableAt; };
    enable();
    if (button.disabled) window.setTimeout(enable, Math.max(1, enableAt - Date.now()));
    button.addEventListener("click", async () => {
      button.disabled = true;
      status.textContent = "Checking the exact provider outcome…";
      try {
        render(await request("${RECONCILE_PATH}", { body: "{}", method: "POST" }));
      } catch {
        fail("The provider outcome is still unknown. Reload this page later to check again.");
      }
    });
    actions.append(button);
    setup.replaceChildren(actions);
  };
  (async () => {
    try {
      const parameters = new URLSearchParams(window.location.hash.slice(1));
      const capability = parameters.get("capability");
      history.replaceState(null, "", window.location.pathname);
      const result = capability === null
        ? await request("${PLAN_PATH}", { headers: {} })
        : await request("${EXCHANGE_PATH}", {
            body: JSON.stringify({ capability }),
            method: "POST",
          });
      render(result);
    } catch {
      fail("This setup link is invalid, expired, or already used. Request a new link from your MCP client.");
    }
  })();
})();
`;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(`${JSON.stringify(value)}\n`, {
    headers: responseHeaders,
    status,
  });
}

function mutationAllowed(request: Request, env: WorkerEnv): boolean {
  return (
    request.headers.get("origin") === env.PUBLIC_ORIGIN &&
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
      "application/json"
  );
}

async function jsonBody(request: Request): Promise<unknown> {
  const bounded = await readBoundedPostRequest(request, MAXIMUM_JSON_BYTES);
  if (bounded === null) return null;
  try {
    return await bounded.json();
  } catch {
    return null;
  }
}

function cookieToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null || header.length > 8_192) return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PROVIDER_AUTH_SETUP_COOKIE}=`))
    .map((part) => part.slice(PROVIDER_AUTH_SETUP_COOKIE.length + 1));
  return values.length === 1 ? (values[0] ?? null) : null;
}

function sessionCookie(token: string, sessionExpiresAt: number): string {
  const maxAge = Math.max(1, Math.floor((sessionExpiresAt - Date.now()) / 1_000));
  return `${PROVIDER_AUTH_SETUP_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=${PROVIDER_AUTH_SETUP_PATH}; Max-Age=${maxAge}`;
}

async function sessionForRequest(request: Request, env: WorkerEnv) {
  return readProviderAuthSetupSession({
    signingSecret: env.BETTER_AUTH_SECRET,
    token: cookieToken(request),
  });
}

function validCredentials(
  value: unknown,
  fields: Array<{ key: string; maximumLength: number; required: boolean }>,
): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const allowed = new Map(fields.map((field) => [field.key, field]));
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field.key);
    const credential: unknown =
      descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    return credential === undefined
      ? !field.required
      : typeof credential === "string" &&
          credential.length <= field.maximumLength &&
          (!field.required || credential.length > 0);
  });
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function registerProviderAuthSetupRoutes(worker: Hono<{ Bindings: WorkerEnv }>): void {
  worker.get(PROVIDER_AUTH_SETUP_PATH, () =>
    workerPageResponse(PAGE, { connections: true, scripts: true }),
  );
  worker.get(
    SCRIPT_PATH,
    () =>
      new Response(`${SCRIPT}\n`, {
        headers: {
          "cache-control": "no-store",
          "content-type": "application/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      }),
  );

  worker.post(EXCHANGE_PATH, async (context) => {
    if (!mutationAllowed(context.req.raw, context.env)) return json(DENIED, 400);
    const body = await jsonBody(context.req.raw);
    if (!hasExactKeys(body, ["capability"])) return json(DENIED, 400);
    const capability = await readProviderAuthSetupCapability({
      capability: ownValue(body, "capability"),
      signingSecret: context.env.BETTER_AUTH_SECRET,
    });
    if (capability === null) return json(DENIED, 400);
    const session = await createProviderAuthSetupSession({
      ...capability.claims,
      signingSecret: context.env.BETTER_AUTH_SECRET,
    });
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(capability.claims.ownerKey);
    const result = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.exchangeProviderAuthSetup({
        capabilityDigest: capability.capabilityDigest,
        sessionDigest: session.sessionDigest,
        setupId: capability.claims.setupId,
      }),
    );
    if (!result.success || !result.data.ok) return json(DENIED, 400);
    return json(result.data, 200, {
      "set-cookie": sessionCookie(session.token, result.data.sessionExpiresAt),
    });
  });

  worker.get(PLAN_PATH, async (context) => {
    const session = await sessionForRequest(context.req.raw, context.env);
    if (session === null) return json(DENIED, 401);
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(session.claims.ownerKey);
    const result = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    return result.success && result.data.ok ? json(result.data) : json(DENIED, 401);
  });

  worker.post(CONFIGURE_PATH, async (context) => {
    if (!mutationAllowed(context.req.raw, context.env)) return json(DENIED, 400);
    const session = await sessionForRequest(context.req.raw, context.env);
    if (session === null) return json(DENIED, 401);
    const body = await jsonBody(context.req.raw);
    if (!hasExactKeys(body, ["credentials"])) return json(DENIED, 400);
    const credentials = ownValue(body, "credentials");
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(session.claims.ownerKey);
    const current = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (
      !current.success ||
      !current.data.ok ||
      current.data.status !== "exchanged" ||
      current.data.plan.support !== "supported" ||
      !validCredentials(
        credentials,
        current.data.plan.fields.filter((field) => field.stage === "auth_config"),
      )
    ) {
      return json(DENIED, 400);
    }
    const reservation = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.reserveProviderAuthSetupConfiguration({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (!reservation.success || !reservation.data.ok) return json(DENIED, 400);

    const provider = createComposioAuthConfigs({ apiKey: context.env.COMPOSIO_API_KEY });
    const created = await provider.createCustom({
      authScheme: reservation.data.plan.authScheme,
      credentials: {
        ...credentials,
        ...(reservation.data.plan.callbackUrl === undefined
          ? {}
          : { oauth_redirect_uri: reservation.data.plan.callbackUrl }),
      },
      integrationSlug: reservation.data.plan.integrationSlug,
      name: `Crewhelm ${session.claims.setupId.slice("provider_auth_setup_".length)}`,
    });
    if (!created.ok) {
      await controlPlane.rejectProviderAuthSetup({
        outcome: created.error,
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      });
      return json(
        { error: created.error, ok: false },
        created.error === "credentials_rejected" ? 400 : 503,
      );
    }

    const completed = providerAuthSetupMutationResultSchema.safeParse(
      await controlPlane.completeProviderAuthSetup({
        authConfig: created.authConfig,
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    return completed.success && completed.data.ok
      ? json({ ok: true, plan: reservation.data.plan, status: "configured" })
      : json(DENIED, 503);
  });

  worker.post(CONNECT_PATH, async (context) => {
    const body = mutationAllowed(context.req.raw, context.env)
      ? await jsonBody(context.req.raw)
      : null;
    if (body === null || !hasExactKeys(body, ["credentials"])) {
      return json(DENIED, 400);
    }
    const credentials = ownValue(body, "credentials");
    const session = await sessionForRequest(context.req.raw, context.env);
    if (session === null) return json(DENIED, 401);
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(session.claims.ownerKey);
    const current = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (
      !current.success ||
      !current.data.ok ||
      current.data.status !== "configured" ||
      current.data.plan.support !== "supported" ||
      !validCredentials(
        credentials,
        current.data.plan.fields.filter((field) => field.stage === "connection"),
      )
    ) {
      return json(DENIED, 400);
    }
    const setupAuthority = providerAuthSetupAuthorityResultSchema.safeParse(
      await controlPlane.providerAuthSetupAuthority({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (!setupAuthority.success || !setupAuthority.data.ok) return json(DENIED, 401);
    const authority = {
      clientId: setupAuthority.data.clientId,
      ownerKey: setupAuthority.data.ownerKey,
      scopes: [CONNECTIONS_WRITE_SCOPE],
    };
    const reservation = reserveConnectionLinkResultSchema.safeParse(
      await controlPlane.reserveConnectionLink(authority, {
        authConfigId: setupAuthority.data.authConfigId,
        idempotencyKey: `provider-auth-${session.claims.setupId}`,
      }),
    );
    if (!reservation.success || !reservation.data.ok) return json(DENIED, 503);
    if (reservation.data.state === "replay") {
      return json({ ok: true, url: reservation.data.connectionLink.url });
    }
    const callback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: reservation.data.authorizationExpiresAt,
      authorizationToken: reservation.data.authorizationToken,
      ownerKey: authority.ownerKey,
      origin: context.env.PUBLIC_ORIGIN,
      reservationId: reservation.data.reservationId,
      signingSecret: context.env.BETTER_AUTH_SECRET,
    });
    const link = await createComposioConnectionLinks({
      apiKey: context.env.COMPOSIO_API_KEY,
    }).create({
      authConfigId: setupAuthority.data.authConfigId,
      callbackSecrets: callback.callbackSecrets,
      callbackUrl: callback.callbackUrl,
      ...(Object.keys(credentials).length === 0 ? {} : { connectionData: credentials }),
      userId: authority.ownerKey,
    });
    if (!link.ok) return json(DENIED, 503);
    const completion = completeConnectionLinkInputSchema.safeParse({
      ...link.connectionLink,
      authorizationToken: reservation.data.authorizationToken,
      reservationId: reservation.data.reservationId,
    });
    if (!completion.success) return json(DENIED, 503);
    const completed = createConnectionLinkResultSchema.safeParse(
      await controlPlane.completeConnectionLink(authority, completion.data),
    );
    return completed.success && completed.data.ok
      ? json({ ok: true, url: completed.data.connectionLink.url })
      : json(DENIED, 503);
  });

  worker.post(RECONCILE_PATH, async (context) => {
    const body = mutationAllowed(context.req.raw, context.env)
      ? await jsonBody(context.req.raw)
      : null;
    if (body === null || !hasExactKeys(body, [])) return json(DENIED, 400);
    const session = await sessionForRequest(context.req.raw, context.env);
    if (session === null) return json(DENIED, 401);
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(session.claims.ownerKey);
    const current = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (
      !current.success ||
      !current.data.ok ||
      current.data.status !== "outcome_unknown" ||
      current.data.recoverAfter === undefined ||
      current.data.recoverAfter > Date.now()
    ) {
      return json(DENIED, 400);
    }

    const reconciled = await createComposioAuthConfigs({
      apiKey: context.env.COMPOSIO_API_KEY,
    }).reconcileCustom({
      authScheme: current.data.plan.authScheme,
      integrationSlug: current.data.plan.integrationSlug,
      name: `Crewhelm ${session.claims.setupId.slice("provider_auth_setup_".length)}`,
    });
    if (reconciled.state === "configured") {
      await controlPlane.completeProviderAuthSetup({
        authConfig: reconciled.authConfig,
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      });
    } else {
      await controlPlane.reconcileProviderAuthSetup({
        outcome: reconciled.state,
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      });
    }
    const result = providerAuthSetupPlanResultSchema.safeParse(
      await controlPlane.readProviderAuthSetup({
        sessionDigest: session.sessionDigest,
        setupId: session.claims.setupId,
      }),
    );
    if (!result.success || !result.data.ok) return json(DENIED, 503);
    const token = cookieToken(context.req.raw);
    return json(
      result.data,
      200,
      token === null
        ? undefined
        : { "set-cookie": sessionCookie(token, result.data.sessionExpiresAt) },
    );
  });
}
