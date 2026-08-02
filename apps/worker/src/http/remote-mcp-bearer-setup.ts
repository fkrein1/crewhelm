import {
  CONNECTIONS_WRITE_SCOPE,
  createRemoteMcpConnectionResultSchema,
  createRemoteMcpConnectionInputSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
} from "@crewhelm/contracts";
import { type Hono } from "hono";

import type { WorkerEnv } from "../env.js";
import { discoverRemoteMcpTools } from "../remote-mcp/client.js";
import {
  readRemoteMcpBearerSetup,
  REMOTE_MCP_BEARER_SETUP_PATH_PREFIX,
  type RemoteMcpBearerSetupClaims,
} from "../remote-mcp/handoff.js";
import { readBoundedPostRequest } from "./request-body.js";
import { escapePageHtml, renderWorkerPage, workerPageResponse } from "./page.js";

const ROUTE = `${REMOTE_MCP_BEARER_SETUP_PATH_PREFIX}:encodedClaims/:signature`;
const MAXIMUM_FORM_BYTES = 9 * 1_024;
const DISCOVERY_TIMEOUT_MS = 15_000;
const DENIED_PAGE = renderWorkerPage({
  body: '      <p class="ch-copy">This setup link is invalid, expired, or could not reach the remote MCP server. Request a new link from your MCP client.</p>',
  heading: "Remote MCP setup denied.",
  title: "Remote MCP setup denied",
  tone: "negative",
});

function denied(status = 400): Response {
  return workerPageResponse(DENIED_PAGE, { status });
}

function setupPage(claims: RemoteMcpBearerSetupClaims): string {
  return renderWorkerPage({
    body: `      <p class="ch-copy">Connect <strong>${escapePageHtml(claims.name)}</strong> at <code>${escapePageHtml(claims.endpoint)}</code>.</p>
      <p class="ch-copy">The bearer token is sent only to Crewhelm's owner-side adapter, encrypted at rest, and never placed in Agent or MCP context.</p>
      <form method="post">
        <label for="bearer-token">Bearer token</label>
        <input id="bearer-token" name="bearerToken" type="password" required autocomplete="off" maxlength="8192">
        <div class="ch-actions">
          <button class="ch-button ch-button--primary" type="submit">Connect MCP server</button>
        </div>
      </form>`,
    context: "remote MCP credential handoff",
    heading: "Enter bearer credential.",
    title: "Connect remote MCP",
    tone: "warning",
  });
}

async function claimsForRequest(
  env: WorkerEnv,
  encodedClaims: string,
  signature: string,
): Promise<RemoteMcpBearerSetupClaims | null> {
  return readRemoteMcpBearerSetup({
    encodedClaims,
    signature,
    signingSecret: env.BETTER_AUTH_SECRET,
  });
}

export function registerRemoteMcpBearerSetupRoutes(worker: Hono<{ Bindings: WorkerEnv }>): void {
  worker.get(ROUTE, async (context) => {
    const claims = await claimsForRequest(
      context.env,
      context.req.param("encodedClaims"),
      context.req.param("signature"),
    );
    return claims === null ? denied() : workerPageResponse(setupPage(claims), { forms: true });
  });

  worker.post(ROUTE, async (context) => {
    const claims = await claimsForRequest(
      context.env,
      context.req.param("encodedClaims"),
      context.req.param("signature"),
    );
    const contentType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const bounded = await readBoundedPostRequest(context.req.raw, MAXIMUM_FORM_BYTES);

    if (
      claims === null ||
      contentType !== "application/x-www-form-urlencoded" ||
      bounded === null
    ) {
      return denied();
    }

    const form = new URLSearchParams(new TextDecoder().decode(await bounded.arrayBuffer()));
    if ([...form.keys()].some((key) => key !== "bearerToken")) return denied();
    const tokens = form.getAll("bearerToken");
    if (tokens.length !== 1) return denied();
    const bearerToken = createRemoteMcpConnectionInputSchema.shape.bearerToken.safeParse(tokens[0]);
    if (!bearerToken.success || bearerToken.data === undefined) return denied();

    try {
      const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(claims.ownerKey);
      if (controlPlane.lookupRemoteMcpConnectionCreation === undefined) return denied(503);
      const authority = {
        clientId: "crewhelm:remote-mcp-bearer-handoff",
        ownerKey: claims.ownerKey,
        scopes: [CONNECTIONS_WRITE_SCOPE],
      };
      const lookup = lookupRemoteMcpConnectionCreationResultSchema.safeParse(
        await controlPlane.lookupRemoteMcpConnectionCreation(authority, {
          authKind: "bearer",
          endpoint: claims.endpoint,
          idempotencyKey: claims.idempotencyKey,
          name: claims.name,
        }),
      );
      if (!lookup.success || !lookup.data.ok) return denied();
      if (lookup.data.connection !== null) {
        return workerPageResponse(
          renderWorkerPage({
            body: `      <p class="ch-copy">Crewhelm already connected <strong>${escapePageHtml(claims.name)}</strong>. You can close this window and inspect or attach <code>${escapePageHtml(lookup.data.connection.connectionId)}</code> from your MCP client.</p>`,
            context: "remote MCP credential handoff",
            heading: "Remote MCP already connected.",
            title: "Remote MCP already connected",
            tone: "positive",
          }),
        );
      }

      const discovered = await discoverRemoteMcpTools({
        bearerToken: bearerToken.data,
        endpoint: claims.endpoint,
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      const created = createRemoteMcpConnectionResultSchema.safeParse(
        await controlPlane.createRemoteMcpConnection(authority, {
          authKind: "bearer",
          bearerToken: bearerToken.data,
          catalog: discovered.tools,
          catalogBytes: discovered.catalogBytes,
          endpoint: claims.endpoint,
          idempotencyKey: claims.idempotencyKey,
          name: claims.name,
          server: discovered.server,
          snapshotDigest: discovered.digest,
        }),
      );

      if (!created.success || !created.data.ok) return denied();

      return workerPageResponse(
        renderWorkerPage({
          body: `      <p class="ch-copy">Crewhelm connected <strong>${escapePageHtml(claims.name)}</strong>. You can close this window and inspect or attach <code>${escapePageHtml(created.data.connection.connectionId)}</code> from your MCP client.</p>`,
          context: "remote MCP credential handoff",
          heading: "Remote MCP connected.",
          title: "Remote MCP connected",
          tone: "positive",
        }),
      );
    } catch {
      return denied(503);
    }
  });

  worker.all(ROUTE, () => {
    const response = denied(405);
    response.headers.set("allow", "GET, POST");
    return response;
  });
}
