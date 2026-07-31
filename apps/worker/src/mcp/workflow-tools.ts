import {
  manageAgentWorkflowsInputSchema,
  manageAgentWorkflowsResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_AGENT_WORKFLOWS_TOOL_NAME = "crewhelm_agent_workflows";

export function registerWorkflowTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_AGENT_WORKFLOWS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Coordinate a bounded multi-step objective as ordered durable Agent Runs. Start with an exact Agent revision, then use the returned workflowId for compact inspection or cancellation. List before inspecting when recovering context; request frozen prompts only when needed. Cancel stops future stages and safely cancels the active Run when possible. Delete is terminal-only and also removes the Workflow-owned Session transcript and retained prompts.",
      inputSchema: manageAgentWorkflowsInputSchema,
      title: "Manage Crewhelm Agent workflows",
    },
    async (input) =>
      controlPlaneToolResult(() => {
        const { action: _action, ...request } = input;

        switch (input.action) {
          case "start":
            return (
              controlPlane.startAgentWorkflow?.(authority, request) ??
              Promise.reject(new Error("Workflow control plane unavailable."))
            );
          case "list":
            return (
              controlPlane.listAgentWorkflows?.(authority, request) ??
              Promise.reject(new Error("Workflow control plane unavailable."))
            );
          case "inspect":
            return (
              controlPlane.inspectAgentWorkflow?.(authority, request) ??
              Promise.reject(new Error("Workflow control plane unavailable."))
            );
          case "cancel":
            return (
              controlPlane.cancelAgentWorkflow?.(authority, request) ??
              Promise.reject(new Error("Workflow control plane unavailable."))
            );
          case "delete":
            return (
              controlPlane.deleteAgentWorkflow?.(authority, request) ??
              Promise.reject(new Error("Workflow control plane unavailable."))
            );
        }

        throw new Error("Workflow action unavailable.");
      }, manageAgentWorkflowsResultSchema),
  );
}
