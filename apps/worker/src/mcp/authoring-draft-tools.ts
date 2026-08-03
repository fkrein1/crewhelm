import { mcpAuthoringDraftInputSchema, mcpAuthoringDraftResultSchema } from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import type { McpToolContext } from "./context.js";
import { optionalControlPlaneToolResult } from "./tool-result.js";

export const MCP_AUTHORING_DRAFTS_TOOL_NAME = "crewhelm_authoring_drafts";

export function registerAuthoringDraftTools(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    MCP_AUTHORING_DRAFTS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Private bounded owner-scoped MCP authoring draft storage.",
      inputSchema: z.strictObject({
        request: z
          .string()
          .min(2)
          .max(192 * 1_024),
      }),
      title: "Store Crewhelm authoring draft",
    },
    async ({ request }) => {
      let input: unknown;
      try {
        input = JSON.parse(request) as unknown;
      } catch {
        input = null;
      }
      const parsed = mcpAuthoringDraftInputSchema.safeParse(input);
      return optionalControlPlaneToolResult(
        parsed.success && context.controlPlane.mcpAuthoringDrafts !== undefined
          ? async () => context.controlPlane.mcpAuthoringDrafts?.(context.authority, parsed.data)
          : undefined,
        mcpAuthoringDraftResultSchema,
      );
    },
  );
}
