import {
  beginRemoteMcpOAuthResultSchema,
  completeRemoteMcpOAuthResultSchema,
  CONNECTIONS_WRITE_SCOPE,
  failRemoteMcpOAuthResultSchema,
} from "@crewhelm/contracts";
import type { Hono } from "hono";

import type { WorkerEnv } from "../env.js";
import {
  readRemoteMcpOAuthSetup,
  readRemoteMcpOAuthState,
  REMOTE_MCP_OAUTH_CALLBACK_PATH,
  REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH,
  REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX,
} from "../remote-mcp/handoff.js";
import { escapePageHtml, renderWorkerPage, workerPageResponse } from "./page.js";

const SETUP_ROUTE = `${REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX}:encodedClaims/:signature`;
const MAXIMUM_CALLBACK_URL_CHARACTERS = 16 * 1_024;
const ALLOWED_CALLBACK_PARAMETERS = new Set([
  "code",
  "error",
  "error_description",
  "error_uri",
  "iss",
  "state",
]);
const DENIED_PAGE = renderWorkerPage({
  body: '      <p class="ch-copy">This authorization was denied, expired, or could not reach the remote MCP server. Request a new setup link from your MCP client.</p>',
  heading: "Remote MCP authorization denied.",
  title: "Remote MCP authorization denied",
  tone: "negative",
});

function denied(status = 400): Response {
  return workerPageResponse(DENIED_PAGE, { status });
}

function handoffAuthority(ownerKey: string) {
  return {
    clientId: "crewhelm:remote-mcp-oauth-handoff",
    ownerKey,
    scopes: [CONNECTIONS_WRITE_SCOPE],
  };
}

function singleParameter(parameters: URLSearchParams, name: string): string | null {
  const values = parameters.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

function successPage(input: {
  connectionId: string;
  name: string;
  operation: "created" | "reauthenticated";
}): string {
  const verb = input.operation === "created" ? "connected" : "reauthenticated";
  return renderWorkerPage({
    body: `      <p class="ch-copy">Crewhelm ${verb} <strong>${escapePageHtml(input.name)}</strong>. You can close this window and use <code>${escapePageHtml(input.connectionId)}</code> from your MCP client.</p>`,
    context: "remote MCP OAuth handoff",
    heading: `Remote MCP ${verb}.`,
    title: `Remote MCP ${verb}`,
    tone: "positive",
  });
}

export function registerRemoteMcpOAuthRoutes(worker: Hono<{ Bindings: WorkerEnv }>): void {
  worker.on(["GET", "HEAD"], REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH, (context) => {
    const origin = new URL(context.env.PUBLIC_ORIGIN).origin;
    const body = `${JSON.stringify({
      client_name: "Crewhelm",
      client_uri: origin,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [`${origin}${REMOTE_MCP_OAUTH_CALLBACK_PATH}`],
      response_types: ["code"],
      software_id: "crewhelm",
      software_version: "1",
      token_endpoint_auth_method: "none",
    })}\n`;
    return new Response(context.req.method === "HEAD" ? null : body, {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  });

  worker.get(SETUP_ROUTE, async (context) => {
    const claims = await readRemoteMcpOAuthSetup({
      encodedClaims: context.req.param("encodedClaims"),
      signature: context.req.param("signature"),
      signingSecret: context.env.BETTER_AUTH_SECRET,
    });
    if (claims === null) return denied();

    try {
      const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(claims.ownerKey);
      if (controlPlane.beginRemoteMcpOAuth === undefined) return denied(503);
      const result = beginRemoteMcpOAuthResultSchema.safeParse(
        await controlPlane.beginRemoteMcpOAuth(handoffAuthority(claims.ownerKey), {
          requestId: claims.requestId,
        }),
      );
      if (!result.success || !result.data.ok) return denied(503);
      return new Response(null, {
        headers: {
          "cache-control": "no-store",
          location: result.data.authorizationUrl,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
        status: 302,
      });
    } catch {
      return denied(503);
    }
  });

  worker.get(REMOTE_MCP_OAUTH_CALLBACK_PATH, async (context) => {
    if (context.req.url.length > MAXIMUM_CALLBACK_URL_CHARACTERS) return denied();
    const parameters = new URL(context.req.url).searchParams;
    if ([...parameters.keys()].some((key) => !ALLOWED_CALLBACK_PARAMETERS.has(key))) {
      return denied();
    }
    const state = singleParameter(parameters, "state");
    if (state === null) return denied();
    const claims = await readRemoteMcpOAuthState({
      signingSecret: context.env.BETTER_AUTH_SECRET,
      state,
    });
    if (claims === null) return denied();

    const code = singleParameter(parameters, "code");
    const providerError = singleParameter(parameters, "error");
    const hasMalformedOptionalParameter = ["error_description", "error_uri", "iss"].some(
      (name) => parameters.getAll(name).length > 1,
    );
    const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(claims.ownerKey);
    const authority = handoffAuthority(claims.ownerKey);

    if (
      hasMalformedOptionalParameter ||
      (code === null) === (providerError === null) ||
      (providerError !== null && providerError.length > 256)
    ) {
      if (controlPlane.failRemoteMcpOAuth !== undefined) {
        await controlPlane.failRemoteMcpOAuth(authority, { requestId: claims.requestId });
      }
      return denied();
    }

    if (providerError !== null) {
      if (controlPlane.failRemoteMcpOAuth === undefined) return denied(503);
      const failed = failRemoteMcpOAuthResultSchema.safeParse(
        await controlPlane.failRemoteMcpOAuth(authority, { requestId: claims.requestId }),
      );
      return failed.success && failed.data.ok ? denied() : denied(503);
    }

    try {
      if (controlPlane.completeRemoteMcpOAuth === undefined || code === null) return denied(503);
      const issuer = singleParameter(parameters, "iss");
      const result = completeRemoteMcpOAuthResultSchema.safeParse(
        await controlPlane.completeRemoteMcpOAuth(authority, {
          authorizationCode: code,
          ...(issuer === null ? {} : { authorizationServerIssuer: issuer }),
          requestId: claims.requestId,
        }),
      );
      if (!result.success || !result.data.ok) return denied(503);
      return workerPageResponse(
        successPage({
          connectionId: result.data.connection.connectionId,
          name: result.data.connection.name,
          operation: result.data.operation,
        }),
      );
    } catch {
      return denied(503);
    }
  });

  worker.all(SETUP_ROUTE, () => {
    const response = denied(405);
    response.headers.set("allow", "GET");
    return response;
  });
  worker.all(REMOTE_MCP_OAUTH_CALLBACK_PATH, () => {
    const response = denied(405);
    response.headers.set("allow", "GET");
    return response;
  });
  worker.all(REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH, () => {
    const response = denied(405);
    response.headers.set("allow", "GET, HEAD");
    return response;
  });
}
