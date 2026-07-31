import {
  CONNECTIONS_WRITE_SCOPE,
  completeConnectionLinkInputSchema,
  createConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  listConnectionsInputSchema,
  listConnectionsResultSchema,
  reserveConnectionLinkResultSchema,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import type { ComposioConnectionLinks } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as z from "zod";

import { createConnectionAuthorizationCallback } from "../owner/connections/index.js";
import type { McpToolContext, OwnerControlPlaneClient } from "./context.js";
import {
  controlPlaneToolResult,
  unavailableToolResult,
  validatedToolResult,
} from "./tool-result.js";

export const MCP_CREATE_CONNECTION_LINK_TOOL_NAME = "crewhelm_create_connection_link";
export const MCP_LIST_CONNECTIONS_TOOL_NAME = "crewhelm_list_connections";

interface ConnectionToolConfiguration {
  connectionLinks: ComposioConnectionLinks;
  publicOrigin: string;
  signingSecret: string;
}

function connectionLinkMcpResult(result: unknown) {
  return validatedToolResult(result, createConnectionLinkResultSchema);
}

function unknownConnectionLinkMcpResult(operation: {
  recoverAfter: string;
  reservationId: string;
}) {
  return connectionLinkMcpResult({
    error: {
      code: "connection_link_outcome_unknown",
      message: "Connection link request denied.",
      operation: {
        nextAction: "retry_same_request",
        recoverAfter: operation.recoverAfter,
        reservationId: operation.reservationId,
      },
    },
    ok: false,
  });
}

async function createConnectionLink(
  authority: OwnerAuthority,
  controlPlane: OwnerControlPlaneClient,
  configuration: ConnectionToolConfiguration,
  input: unknown,
) {
  if (!authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)) {
    return connectionLinkMcpResult({
      error: {
        code: "insufficient_scope",
        message: "Connection link request denied.",
      },
      ok: false,
    });
  }

  if (!configuration.connectionLinks.isAvailable()) {
    return connectionLinkMcpResult({
      error: {
        code: "connection_link_unavailable",
        message: "Connection link request denied.",
      },
      ok: false,
    });
  }

  let reservation: z.infer<typeof reserveConnectionLinkResultSchema>;

  try {
    reservation = reserveConnectionLinkResultSchema.parse(
      await controlPlane.reserveConnectionLink(authority, input),
    );
  } catch {
    return unavailableToolResult();
  }

  if (!reservation.ok) {
    return connectionLinkMcpResult(reservation);
  }

  if (reservation.state === "replay") {
    return connectionLinkMcpResult({
      connectionLink: reservation.connectionLink,
      created: false,
      ok: true,
    });
  }

  const request = createConnectionLinkInputSchema.parse(input);
  let providerResult: Awaited<ReturnType<ComposioConnectionLinks["create"]>>;

  try {
    const callback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: reservation.authorizationExpiresAt,
      authorizationToken: reservation.authorizationToken,
      ownerKey: authority.ownerKey,
      origin: configuration.publicOrigin,
      reservationId: reservation.reservationId,
      signingSecret: configuration.signingSecret,
    });

    providerResult = await configuration.connectionLinks.create({
      authConfigId: request.authConfigId,
      callbackSecrets: callback.callbackSecrets,
      callbackUrl: callback.callbackUrl,
      userId: authority.ownerKey,
    });
  } catch {
    return unknownConnectionLinkMcpResult(reservation);
  }

  if (!providerResult.ok) {
    return providerResult.error.code === "connection_link_outcome_unknown"
      ? unknownConnectionLinkMcpResult(reservation)
      : connectionLinkMcpResult(providerResult);
  }

  try {
    const completion = completeConnectionLinkInputSchema.parse({
      ...providerResult.connectionLink,
      authorizationToken: reservation.authorizationToken,
      reservationId: reservation.reservationId,
    });

    return connectionLinkMcpResult(
      await controlPlane.completeConnectionLink(authority, completion),
    );
  } catch {
    return unknownConnectionLinkMcpResult(reservation);
  }
}

export function registerConnectionTools(
  server: McpServer,
  context: McpToolContext,
  configuration: ConnectionToolConfiguration,
): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Create a short-lived owner OAuth link from an exact authConfigId. Let the owner open connectionLink.url, retain connectionLink.connectionId, then inspect that exact connection after authorization; credentials are never exposed.",
      inputSchema: createConnectionLinkInputSchema,
      title: "Create integration connection link",
    },
    async (input) => createConnectionLink(authority, controlPlane, configuration, input),
  );

  server.registerTool(
    MCP_LIST_CONNECTIONS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "List bounded connection summaries, or set connectionId to inspect one exact connection and its safe lifecycle timeline after OAuth. Prefer the exact returned ID or an integration filter; credentials are never exposed.",
      inputSchema: listConnectionsInputSchema,
      title: "List integration connections",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.listConnections(authority, input),
        listConnectionsResultSchema,
      ),
  );
}
