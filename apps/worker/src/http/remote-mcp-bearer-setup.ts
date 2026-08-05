import {
  CONNECTIONS_WRITE_SCOPE,
  remoteMcpApiKeyValueSchema,
  createRemoteMcpConnectionResultSchema,
  createRemoteMcpConnectionInputSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
} from "@crewhelm/contracts";
import { type Hono } from "hono";

import type { WorkerEnv } from "../env.js";
import { discoverRemoteMcpTools, RemoteMcpClientError } from "../remote-mcp/client.js";
import {
  readRemoteMcpApiKeySetup,
  readRemoteMcpBearerSetup,
  REMOTE_MCP_API_KEY_SETUP_PATH_PREFIX,
  REMOTE_MCP_BEARER_SETUP_PATH_PREFIX,
  type RemoteMcpApiKeySetupClaims,
  type RemoteMcpBearerSetupClaims,
} from "../remote-mcp/handoff.js";
import { readBoundedPostRequest } from "./request-body.js";
import { escapePageHtml, renderWorkerPage, workerPageResponse } from "./page.js";

const BEARER_ROUTE = `${REMOTE_MCP_BEARER_SETUP_PATH_PREFIX}:encodedClaims/:signature`;
const API_KEY_ROUTE = `${REMOTE_MCP_API_KEY_SETUP_PATH_PREFIX}:encodedClaims/:signature`;
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

function connectionFailed(error: unknown): Response {
  const clientError = error instanceof RemoteMcpClientError ? error : undefined;
  const detail =
    clientError?.failureKind === "upstream_denied" && clientError.upstreamStatus !== undefined
      ? `The remote server rejected Crewhelm's request (HTTP ${clientError.upstreamStatus}). Check the credential and the server's access policy, then request a new setup link.`
      : clientError?.failureKind === "upstream_rate_limited"
        ? "The remote server rate-limited Crewhelm. Wait briefly, then request a new setup link."
        : clientError?.failureKind === "timeout"
          ? "The remote server did not respond before the setup timeout. Check its availability, then request a new setup link."
          : clientError?.failureKind === "upstream_error" &&
              clientError.upstreamStatus !== undefined
            ? `The remote server failed while Crewhelm connected (HTTP ${clientError.upstreamStatus}). Check its availability, then request a new setup link.`
            : "Crewhelm could not complete the remote MCP handshake. Check the endpoint and server compatibility, then request a new setup link.";
  return workerPageResponse(
    renderWorkerPage({
      body: `      <p class="ch-copy">${detail}</p>`,
      heading: "Remote MCP connection failed.",
      title: "Remote MCP connection failed",
      tone: "negative",
    }),
    { status: 502 },
  );
}

type Setup =
  | { authKind: "api_key"; claims: RemoteMcpApiKeySetupClaims }
  | { authKind: "bearer"; claims: RemoteMcpBearerSetupClaims };

function setupPage(setup: Setup): string {
  const { claims } = setup;
  const apiKey = setup.authKind === "api_key";
  const credentialLabel = apiKey ? "API key" : "Bearer token";
  const credentialName = apiKey ? "apiKey" : "bearerToken";
  const credentialDescription = apiKey
    ? `API key is sent as <code>${escapePageHtml(setup.claims.apiKeyHeaderName)}</code>`
    : "bearer token is sent";
  const fieldHint = apiKey
    ? `Crewhelm sends this value only in the <code>${escapePageHtml(setup.claims.apiKeyHeaderName)}</code> header.`
    : "Crewhelm sends this value only as the remote server's bearer credential.";
  return renderWorkerPage({
    body: `      <p class="ch-copy">Connect <strong>${escapePageHtml(claims.name)}</strong> at <code>${escapePageHtml(claims.endpoint)}</code>.</p>
      <p class="ch-copy">The ${credentialDescription} only to Crewhelm's owner-side adapter, encrypted at rest, and never placed in Agent or MCP context.</p>
      <form class="ch-form" method="post">
        <section class="ch-form-section">
          <h2>Credential</h2>
          <div class="ch-field-list">
            <div class="ch-field">
              <label for="remote-mcp-credential">${credentialLabel}<span class="ch-required">Required</span></label>
              <div class="ch-input-wrap">
                <input class="ch-input" id="remote-mcp-credential" name="${credentialName}" type="password" required autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="8192">
              </div>
              <p class="ch-field-hint">${fieldHint}</p>
            </div>
          </div>
        </section>
        <aside class="ch-trust">
          <strong>Security</strong>
          <p>Encrypted at rest and never returned to an Agent, MCP client, log, or audit record.</p>
        </aside>
        <div class="ch-actions">
          <button class="ch-button ch-button--primary" type="submit">Connect MCP server</button>
        </div>
      </form>`,
    context: "remote MCP credential handoff",
    heading: `Enter ${apiKey ? "API-key" : "bearer"} credential.`,
    layout: "form",
    title: "Connect remote MCP",
    tone: "warning",
  });
}

