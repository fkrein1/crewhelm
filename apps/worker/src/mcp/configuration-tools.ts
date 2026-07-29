import {
  configureFleetConfigurationResultSchema,
  fleetConfigurationPatchSchema,
  fleetConfigurationRevisionNumberSchema,
  getFleetConfigurationInputSchema,
  getFleetConfigurationResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

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
        "Get the authenticated owner's current fleet configuration, revision, and installation ceilings. Requires control:read. To evaluate a change, pass this revision and a partial patch to crewhelm_configure with mode preview. Policy changes are not model-applicable and require a deterministic owner step-up path. To change the hard AI Gateway installation ceiling, rerun Crewhelm bootstrap with --ai-budget-usd <dollars>.",
      inputSchema: getFleetConfigurationInputSchema,
      title: "Get Crewhelm configuration",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.getFleetConfiguration(authority, input),
        getFleetConfigurationResultSchema,
      ),
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
        "Preview one revision-checked partial fleet configuration update. Requires autonomy:write. This tool never applies policy changes; application requires a deterministic owner step-up path outside model authority. Omitted fields do not change. Money is expressed as integer microUSD: 1 USD = 1,000,000 microUSD.",
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
