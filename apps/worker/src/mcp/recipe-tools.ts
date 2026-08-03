import { recipeToolMcpInputSchema, recipeToolResultSchema } from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_RECIPES_TOOL_NAME = "crewhelm_recipes";

export function registerRecipeTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;
  server.registerTool(
    MCP_RECIPES_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Search, inspect, and install immutable public Recipes and Skills. read_skill uses SKILL.md or a safe relative path. Preview with owner-local Connection and exact Brief bindings for selected recurring operations, then confirm the unchanged digest before installation.",
      inputSchema: recipeToolMcpInputSchema,
      title: "Manage Crewhelm Recipes",
    },
    async (input) =>
      controlPlaneToolResult(
        () =>
          controlPlane.recipes === undefined
            ? Promise.resolve({
                error: { code: "incompatible_schema", message: "Recipe request denied." },
                ok: false,
              })
            : controlPlane.recipes(authority, input),
        recipeToolResultSchema,
      ),
  );
}