async function claimsForRequest(
  env: WorkerEnv,
  encodedClaims: string | undefined,
  signature: string | undefined,
  authKind: Setup["authKind"],
): Promise<Setup | null> {
  if (encodedClaims === undefined || signature === undefined) return null;
  const input = { encodedClaims, signature, signingSecret: env.BETTER_AUTH_SECRET };
  if (authKind === "api_key") {
    const claims = await readRemoteMcpApiKeySetup(input);
    return claims === null ? null : { authKind, claims };
  }
  const claims = await readRemoteMcpBearerSetup(input);
  return claims === null ? null : { authKind, claims };
}

export function registerRemoteMcpBearerSetupRoutes(worker: Hono<{ Bindings: WorkerEnv }>): void {
  const register = (route: string, authKind: Setup["authKind"]): void => {
    worker.get(route, async (context) => {
      const setup = await claimsForRequest(
        context.env,
        context.req.param("encodedClaims"),
        context.req.param("signature"),
        authKind,
      );
      return setup === null ? denied() : workerPageResponse(setupPage(setup), { forms: true });
    });

    worker.post(route, async (context) => {
      const setup = await claimsForRequest(
        context.env,
        context.req.param("encodedClaims"),
        context.req.param("signature"),
        authKind,
      );
      const contentType = context.req
        .header("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase();
      const bounded = await readBoundedPostRequest(context.req.raw, MAXIMUM_FORM_BYTES);

      if (
        setup === null ||
        contentType !== "application/x-www-form-urlencoded" ||
        bounded === null
      ) {
        return denied();
      }
      const { claims } = setup;

      const credentialName = setup.authKind === "api_key" ? "apiKey" : "bearerToken";
      const form = new URLSearchParams(new TextDecoder().decode(await bounded.arrayBuffer()));
      if ([...form.keys()].some((key) => key !== credentialName)) return denied();
      const values = form.getAll(credentialName);
      if (values.length !== 1) return denied();
      const credential =
        setup.authKind === "api_key"
          ? remoteMcpApiKeyValueSchema.safeParse(values[0])
          : createRemoteMcpConnectionInputSchema.shape.bearerToken.safeParse(values[0]);
      if (!credential.success || credential.data === undefined) return denied();

      try {
        const controlPlane = context.env.OWNER_CONTROL_PLANE.getByName(claims.ownerKey);
        if (controlPlane.lookupRemoteMcpConnectionCreation === undefined) return denied(503);
        const authority = {
          clientId:
            setup.authKind === "api_key"
              ? "crewhelm:remote-mcp-api-key-handoff"
              : "crewhelm:remote-mcp-bearer-handoff",
          ownerKey: claims.ownerKey,
          scopes: [CONNECTIONS_WRITE_SCOPE],
        };
        const lookup = lookupRemoteMcpConnectionCreationResultSchema.safeParse(
          await controlPlane.lookupRemoteMcpConnectionCreation(authority, {
            apiKeyHeaderName:
              setup.authKind === "api_key" ? setup.claims.apiKeyHeaderName : undefined,
            authKind: setup.authKind,
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

        const authentication =
          setup.authKind === "api_key"
            ? { apiKey: { headerName: setup.claims.apiKeyHeaderName, value: credential.data } }
            : { bearerToken: credential.data };
        const discovered = await discoverRemoteMcpTools({
          ...authentication,
          endpoint: claims.endpoint,
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        const created = createRemoteMcpConnectionResultSchema.safeParse(
          await controlPlane.createRemoteMcpConnection(authority, {
            ...authentication,
            authKind: setup.authKind,
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
      } catch (error) {
        const clientError = error instanceof RemoteMcpClientError ? error : undefined;
        console.warn({
          authKind: setup.authKind,
          endpointHost: new URL(claims.endpoint).hostname,
          errorCode: clientError?.code ?? "unexpected",
          event: "crewhelm.remote_mcp.setup_failed",
          failureKind: clientError?.failureKind ?? "unexpected",
          ...(clientError?.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: clientError.upstreamStatus }),
        });
        return connectionFailed(error);
      }
    });

    worker.all(route, () => {
      const response = denied(405);
      response.headers.set("allow", "GET, POST");
      return response;
    });
  };

  register(BEARER_ROUTE, "bearer");
  register(API_KEY_ROUTE, "api_key");
}
