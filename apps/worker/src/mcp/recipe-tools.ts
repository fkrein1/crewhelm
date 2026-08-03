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
        "Search the public Crewhelm Recipe Registry, progressively inspect exact immutable Recipe or Skill content, preview owner-local consequences, then install only a confirmed digest. Installation imports selected Skills, creates a disabled Agent, retains selected operations, creates no Connections or grants, and starts no work. Use recover with the returned installation ID after an incomplete apply.",
      inputSchema: recipeToolMcpInputSchema,
      title: "Discover and install Crewhelm Recipes",
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
