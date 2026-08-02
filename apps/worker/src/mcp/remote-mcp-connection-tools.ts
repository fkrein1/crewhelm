import {
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  createRemoteMcpConnectionResultSchema,
  deleteRemoteMcpConnectionResultSchema,
  inspectRemoteMcpConnectionResultSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
  remoteMcpConnectionOperationInputSchema,
  remoteMcpConnectionOperationResultSchema,
  remoteMcpConnectionToolInputSchema,
  type RemoteMcpConnectionOperationResult,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  discoverRemoteMcpTools,
  normalizeRemoteMcpEndpoint,
  RemoteMcpClientError,
} from "../remote-mcp/client.js";
import { createRemoteMcpBearerSetup } from "../remote-mcp/handoff.js";
import type { McpToolContext } from "./context.js";
import { validatedToolResult } from "./tool-result.js";

export const MCP_REMOTE_MCP_CONNECTION_TOOL_NAME = "crewhelm_remote_mcp_connection";
const REMOTE_MCP_DISCOVERY_TIMEOUT_MS = 15_000;

type Configuration = {
  publicOrigin: string;
  signingSecret: string;
  signal: AbortSignal;
};

function denied(
  code: Extract<RemoteMcpConnectionOperationResult, { ok: false }>["error"]["code"],
): RemoteMcpConnectionOperationResult {
  return {
    error: { code, message: "Remote MCP Connection request denied." },
    ok: false,
  };
}

function result(value: unknown) {
  return validatedToolResult(value, remoteMcpConnectionOperationResultSchema, {
    code: "invalid_control_plane_response",
    disposition: "contact_operator",
    phase: "control_plane.response",
    reason: "invalid_response",
  });
}

export function registerRemoteMcpConnectionTools(
  server: McpServer,
  context: McpToolContext,
  configuration: Configuration,
): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_REMOTE_MCP_CONNECTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Connect, inspect, reauthenticate, or revoke one remote Streamable HTTP MCP Connection. Public endpoints connect directly. Bearer and OAuth endpoints use a short-lived browser setup link so credential material never enters MCP arguments or Agent context.",
      inputSchema: remoteMcpConnectionToolInputSchema,
      title: "Manage a remote MCP Connection",
    },
    async (input) => {
      const request = remoteMcpConnectionOperationInputSchema.safeParse(input);
      if (!request.success) return result(denied("invalid_request"));

      try {
        switch (request.data.action) {
          case "connect": {
            if (!authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)) {
              return result(denied("insufficient_scope"));
            }

            const endpoint = normalizeRemoteMcpEndpoint(request.data.endpoint);

            if (request.data.authKind === "oauth") {
              if (controlPlane.reserveRemoteMcpOAuthSetup === undefined) {
                return result(denied("remote_mcp_unavailable"));
              }
              const reserved = remoteMcpConnectionOperationResultSchema.safeParse(
                await controlPlane.reserveRemoteMcpOAuthSetup(authority, request.data),
              );
              return !reserved.success
                ? result(denied("remote_mcp_unavailable"))
                : result(reserved.data);
            }

            if (request.data.authKind === "bearer") {
              const setup = await createRemoteMcpBearerSetup({
                claims: {
                  endpoint,
                  expiresAt: Date.now() + 10 * 60 * 1_000,
                  idempotencyKey: request.data.idempotencyKey,
                  name: request.data.name,
                  ownerKey: authority.ownerKey,
                },
                origin: configuration.publicOrigin,
                signingSecret: configuration.signingSecret,
              });
              return result({ ok: true, setup, state: "setup_required" });
            }

            if (
              controlPlane.createRemoteMcpConnection === undefined ||
              controlPlane.lookupRemoteMcpConnectionCreation === undefined
            ) {
              return result(denied("remote_mcp_unavailable"));
            }

            const lookup = lookupRemoteMcpConnectionCreationResultSchema.safeParse(
              await controlPlane.lookupRemoteMcpConnectionCreation(authority, {
                authKind: "public",
                endpoint,
                idempotencyKey: request.data.idempotencyKey,
                name: request.data.name,
              }),
            );
            if (!lookup.success) return result(denied("remote_mcp_unavailable"));
            if (!lookup.data.ok) return result(lookup.data);
            if (lookup.data.connection !== null) {
              return result({
                connection: lookup.data.connection,
                created: false,
                ok: true,
                state: "connected",
              });
            }

            const discovered = await discoverRemoteMcpTools({
              endpoint,
              signal: AbortSignal.any([
                configuration.signal,
                AbortSignal.timeout(REMOTE_MCP_DISCOVERY_TIMEOUT_MS),
              ]),
            });
            const created = createRemoteMcpConnectionResultSchema.safeParse(
              await controlPlane.createRemoteMcpConnection(authority, {
                authKind: "public",
                catalog: discovered.tools,
                catalogBytes: discovered.catalogBytes,
                endpoint,
                idempotencyKey: request.data.idempotencyKey,
                name: request.data.name,
                server: discovered.server,
                snapshotDigest: discovered.digest,
              }),
            );

            return !created.success
              ? result(denied("remote_mcp_unavailable"))
              : created.data.ok
                ? result({ ...created.data, state: "connected" })
                : result(created.data);
          }
          case "inspect": {
            if (!authority.scopes.includes(CONNECTIONS_READ_SCOPE)) {
              return result(denied("insufficient_scope"));
            }
            if (controlPlane.inspectRemoteMcpConnection === undefined) {
              return result(denied("remote_mcp_unavailable"));
            }
            const inspected = inspectRemoteMcpConnectionResultSchema.safeParse(
              await controlPlane.inspectRemoteMcpConnection(authority, {
                connectionId: request.data.connectionId,
              }),
            );
            return !inspected.success
              ? result(denied("remote_mcp_unavailable"))
              : inspected.data.ok
                ? result({ ...inspected.data, state: "inspected" })
                : result(inspected.data);
          }
          case "delete": {
            if (!authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)) {
              return result(denied("insufficient_scope"));
            }
            if (controlPlane.deleteRemoteMcpConnection === undefined) {
              return result(denied("remote_mcp_unavailable"));
            }
            const deleted = deleteRemoteMcpConnectionResultSchema.safeParse(
              await controlPlane.deleteRemoteMcpConnection(authority, {
                connectionId: request.data.connectionId,
                idempotencyKey: request.data.idempotencyKey,
                snapshotDigest: request.data.snapshotDigest,
              }),
            );
            return !deleted.success
              ? result(denied("remote_mcp_unavailable"))
              : deleted.data.ok
                ? result({ ...deleted.data, state: "deleted" })
                : result(deleted.data);
          }
          case "reauthenticate": {
            if (!authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)) {
              return result(denied("insufficient_scope"));
            }
            if (controlPlane.reserveRemoteMcpOAuthSetup === undefined) {
              return result(denied("remote_mcp_unavailable"));
            }
            const reserved = remoteMcpConnectionOperationResultSchema.safeParse(
              await controlPlane.reserveRemoteMcpOAuthSetup(authority, request.data),
            );
            return !reserved.success
              ? result(denied("remote_mcp_unavailable"))
              : result(reserved.data);
          }
        }
        return result(denied("invalid_request"));
      } catch (error) {
        return result(
          denied(
            error instanceof RemoteMcpClientError && error.code === "invalid_endpoint"
              ? "invalid_request"
              : "remote_mcp_unavailable",
          ),
        );
      }
    },
  );
}
