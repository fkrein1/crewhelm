import {
  CONNECTION_CONFIGS_READ_SCOPE,
  CONNECTION_CONFIGS_WRITE_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
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
  prepareProviderAuthSetupResultSchema,
  providerAuthConfigReferenceSchema,
  providerAuthSetupPlanSchema,
  PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS,
  PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS,
  type InspectProviderAuthResult,
  type IntegrationAuthConfigListResult,
  type ProviderAuthScheme,
  type ProviderAuthConfigReference,
} from "@crewhelm/contracts";
import type { ComposioAuthConfigs, ComposioCatalog } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { createProviderAuthSetupCapability } from "../provider-auth-setup/capability.js";
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
  publicOrigin: string;
  signingSecret: string;
}

function hexDigest(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digestFields(fields: unknown): Promise<string> {
  return hexDigest(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields))),
    ),
  );
}

function customAuthConfigName(integrationName: string, reservationId: string): string {
  const suffix = ` · ${reservationId.slice(-12)}`;
  const maximumBaseLength = 160 - suffix.length;
  let base = "";
  for (const character of integrationName) {
    if (base.length + character.length > maximumBaseLength) break;
    base += character;
  }
  return `${base}${suffix}`;
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

function unavailableProviderAuthInspection(): InspectProviderAuthResult {
  return {
    error: {
      code: "provider_auth_unavailable",
      message: "Provider authentication request denied.",
    },
    ok: false,
  };
}

function readinessReferences(
  authentication: Extract<InspectProviderAuthResult, { ok: true }>["authentication"],
): ProviderAuthConfigReference[] {
  if (authentication.state === "ready") return [authentication.selected];
  if (authentication.state === "selection_required") return authentication.choices;
  return [];
}

function mergeOwnerProviderAuth(
  provider: InspectProviderAuthResult,
  owner: IntegrationAuthConfigListResult,
  activeCustom: readonly ProviderAuthConfigReference[],
): InspectProviderAuthResult {
  if (!provider.ok || !owner.ok || owner.nextCursor !== null) {
    return unavailableProviderAuthInspection();
  }
  if (provider.authentication.state === "unsupported") return provider;

  const providerReferences = readinessReferences(provider.authentication);
  if (providerReferences.some((reference) => reference.source !== "composio_managed")) {
    return unavailableProviderAuthInspection();
  }
  if (activeCustom.some((reference) => reference.source !== "crewhelm_custom")) {
    return unavailableProviderAuthInspection();
  }
  const activeCustomById = new Map(
    activeCustom.map((reference) => [reference.authConfigId, reference]),
  );
  const ownerCustomReferences: ProviderAuthConfigReference[] = [];
  for (const reference of owner.authConfigs.filter((item) => item.managed === false)) {
    const parsed = providerAuthConfigReferenceSchema.safeParse({
      authConfigId: reference.authConfigId,
      authScheme: reference.authScheme.toUpperCase(),
      integrationSlug: provider.integration.slug,
      name: reference.name,
      source: "crewhelm_custom",
    });
    const active = activeCustomById.get(reference.authConfigId);
    if (
      !parsed.success ||
      active === undefined ||
      active.authScheme !== parsed.data.authScheme ||
      active.integrationSlug !== parsed.data.integrationSlug
    ) {
      continue;
    }
    ownerCustomReferences.push(parsed.data);
  }

  const references = [...providerReferences, ...ownerCustomReferences].toSorted((left, right) =>
    left.authConfigId.localeCompare(right.authConfigId),
  );
  if (new Set(references.map((reference) => reference.authConfigId)).size !== references.length) {
    return unavailableProviderAuthInspection();
  }
  if (references.length === 0) return provider;

  return inspectProviderAuthResultSchema.parse({
    authentication:
      references.length === 1
        ? { selected: references[0], state: "ready" }
        : { choices: references, state: "selection_required" },
    integration: provider.integration,
    ok: true,
  });
}

async function inspectOwnerProviderAuth(
  context: McpToolContext,
  authConfigs: ComposioAuthConfigs,
  integrationSlug: string,
): Promise<InspectProviderAuthResult> {
  if (context.controlPlane.listProviderAuthConfigs === undefined) {
    return unavailableProviderAuthInspection();
  }

  try {
    const [providerResponse, ownerResponse, activeCustomResponse] = await Promise.all([
      authConfigs.inspect({ integrationSlug }),
      context.controlPlane.listProviderAuthConfigs(context.authority, {
        integrationSlug,
        limit: 50,
      }),
      authConfigs.activeCustom({ integrationSlug }),
    ]);
    const provider = inspectProviderAuthResultSchema.safeParse(providerResponse);
    const owner = integrationAuthConfigListResultSchema.safeParse(ownerResponse);
    return provider.success && owner.success && activeCustomResponse !== undefined
      ? mergeOwnerProviderAuth(provider.data, owner.data, activeCustomResponse)
      : unavailableProviderAuthInspection();
  } catch {
    return unavailableProviderAuthInspection();
  }
}

async function enableIntegration(
  context: McpToolContext,
  configuration: IntegrationToolConfiguration,
  input: unknown,
) {
  const { authority, controlPlane } = context;
  const { authConfigs } = configuration;

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

  const inspection = await inspectOwnerProviderAuth(
    context,
    authConfigs,
    request.data.integrationSlug,
  );
  if (!inspection.ok) {
    return integrationEnablementMcpResult({
      error: {
        code: "provider_auth_unavailable",
        message: "Integration enablement request denied.",
      },
      ok: false,
    });
  }

  const readiness = inspection.authentication;
  let selected = readiness.state === "ready" ? readiness.selected : undefined;
  let composioHostedAuth: { authScheme: ProviderAuthScheme; name: string } | undefined;

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
    if (selected === undefined) return integrationEnablementMcpResult(inspection);
  } else if (readiness.state === "unsupported") {
    return integrationEnablementMcpResult(inspection);
  } else if (readiness.state === "setup_required") {
    if (request.data.authConfigId !== undefined) {
      return integrationEnablementMcpResult({
        error: { code: "invalid_request", message: "Integration enablement request denied." },
        ok: false,
      });
    }
    if (!readiness.managedAuthAvailable) {
      const prepared = await authConfigs.prepareCustom({
        authScheme: readiness.recommendedScheme,
        integrationSlug: request.data.integrationSlug,
      });
      if (!prepared.ok) {
        return integrationEnablementMcpResult({
          error: {
            code: "provider_auth_unavailable",
            message: "Integration enablement request denied.",
          },
          ok: false,
        });
      }

      if (!prepared.requiresAuthConfigCredentials) {
        composioHostedAuth = {
          authScheme: readiness.recommendedScheme,
          name: prepared.integrationName,
        };
      } else {
        if (controlPlane.prepareProviderAuthSetup === undefined) {
          return unavailableToolResult({
            code: "invalid_control_plane_response",
            disposition: "contact_operator",
            phase: "control_plane.response",
            reason: "invalid_response",
          });
        }

        const now = Date.now();
        const capabilityExpiresAt = now + PROVIDER_AUTH_SETUP_CAPABILITY_LIFETIME_MS;
        const setupExpiresAt = now + PROVIDER_AUTH_SETUP_SESSION_LIFETIME_MS;
        const setupId = `provider_auth_setup_${crypto.randomUUID()}`;
        const authorizeConnection = authority.scopes.includes(CONNECTIONS_WRITE_SCOPE);
        const setupFields = prepared.fields.filter((field) => field.stage === "auth_config");
        const plan = providerAuthSetupPlanSchema.parse({
          authorizeConnection,
          authScheme: readiness.recommendedScheme,
          ...(prepared.callbackUrl === undefined ? {} : { callbackUrl: prepared.callbackUrl }),
          ...(prepared.documentationUrl === undefined
            ? {}
            : { documentationUrl: prepared.documentationUrl }),
          fieldSchemaDigest: await digestFields(setupFields),
          fields: setupFields,
          integrationName: prepared.integrationName,
          integrationSlug: request.data.integrationSlug,
          support: prepared.support,
          setupId,
        });
        const capability = await createProviderAuthSetupCapability({
          claims: { expiresAt: capabilityExpiresAt, ownerKey: authority.ownerKey, setupId },
          origin: configuration.publicOrigin,
          signingSecret: configuration.signingSecret,
        });

        let setupResponse: unknown;
        try {
          setupResponse = await controlPlane.prepareProviderAuthSetup(authority, {
            capabilityDigest: capability.capabilityDigest,
            capabilityExpiresAt,
            idempotencyKey: request.data.idempotencyKey,
            plan,
            setupExpiresAt,
          });
        } catch {
          return unavailableToolResult({ phase: "control_plane.rpc", reason: "transport_error" });
        }
        const setup = prepareProviderAuthSetupResultSchema.safeParse(setupResponse);
        if (!setup.success) {
          return unavailableToolResult({
            code: "invalid_control_plane_response",
            disposition: "contact_operator",
            phase: "control_plane.response",
            reason: "invalid_response",
          });
        }
        if (!setup.data.ok) {
          return integrationEnablementMcpResult({
            error: {
              code:
                setup.data.error.code === "provider_auth_setup_limit_exceeded"
                  ? "integration_enablement_request_limit_exceeded"
                  : setup.data.error.code,
              message: "Integration enablement request denied.",
            },
            ok: false,
          });
        }
        const returnedCapability = await createProviderAuthSetupCapability({
          claims: {
            expiresAt: setup.data.capabilityExpiresAt,
            ownerKey: authority.ownerKey,
            setupId: setup.data.setupId,
          },
          origin: configuration.publicOrigin,
          signingSecret: configuration.signingSecret,
        });
        return integrationEnablementMcpResult({
          ...inspection,
          authentication: {
            ...inspection.authentication,
            setup: {
              expiresAt: new Date(setup.data.capabilityExpiresAt).toISOString(),
              url: returnedCapability.url,
            },
          },
        });
      }
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
      managed: reservation.data.managed,
      ok: true,
    });
  }

  let providerResult:
    | Awaited<ReturnType<ComposioAuthConfigs["createCustom"]>>
    | Awaited<ReturnType<ComposioAuthConfigs["createManaged"]>>;

  try {
    providerResult =
      composioHostedAuth === undefined
        ? await authConfigs.createManaged({
            integrationSlug: request.data.integrationSlug,
            name: inspection.integration.name,
          })
        : await authConfigs.createCustom({
            authScheme: composioHostedAuth.authScheme,
            credentials: {},
            integrationSlug: request.data.integrationSlug,
            name: customAuthConfigName(composioHostedAuth.name, reservation.data.reservationId),
          });
  } catch {
    return unknownIntegrationEnablementMcpResult(reservation.data);
  }

  if (!providerResult.ok) {
    return unknownIntegrationEnablementMcpResult(reservation.data);
  }

  const completion = completeIntegrationEnablementInputSchema.safeParse({
    authConfigId: providerResult.authConfig.authConfigId,
    authScheme: providerResult.authConfig.authScheme.toLowerCase(),
    created: "created" in providerResult ? providerResult.created : true,
    integrationSlug: providerResult.authConfig.integrationSlug,
    managed: composioHostedAuth === undefined,
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

  const result = await inspectOwnerProviderAuth(context, authConfigs, request.data.integrationSlug);

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
        "Resolve provider authentication readiness, reuse an exact selected auth config, create credential-free or managed authentication, or return an owner browser setup link when reusable app credentials are required. Setup and selection prerequisites create no connection-effect reservation.",
      inputSchema: enableIntegrationInputSchema,
      title: "Enable integration",
    },
    async (input) => enableIntegration(context, configuration, input),
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
        "List bounded owner-held auth-config references for an integration; use provider-auth inspection for current activity.",
      inputSchema: integrationAuthConfigListInputSchema,
      title: "List integration auth configurations",
    },
    async (input) =>
      connectionConfigurationToolResult(
        authority,
        () =>
          context.controlPlane.listProviderAuthConfigs?.(authority, input) ??
          Promise.resolve({
            error: {
              code: "integration_catalog_unavailable",
              message: "Integration catalog request denied.",
            },
            ok: false,
          }),
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
