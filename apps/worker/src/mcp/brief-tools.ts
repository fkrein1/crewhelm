import { manageBriefsInputSchema, manageBriefsResultSchema } from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_BRIEFS_TOOL_NAME = "crewhelm_briefs";

export function registerBriefTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_BRIEFS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Create or revise bounded owner-provided text Briefs, list compact metadata, inspect an exact revision, read content only when needed, or delete an unreferenced Brief. Retain the returned id and revision and pass them unchanged to a Run or Workflow. Revisions are immutable; lists and ordinary inspection never return content.",
      inputSchema: manageBriefsInputSchema,
      title: "Manage Crewhelm Briefs",
    },
    async (input) =>
      controlPlaneToolResult(() => {
        const { action: _action, ...request } = input;

        switch (input.action) {
          case "create":
            return controlPlane.createBrief(authority, request);
          case "revise":
            return controlPlane.reviseBrief(authority, request);
          case "list":
            return controlPlane.listBriefs(authority, request);
          case "inspect":
            return controlPlane.inspectBrief(authority, request);
          case "read":
            return controlPlane.readBrief(authority, request);
          case "delete":
            return controlPlane.deleteBrief(authority, request);
        }

        throw new Error("Brief action unavailable.");
      }, manageBriefsResultSchema),
  );
}
