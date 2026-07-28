import { recordConnectionAuthorizationReturnResultSchema } from "@crewhelm/contracts";
import { type Hono } from "hono";
import * as z from "zod";

import {
  callbackParametersSchema,
  CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX,
  hasValidCallbackAuthenticator,
} from "../owner/connections/authorization-return.js";
import type { WorkerEnv } from "../env.js";

const CONNECTION_AUTHORIZATION_RETURN_ROUTE =
  `${CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX}:ownerKey/:reservationId/:expiresAt/` +
  ":authorizationToken/:authenticator";
const providerStatusSchema = z.enum(["success", "failed"]);

const RETURNED_BODY = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization returned</title>
<h1>Authorization returned to Crewhelm</h1>
<p>You can close this window and return to your MCP client.</p>
</html>
`;
const FAILED_BODY = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization not completed</title>
<h1>Authorization was not completed</h1>
<p>Return to your MCP client to try again.</p>
</html>
`;
const DENIED_BODY = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization return denied</title>
<h1>Authorization return denied</h1>
<p>Return to your MCP client and request a new connection link.</p>
</html>
`;

function htmlResponse(body: string | null, status: number): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });

  return new Response(body, { headers, status });
}

function deniedResponse(): Response {
  return htmlResponse(DENIED_BODY, 400);
}

function methodNotAllowedResponse(method: string): Response {
  const response = htmlResponse(method === "HEAD" ? null : DENIED_BODY, 405);

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

      return htmlResponse(result.outcome === "returned" ? RETURNED_BODY : FAILED_BODY, 200);
    } catch {
      return deniedResponse();
    }
  });

  worker.all(CONNECTION_AUTHORIZATION_RETURN_ROUTE, (context) =>
    methodNotAllowedResponse(context.req.method),
  );
}
