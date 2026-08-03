import {
  recipePublicationToolMcpInputSchema,
  recipePublicationToolResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_RECIPE_PUBLICATIONS_TOOL_NAME = "crewhelm_recipe_publications";

export function registerRecipePublicationTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;
  server.registerTool(
    MCP_RECIPE_PUBLICATIONS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Authorize, preview, and publish one Agent revision as an immutable public Recipe. Pass the selected action and its fields as request JSON; confirm the preview digest before publishing.",
      inputSchema: recipePublicationToolMcpInputSchema,
      title: "Publish Crewhelm Recipe",
    },
    async (input) => {
      let normalized: unknown;
      try {
        normalized = JSON.parse(input.request) as unknown;
      } catch {
        normalized = null;
      }
      return controlPlaneToolResult(
        () =>
          controlPlane.recipePublications === undefined
            ? Promise.resolve({
                error: {
                  code: "incompatible_schema",
                  message: "Recipe publication request denied.",
                },
                ok: false,
              })
            : controlPlane.recipePublications(authority, normalized),
        recipePublicationToolResultSchema,
      );
    },
  );
}
