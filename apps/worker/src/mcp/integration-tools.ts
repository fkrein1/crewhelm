import {
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  completeIntegrationEnablementInputSchema,
  enableIntegrationInputSchema,
  enableIntegrationResultSchema,
  inspectIntegrationToolInputSchema,
  inspectIntegrationToolResultSchema,
  inspectProviderAuthInputSchema,
  inspectProviderAuthResultSchema,
  integrationAuthConfigListInputSchema,
  integrationAuthConfigListResultSchema,
  integrationCatalogSearchInputSchema,
  integrationCatalogSearchResultSchema,
  integrationToolSearchInputSchema,
  integrationToolSearchResultSchema,
  reserveIntegrationEnablementResultSchema,
  recordProviderAuthConfigResultSchema,
} from "@crewhelm/contracts";
import type { ComposioAuthConfigs, ComposioCatalog } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import {
  connectionConfigurationToolResult,
  integrationReadToolResult,
  unavailableToolResult,
  validatedToolResult,
} from "./tool-result.js";

export const MCP_ENABLE_INTEGRATION_TOOL_NAME = "crewhelm_enable_integration";
export const MCP_INSPECT_INTEGRATION_TOOL_NAME = "crewhelm_inspect_integration_tool";
export const MCP_INSPECT_PROVIDER_AUTH_TOOL_NAME = "crewhelm_inspect_provider_auth";
export const MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME = "crewhelm_list_integration_auth_configs";
export const MCP_SEARCH_INTEGRATIONS_TOOL_NAME = "crewhelm_search_integrations";
export const MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME = "crewhelm_search_integration_tools";

interface IntegrationToolConfiguration {
  authConfigs: ComposioAuthConfigs;
  catalog: ComposioCatalog;
}

