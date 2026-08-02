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

const RETURNED_BODY = renderWorkerPage({
  body: '      <p class="ch-copy">Crewhelm recorded the provider response. You can close this window and return to your MCP client.</p>',
  heading: "Connection authorization returned.",
  title: "Authorization returned",
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

    return workerPageResponse(result.data.outcome === "returned" ? RETURNED_BODY : FAILED_BODY);
  });

  worker.all(CONNECTION_AUTHORIZATION_RETURN_ROUTE, (context) =>
    methodNotAllowedResponse(context.req.method),
  );
}
