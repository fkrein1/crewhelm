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
import type { ComposioConnectionLinks, ComposioRuntime } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createConnectionAuthorizationCallback } from "../owner/connections/index.js";
import type { McpToolContext, OwnerControlPlaneClient } from "./context.js";
import { unavailableToolResult, validatedToolResult } from "./tool-result.js";

export const MCP_CREATE_CONNECTION_LINK_TOOL_NAME = "crewhelm_create_connection_link";
export const MCP_LIST_CONNECTIONS_TOOL_NAME = "crewhelm_list_connections";

interface ConnectionToolConfiguration {
  connectionLinks: ComposioConnectionLinks;
  publicOrigin: string;
  runtime: ComposioRuntime;
  signingSecret: string;
  signal: AbortSignal;
}

function connectionLinkMcpResult(result: unknown) {
  return validatedToolResult(result, createConnectionLinkResultSchema, {
    code: "invalid_integration_response",
    disposition: "contact_operator",
    phase: "integration.response",
    reason: "invalid_response",
  });
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

  const request = createConnectionLinkInputSchema.safeParse(input);

  if (!request.success) {
    return connectionLinkMcpResult({
      error: {
        code: "invalid_request",
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

  let reservationResponse: unknown;

  try {
    reservationResponse = await controlPlane.reserveConnectionLink(authority, request.data);
  } catch {
    return unavailableToolResult({
      phase: "control_plane.rpc",
      reason: "transport_error",
    });
  }

  const reservation = reserveConnectionLinkResultSchema.safeParse(reservationResponse);

  if (!reservation.success) {
    return unavailableToolResult({
      code: "invalid_control_plane_response",
      disposition: "contact_operator",
      phase: "control_plane.response",
      reason: "invalid_response",
    });
  }

  if (!reservation.data.ok) {
    return connectionLinkMcpResult(reservation.data);
  }

  if (reservation.data.state === "replay") {
    return connectionLinkMcpResult({
      connectionLink: reservation.data.connectionLink,
      created: false,
      ok: true,
    });
  }

  let providerResult: Awaited<ReturnType<ComposioConnectionLinks["create"]>>;

  try {
    const callback = await createConnectionAuthorizationCallback({
      authorizationExpiresAt: reservation.data.authorizationExpiresAt,
      authorizationToken: reservation.data.authorizationToken,
      ownerKey: authority.ownerKey,
      origin: configuration.publicOrigin,
      reservationId: reservation.data.reservationId,
      signingSecret: configuration.signingSecret,
    });

    providerResult = await configuration.connectionLinks.create({
      authConfigId: request.data.authConfigId,
      callbackSecrets: callback.callbackSecrets,
      callbackUrl: callback.callbackUrl,
      userId: authority.ownerKey,
    });
  } catch {
    return unknownConnectionLinkMcpResult(reservation.data);
  }

  if (!providerResult.ok) {
    return providerResult.error.code === "connection_link_outcome_unknown"
      ? unknownConnectionLinkMcpResult(reservation.data)
      : connectionLinkMcpResult(providerResult);
  }

  const completion = completeConnectionLinkInputSchema.safeParse({
    ...providerResult.connectionLink,
    authorizationToken: reservation.data.authorizationToken,
    reservationId: reservation.data.reservationId,
  });

  if (!completion.success) {
    return unknownConnectionLinkMcpResult(reservation.data);
  }

  let completionResponse: unknown;

  try {
    completionResponse = await controlPlane.completeConnectionLink(authority, completion.data);
  } catch {
    return unknownConnectionLinkMcpResult(reservation.data);
  }

  const completed = createConnectionLinkResultSchema.safeParse(completionResponse);
  return completed.success
    ? connectionLinkMcpResult(completed.data)
    : unknownConnectionLinkMcpResult(reservation.data);
}

async function listConnections(
  authority: OwnerAuthority,
  controlPlane: OwnerControlPlaneClient,
  configuration: ConnectionToolConfiguration,
  input: z.infer<typeof listConnectionsInputSchema>,
) {
  let local: z.infer<typeof listConnectionsResultSchema>;

  try {
    local = listConnectionsResultSchema.parse(await controlPlane.listConnections(authority, input));
  } catch {
    return unavailableToolResult();
  }

  if (!local.ok || input.connectionId === undefined) {
    return validatedToolResult(local, listConnectionsResultSchema);
  }

  const connection = local.connections[0];

  if (
    connection === undefined ||
    connection.status !== "initiated" ||
    connection.authorizationOutcome !== "returned" ||
    connection.integrationSlug === null
  ) {
    return validatedToolResult(local, listConnectionsResultSchema);
  }

  if (!authority.scopes.includes(CONNECTIONS_WRITE_SCOPE)) {
    return validatedToolResult(
      {
        error: { code: "insufficient_scope", message: "Connection request denied." },
        ok: false,
      },
      listConnectionsResultSchema,
    );
  }

  let verified: Awaited<ReturnType<ComposioRuntime["verifyConnection"]>>;

  try {
    verified = await configuration.runtime.verifyConnection(
      connection.providerConnectionId,
      configuration.signal,
    );
  } catch {
    return validatedToolResult(local, listConnectionsResultSchema);
  }

  if (!verified.ok || verified.toolkitSlug !== connection.integrationSlug) {
    return validatedToolResult(local, listConnectionsResultSchema);
  }

  if (controlPlane.activateVerifiedConnection === undefined) {
    return unavailableToolResult();
  }

  try {
    return validatedToolResult(
      await controlPlane.activateVerifiedConnection(authority, {
        accountLabel: verified.accountLabel,
        connectionId: connection.connectionId,
        providerConnectionId: connection.providerConnectionId,
        verifiedIntegrationSlug: verified.toolkitSlug,
      }),
      listConnectionsResultSchema,
    );
  } catch {
    return unavailableToolResult();
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
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "List bounded local connection summaries. Exact inspection with Connections write access verifies and activates one returned provider account. Credentials are never exposed.",
      inputSchema: listConnectionsInputSchema,
      title: "Inspect and reconcile integration connections",
    },
    async (input) => listConnections(authority, controlPlane, configuration, input),
  );
}