function integrationEnablementMcpResult(result: unknown) {
  return validatedToolResult(result, enableIntegrationResultSchema, {
    code: "invalid_integration_response",
    disposition: "contact_operator",
    phase: "integration.response",
    reason: "invalid_response",
  });
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

  const request = enableIntegrationInputSchema.safeParse(input);

  if (!request.success) {
    return integrationEnablementMcpResult({
      error: {
        code: "invalid_request",
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

  let inspectionResponse: unknown;

  try {
    inspectionResponse = await authConfigs.inspect({
      integrationSlug: request.data.integrationSlug,
    });
  } catch {
    inspectionResponse = null;
  }

  const inspection = inspectProviderAuthResultSchema.safeParse(inspectionResponse);
  if (!inspection.success || !inspection.data.ok) {
    return integrationEnablementMcpResult({
      error: {
        code: "provider_auth_unavailable",
        message: "Integration enablement request denied.",
      },
      ok: false,
    });
  }

  const readiness = inspection.data.authentication;
  let selected = readiness.state === "ready" ? readiness.selected : undefined;

  if (readiness.state === "ready" && request.data.authConfigId !== undefined) {
    if (request.data.authConfigId !== readiness.selected.authConfigId) {
      return integrationEnablementMcpResult({
        error: { code: "invalid_request", message: "Integration enablement request denied." },
        ok: false,
      });
    }
  } else if (readiness.state === "selection_required") {
    selected = readiness.choices.find(
      (choice) => choice.authConfigId === request.data.authConfigId,
    );
    if (selected === undefined) return integrationEnablementMcpResult(inspection.data);
  } else if (readiness.state === "unsupported") {
    return integrationEnablementMcpResult(inspection.data);
  } else if (readiness.state === "setup_required") {
    if (request.data.authConfigId !== undefined) {
      return integrationEnablementMcpResult({
        error: { code: "invalid_request", message: "Integration enablement request denied." },
        ok: false,
      });
    }
    if (!readiness.managedAuthAvailable) {
      return integrationEnablementMcpResult(inspection.data);
    }
  }

  if (selected !== undefined) {
    if (controlPlane.recordProviderAuthConfig === undefined) {
      return unavailableToolResult({
        code: "invalid_control_plane_response",
        disposition: "contact_operator",
        phase: "control_plane.response",
        reason: "invalid_response",
      });
    }

    let recordedResponse: unknown;
    try {
      recordedResponse = await controlPlane.recordProviderAuthConfig(authority, selected);
    } catch {
      return unavailableToolResult({ phase: "control_plane.rpc", reason: "transport_error" });
    }
    const recorded = recordProviderAuthConfigResultSchema.safeParse(recordedResponse);
    if (!recorded.success) {
      return unavailableToolResult({
        code: "invalid_control_plane_response",
        disposition: "contact_operator",
        phase: "control_plane.response",
        reason: "invalid_response",
      });
    }
    if (!recorded.data.ok) {
      return integrationEnablementMcpResult({
        error: {
          code:
            recorded.data.error.code === "provider_auth_config_limit_exceeded"
              ? "integration_enablement_request_limit_exceeded"
              : recorded.data.error.code,
          message: "Integration enablement request denied.",
        },
        ok: false,
      });
    }

    return integrationEnablementMcpResult({
      authConfigId: selected.authConfigId,
      authScheme: selected.authScheme.toLowerCase(),
      created: false,
      integrationSlug: selected.integrationSlug,
      managed: selected.source === "composio_managed",
      ok: true,
    });
  }

  let reservationResponse: unknown;

  try {
    reservationResponse = await controlPlane.reserveIntegrationEnablement(authority, request.data);
  } catch {
    return unavailableToolResult({
      phase: "control_plane.rpc",
      reason: "transport_error",
    });
  }

  const reservation = reserveIntegrationEnablementResultSchema.safeParse(reservationResponse);

  if (!reservation.success) {
    return unavailableToolResult({
      code: "invalid_control_plane_response",
      disposition: "contact_operator",
      phase: "control_plane.response",
      reason: "invalid_response",
    });
  }

  if (!reservation.data.ok) {
    return integrationEnablementMcpResult(reservation.data);
  }

  if (reservation.data.state === "replay") {
    return integrationEnablementMcpResult({
      authConfigId: reservation.data.authConfigId,
      authScheme: reservation.data.authScheme,
      created: false,
      integrationSlug: reservation.data.integrationSlug,
      managed: true,
      ok: true,
    });
  }

  let providerResult: Awaited<ReturnType<ComposioAuthConfigs["createManaged"]>>;

  try {
    providerResult = await authConfigs.createManaged({
      integrationSlug: request.data.integrationSlug,
      name: inspection.data.integration.name,
    });
  } catch {
    return unknownIntegrationEnablementMcpResult(reservation.data);
  }

  if (!providerResult.ok) {
    return providerResult.error.code === "integration_enablement_outcome_unknown"
      ? unknownIntegrationEnablementMcpResult(reservation.data)
      : integrationEnablementMcpResult(providerResult);
  }

  const completion = completeIntegrationEnablementInputSchema.safeParse({
    authConfigId: providerResult.authConfig.authConfigId,
    authScheme: providerResult.authConfig.authScheme.toLowerCase(),
    created: providerResult.created,
    integrationSlug: providerResult.authConfig.integrationSlug,
    managed: true,
    name: providerResult.authConfig.name,
    reservationId: reservation.data.reservationId,
  });

  if (!completion.success) {
    return unknownIntegrationEnablementMcpResult(reservation.data);
  }

  let completionResponse: unknown;

  try {
    completionResponse = await controlPlane.completeIntegrationEnablement(
      authority,
      completion.data,
    );
  } catch {
    return unknownIntegrationEnablementMcpResult(reservation.data);
  }

  const completed = enableIntegrationResultSchema.safeParse(completionResponse);
  return completed.success
    ? integrationEnablementMcpResult(completed.data)
    : unknownIntegrationEnablementMcpResult(reservation.data);
}

async function inspectProviderAuth(
  context: McpToolContext,
  authConfigs: ComposioAuthConfigs,
  input: unknown,
) {
  if (!context.authority.scopes.includes(CONNECTION_CONFIGS_READ_SCOPE)) {
    return validatedToolResult(
      {
        error: {
          code: "insufficient_scope",
          message: "Provider authentication request denied.",
        },
        ok: false,
      },
      inspectProviderAuthResultSchema,
    );
  }

  const request = inspectProviderAuthInputSchema.safeParse(input);
  if (!request.success || !authConfigs.isAvailable()) {
    return validatedToolResult(
      {
        error: {
          code: "provider_auth_unavailable",
          message: "Provider authentication request denied.",
        },
        ok: false,
      },
      inspectProviderAuthResultSchema,
    );
  }

  let result: unknown;
  try {
    result = await authConfigs.inspect(request.data);
  } catch {
    result = null;
  }

  return validatedToolResult(result, inspectProviderAuthResultSchema, {
    code: "invalid_integration_response",
    disposition: "contact_operator",
    phase: "integration.response",
    reason: "invalid_response",
  });
}

export function registerIntegrationTools(
  server: McpServer,
  context: McpToolContext,
  configuration: IntegrationToolConfiguration,
): void {
  const { authority } = context;
  const { authConfigs, catalog } = configuration;

  server.registerTool(
    MCP_INSPECT_PROVIDER_AUTH_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      description:
        "Inspect whether one exact provider can connect now, requires an auth-config choice, or needs owner setup. This read creates no reservation.",
      inputSchema: inspectProviderAuthInputSchema,
      title: "Inspect provider authentication",
    },
    async (input) => inspectProviderAuth(context, authConfigs, input),
  );

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
        "Resolve provider authentication readiness, reuse an exact selected auth config, or create managed authentication when available. Setup and selection prerequisites create no external-effect reservation.",
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
        "List bounded active auth configurations for an integration when exact selection or recovery is needed.",
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
