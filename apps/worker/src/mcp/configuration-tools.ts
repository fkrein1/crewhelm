import {
  configureFleetConfigurationResultSchema,
  fleetConfigurationPatchSchema,
  fleetConfigurationRevisionNumberSchema,
  getAgentCapabilityCatalogInputSchema,
  getAgentCapabilityCatalogResultSchema,
  getFleetConfigurationInputSchema,
  getFleetConfigurationResultSchema,
  OWNER_READ_SCOPE,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import {
  AVAILABLE_AGENT_CAPABILITY_PREREQUISITES,
  agentCapabilityRegistry,
} from "../agent-capabilities/registry.js";
import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_GET_CONFIGURATION_TOOL_NAME = "crewhelm_get_config";
export const MCP_CONFIGURE_TOOL_NAME = "crewhelm_configure";
const previewFleetConfigurationInputSchema = z.strictObject({
  expectedRevision: fleetConfigurationRevisionNumberSchema.describe(
    "Current revision returned by crewhelm_get_config; stale revisions are rejected.",
  ),
  mode: z.literal("preview"),
  patch: fleetConfigurationPatchSchema,
  target: z
    .strictObject({ kind: z.literal("fleet") })
    .describe('Use { kind: "fleet" } to preview the authenticated owner\'s configuration.'),
});
const getConfigurationInputSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [
    getFleetConfigurationInputSchema.shape.target,
    getAgentCapabilityCatalogInputSchema.shape.target,
  ]),
});
const getConfigurationResultSchema = z.union([
  getFleetConfigurationResultSchema,
  getAgentCapabilityCatalogResultSchema,
]);

export function registerConfigurationTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_GET_CONFIGURATION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Get fleet policy or discover bounded Agent capability modules. Use target kind fleet for current policy and revision, or agent-capability with an optional module ID for configuration fields, prerequisites, availability, and trust handling. Policy changes require a deterministic owner step-up path; rerun crewhelm up with --ai-budget-usd for the optional Cloudflare AI Gateway limit. Requires control:read.",
      inputSchema: getConfigurationInputSchema,
      title: "Get Crewhelm configuration",
    },
    async (input) => {
      const capabilityRequest = getAgentCapabilityCatalogInputSchema.safeParse(input);

      if (capabilityRequest.success) {
        return controlPlaneToolResult(async () => {
          if (!authority.scopes.includes(OWNER_READ_SCOPE)) {
            return {
              error: {
                code: "insufficient_scope",
                message: "Agent capability request denied.",
              },
              ok: false,
            };
          }

          const capabilities = agentCapabilityRegistry.catalog(
            AVAILABLE_AGENT_CAPABILITY_PREREQUISITES,
            capabilityRequest.data.target.id,
          );

          return capabilities.length === 0
            ? {
                error: {
                  code: "capability_not_found",
                  message: "Agent capability request denied.",
                },
                ok: false,
              }
            : { capabilities, ok: true };
        }, getConfigurationResultSchema);
      }

      return controlPlaneToolResult(
        () => controlPlane.getFleetConfiguration(authority, input),
        getConfigurationResultSchema,
      );
    },
  );

  server.registerTool(
    MCP_CONFIGURE_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Preview one revision-checked partial fleet configuration update. Requires autonomy:write. This tool never applies policy changes; application requires a deterministic owner step-up path outside model authority. Omitted fields do not change.",
      inputSchema: previewFleetConfigurationInputSchema,
      title: "Preview Crewhelm configuration",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.configureFleetConfiguration(authority, input),
        configureFleetConfigurationResultSchema,
      ),
  );
}
