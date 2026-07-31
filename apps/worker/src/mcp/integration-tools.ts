import {
  CONNECTION_CONFIGS_WRITE_SCOPE,
  completeIntegrationEnablementInputSchema,
  enableIntegrationInputSchema,
  enableIntegrationResultSchema,
  inspectIntegrationToolInputSchema,
  inspectIntegrationToolResultSchema,
  integrationAuthConfigListInputSchema,
  integrationAuthConfigListResultSchema,
  integrationCatalogSearchInputSchema,
  integrationCatalogSearchResultSchema,
  integrationToolSearchInputSchema,
  integrationToolSearchResultSchema,
  reserveIntegrationEnablementResultSchema,
} from "@crewhelm/contracts";
import type { ComposioAuthConfigs, ComposioCatalog } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type * as z from "zod";

import type { McpToolContext } from "./context.js";
import {
  connectionConfigurationToolResult,
  integrationReadToolResult,
  unavailableToolResult,
  validatedToolResult,
} from "./tool-result.js";

export const MCP_ENABLE_INTEGRATION_TOOL_NAME = "crewhelm_enable_integration";
export const MCP_INSPECT_INTEGRATION_TOOL_NAME = "crewhelm_inspect_integration_tool";
export const MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME = "crewhelm_list_integration_auth_configs";
export const MCP_SEARCH_INTEGRATIONS_TOOL_NAME = "crewhelm_search_integrations";
export const MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME = "crewhelm_search_integration_tools";

interface IntegrationToolConfiguration {
  authConfigs: ComposioAuthConfigs;
  catalog: ComposioCatalog;
}

function integrationEnablementMcpResult(result: unknown) {
  return validatedToolResult(result, enableIntegrationResultSchema);
}

function unknownIntegrationEnablementMcpResult(operation: {
  recoverAfter: string;
  reservationId: string;
}) {
  return integrationEnablementMcpResult({
    error: {
      code: "integration_enablement_outcome_unknown",
      message: "Integration enablement request denied.",
      operation: {
        nextAction: "retry_same_request",
        recoverAfter: operation.recoverAfter,
        reservationId: operation.reservationId,
      },
    },
    ok: false,
  });
}

async function enableIntegration(
  context: McpToolContext,
  authConfigs: ComposioAuthConfigs,
  input: unknown,
) {
  const { authority, controlPlane } = context;

  if (!authority.scopes.includes(CONNECTION_CONFIGS_WRITE_SCOPE)) {
    return integrationEnablementMcpResult({
      error: {
        code: "insufficient_scope",
        message: "Integration enablement request denied.",
      },
      ok: false,
    });
  }

  if (!authConfigs.isAvailable()) {
    return integrationEnablementMcpResult({
      error: {
        code: "integration_enablement_unavailable",
        message: "Integration enablement request denied.",
      },
      ok: false,
    });
  }

  let reservation: z.infer<typeof reserveIntegrationEnablementResultSchema>;

  try {
    reservation = reserveIntegrationEnablementResultSchema.parse(
      await controlPlane.reserveIntegrationEnablement(authority, input),
    );
  } catch {
    return unavailableToolResult();
  }

  if (!reservation.ok) {
    return integrationEnablementMcpResult(reservation);
  }

  if (reservation.state === "replay") {
    return integrationEnablementMcpResult({
      authConfigId: reservation.authConfigId,
      authScheme: reservation.authScheme,
      created: false,
      integrationSlug: reservation.integrationSlug,
      managed: true,
      ok: true,
    });
  }

  const request = enableIntegrationInputSchema.parse(input);
  let providerResult: Awaited<ReturnType<ComposioAuthConfigs["ensureManaged"]>>;

  try {
    providerResult = await authConfigs.ensureManaged({
      integrationSlug: request.integrationSlug,
    });
  } catch {
    return unknownIntegrationEnablementMcpResult(reservation);
  }

  if (!providerResult.ok) {
    return providerResult.error.code === "integration_enablement_outcome_unknown"
      ? unknownIntegrationEnablementMcpResult(reservation)
      : integrationEnablementMcpResult(providerResult);
  }

  try {
    return integrationEnablementMcpResult(
      await controlPlane.completeIntegrationEnablement(
        authority,
        completeIntegrationEnablementInputSchema.parse({
          ...providerResult.authConfig,
          created: providerResult.created,
          reservationId: reservation.reservationId,
        }),
      ),
    );
  } catch {
    return unknownIntegrationEnablementMcpResult(reservation);
  }
}

export function registerIntegrationTools(
  server: McpServer,
  context: McpToolContext,
  configuration: IntegrationToolConfiguration,
): void {
  const { authority } = context;
  const { authConfigs, catalog } = configuration;

  server.registerTool(
    MCP_ENABLE_INTEGRATION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Enable managed authentication for a chosen integration. Pass the returned authConfigId directly to crewhelm_create_connection_link; do not list auth configurations after a successful enablement.",
      inputSchema: enableIntegrationInputSchema,
      title: "Enable integration",
    },
    async (input) => enableIntegration(context, authConfigs, input),
  );

  server.registerTool(
    MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "List bounded pre-existing auth configurations for an integration. This recovery or selection read is unnecessary immediately after crewhelm_enable_integration returns authConfigId.",
      inputSchema: integrationAuthConfigListInputSchema,
      title: "List integration auth configurations",
    },
    async (input) =>
      connectionConfigurationToolResult(
        authority,
        () => catalog.listAuthConfigs(input),
        integrationAuthConfigListResultSchema,
      ),
  );

  server.registerTool(
    MCP_INSPECT_INTEGRATION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Inspect bounded parameter schemas for one exact integration tool version. This is optional for review or runtime argument planning, not a prerequisite to attach a search result.",
      inputSchema: inspectIntegrationToolInputSchema,
      title: "Inspect integration tool",
    },
    async (input) =>
      integrationReadToolResult(
        authority,
        () => catalog.inspectTool(input),
        inspectIntegrationToolResultSchema,
      ),
  );

  server.registerTool(
    MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Choose an integration provider from the complete catalog. Skip this call when its slug is already known; use crewhelm_search_integration_tools later to choose provider actions.",
      inputSchema: integrationCatalogSearchInputSchema,
      title: "Search integrations",
    },
    async (input) =>
      integrationReadToolResult(
        authority,
        () => catalog.search(input),
        integrationCatalogSearchResultSchema,
      ),
  );

  server.registerTool(
    MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Choose exact provider actions, normally filtered by an already selected integrationSlug. Returned slug and version pairs can be attached directly; inspect only tools whose parameter schemas need review.",
      inputSchema: integrationToolSearchInputSchema,
      title: "Search integration tools",
    },
    async (input) =>
      integrationReadToolResult(
        authority,
        () => catalog.searchTools(input),
        integrationToolSearchResultSchema,
      ),
  );
}
