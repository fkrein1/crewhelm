import { recordConnectionAuthorizationReturnResultSchema } from "@crewhelm/contracts";
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

export type ConnectionAuthorizationReturnPage = "denied" | "returned" | "stopped";

export function renderConnectionAuthorizationReturnPage(
  outcome: ConnectionAuthorizationReturnPage,
): string {
  if (outcome === "returned") {
    return renderWorkerPage({
      body: '      <p class="ch-copy">Crewhelm recorded the provider response. You can close this window and return to your MCP client.</p>',
      heading: "Connection authorization returned.",
      title: "Authorization returned",
      tone: "positive",
    });
  }

  if (outcome === "stopped") {
    return renderWorkerPage({
      body: '      <p class="ch-copy">The provider did not complete authorization. Return to your MCP client when you are ready to try again.</p>',
      heading: "Connection authorization stopped.",
      title: "Authorization not completed",
      tone: "warning",
    });
  }

  return renderWorkerPage({
    body: '      <p class="ch-copy">This return could not activate a connection. Request a new connection link from your MCP client.</p>',
    heading: "Connection return denied.",
    title: "Authorization return denied",
    tone: "negative",
  });
}

const RETURNED_BODY = renderConnectionAuthorizationReturnPage("returned");
const FAILED_BODY = renderConnectionAuthorizationReturnPage("stopped");
const DENIED_BODY = renderConnectionAuthorizationReturnPage("denied");

function deniedResponse(): Response {
  return workerPageResponse(DENIED_BODY, { status: 400 });
}

function methodNotAllowedResponse(method: string): Response {
  const response = workerPageResponse(method === "HEAD" ? null : DENIED_BODY, { status: 405 });

  response.headers.set("allow", "GET");
  return response;
}

function readProviderReturn(url: URL): {
  providerConnectionId?: string;
  status: "failed" | "success";
} | null {
  const keys = [...url.searchParams.keys()];

  if (
    keys.some((key) => key !== "connected_account_id" && key !== "status") ||
    url.searchParams.getAll("status").length !== 1 ||
    url.searchParams.getAll("connected_account_id").length > 1
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
    ? { status: status.data }
    : { providerConnectionId, status: status.data };
}

export function registerConnectionAuthorizationReturnRoutes(
  worker: Hono<{ Bindings: WorkerEnv }>,
): void {
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

    try {
      if (!(await hasValidCallbackAuthenticator(context.env.BETTER_AUTH_SECRET, parameters.data))) {
        return deniedResponse();
      }

      const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(parameters.data.ownerKey);
      const result = recordConnectionAuthorizationReturnResultSchema.parse(
        await controlPlane.recordConnectionAuthorizationReturn({
          authorizationToken: parameters.data.authorizationToken,
          providerConnectionId: providerReturn.providerConnectionId,
          reservationId: parameters.data.reservationId,
          status: providerReturn.status,
        }),
      );

      if (!result.ok) {
        return deniedResponse();
      }

      return workerPageResponse(result.outcome === "returned" ? RETURNED_BODY : FAILED_BODY);
    } catch {
      return deniedResponse();
    }
  });

  worker.all(CONNECTION_AUTHORIZATION_RETURN_ROUTE, (context) =>
    methodNotAllowedResponse(context.req.method),
  );
}
