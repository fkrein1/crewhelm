import {
  listConnectionsResultSchema,
  recordConnectionAuthorizationReturnResultSchema,
} from "@crewhelm/contracts";
import { createComposioRuntime } from "@crewhelm/composio";
import { type Hono } from "hono";
import * as z from "zod";

import {
  callbackParametersSchema,
  CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX,
  hasValidCallbackAuthenticator,
} from "../owner/connections/index.js";
import type { WorkerEnv } from "../env.js";
import { renderWorkerPage, workerPageResponse } from "./page.js";

const CONNECTION_AUTHORIZATION_RETURN_ROUTE =
  `${CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX}:ownerKey/:reservationId/:expiresAt/` +
  ":authorizationToken/:authenticator";
const providerStatusSchema = z.enum(["success", "failed"]);
const SCRIPT_PATH = "/connections/composio/callback/app.js";

const VERIFYING_BODY = renderWorkerPage({
  body: `      <p class="ch-copy" id="status">Authorization received. Crewhelm is verifying that the connection is ready to use.</p>
      <div class="ch-actions"><button class="ch-button ch-button--primary" id="retry" hidden type="button">Check again</button></div>`,
  heading: "Verifying connection…",
  scriptPath: SCRIPT_PATH,
  title: "Verifying connection",
  tone: "positive",
});
const FAILED_BODY = renderWorkerPage({
  body: '      <p class="ch-copy">The provider did not complete authorization. Return to your MCP client when you are ready to try again.</p>',
  heading: "Connection authorization stopped.",
  title: "Authorization not completed",
  tone: "warning",
});
const DENIED_BODY = renderWorkerPage({
  body: '      <p class="ch-copy">This return could not activate a connection. Request a new connection link from your MCP client.</p>',
  heading: "Connection return denied.",
  title: "Authorization return denied",
  tone: "negative",
});

function deniedResponse(): Response {
  return workerPageResponse(DENIED_BODY, { status: 400 });
}

function json(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

const SCRIPT = String.raw`(() => {
  "use strict";
  const heading = document.querySelector("h1");
  const status = document.getElementById("status");
  const retry = document.getElementById("retry");
  const check = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("check", "1");
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    return response.ok ? response.json() : { state: "action_required" };
  };
  const verify = async (maximumAttempts) => {
    retry.hidden = true;
    heading.textContent = "Verifying connection…";
    status.textContent = "Authorization received. Crewhelm is checking that the connection is ready to use.";
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 2000));
      const result = await check().catch(() => ({ state: "pending" }));
      if (result.state === "connected") {
        heading.textContent = "Connection ready.";
        status.textContent = "The provider connection is active. You can close this window and return to your MCP client.";
        return;
      }
      if (result.state === "action_required") {
        heading.textContent = "Connection needs attention.";
        status.textContent = "The provider could not confirm this connection. Return to your MCP client to reconnect.";
        return;
      }
    }
    heading.textContent = "Still verifying.";
    status.textContent = "Authorization was received, but provider verification is taking longer than expected.";
    retry.hidden = false;
  };
  retry.addEventListener("click", () => void verify(1));
  void verify(6);
})();`;

function methodNotAllowedResponse(method: string): Response {
  const response = workerPageResponse(method === "HEAD" ? null : DENIED_BODY, { status: 405 });

  response.headers.set("allow", "GET");
  return response;
}

function readProviderReturn(url: URL): {
  check: boolean;
  providerConnectionId?: string;
  status: "failed" | "success";
} | null {
  const keys = [...url.searchParams.keys()];

  if (
    keys.some((key) => key !== "check" && key !== "connected_account_id" && key !== "status") ||
    url.searchParams.getAll("status").length !== 1 ||
    url.searchParams.getAll("connected_account_id").length > 1 ||
    url.searchParams.getAll("check").length > 1 ||
    (url.searchParams.has("check") && url.searchParams.get("check") !== "1")
  ) {
    return null;
  }

  const status = providerStatusSchema.safeParse(url.searchParams.get("status"));

  if (!status.success) {
    return null;
  }

  const providerConnectionIds = url.searchParams.getAll("connected_account_id");

  if (status.data === "success" && providerConnectionIds.length !== 1) {
    return null;
  }

  const providerConnectionId = providerConnectionIds[0];

  return providerConnectionId === undefined
    ? { check: url.searchParams.has("check"), status: status.data }
    : { check: url.searchParams.has("check"), providerConnectionId, status: status.data };
}

export function registerConnectionAuthorizationReturnRoutes(
  worker: Hono<{ Bindings: WorkerEnv }>,
): void {
  worker.get(
    SCRIPT_PATH,
    () =>
      new Response(SCRIPT, {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "text/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      }),
  );
  worker.get(CONNECTION_AUTHORIZATION_RETURN_ROUTE, async (context) => {
    if (context.req.method !== "GET") {
      return methodNotAllowedResponse(context.req.method);
    }

    const parameters = callbackParametersSchema.safeParse(context.req.param());
    const providerReturn = readProviderReturn(new URL(context.req.url));

    if (
      !parameters.success ||
      providerReturn === null ||
      Number(parameters.data.expiresAt) <= Date.now()
    ) {
      return deniedResponse();
    }

    if (!(await hasValidCallbackAuthenticator(context.env.BETTER_AUTH_SECRET, parameters.data))) {
      return deniedResponse();
    }

    let returned: unknown;

    try {
      const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(parameters.data.ownerKey);
      returned = await controlPlane.recordConnectionAuthorizationReturn({
        authorizationToken: parameters.data.authorizationToken,
        providerConnectionId: providerReturn.providerConnectionId,
        reservationId: parameters.data.reservationId,
        status: providerReturn.status,
      });
    } catch {
      return deniedResponse();
    }

    const result = recordConnectionAuthorizationReturnResultSchema.safeParse(returned);

    if (!result.success || !result.data.ok) {
      return deniedResponse();
    }

    if (providerReturn.check && result.data.outcome === "returned") {
      const runtime = createComposioRuntime({ apiKey: context.env.COMPOSIO_API_KEY });
      const verified = await runtime.verifyConnection(result.data.connection.providerConnectionId);
      if (!verified.ok) {
        const actionRequired = [
          "configuration_unavailable",
          "invalid_request",
          "invalid_response",
        ].includes(verified.reason);
        return json({
          state: actionRequired ? "action_required" : "pending",
        });
      }
      if (verified.toolkitSlug !== result.data.connection.integrationSlug) {
        return json({ state: "action_required" }, 400);
      }
      const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(parameters.data.ownerKey);
      const activated = listConnectionsResultSchema.safeParse(
        await controlPlane.activateVerifiedConnectionAuthorizationReturn({
          accountLabel: verified.accountLabel,
          authorizationToken: parameters.data.authorizationToken,
          connectionId: result.data.connection.connectionId,
          providerConnectionId: result.data.connection.providerConnectionId,
          reservationId: parameters.data.reservationId,
          verifiedIntegrationSlug: verified.toolkitSlug,
        }),
      );
      const connection =
        activated.success && activated.data.ok ? activated.data.connections[0] : undefined;
      return json({
        state:
          connection?.connectionId === result.data.connection.connectionId &&
          connection.status === "active"
            ? "connected"
            : "pending",
      });
    }

    return result.data.outcome === "returned"
      ? workerPageResponse(VERIFYING_BODY, { connections: true, scripts: true })
      : workerPageResponse(FAILED_BODY);
  });

  worker.all(CONNECTION_AUTHORIZATION_RETURN_ROUTE, (context) =>
    methodNotAllowedResponse(context.req.method),
  );
}
