import {
  manageAgentWorkflowsInputSchema,
  manageAgentWorkflowsResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { optionalControlPlaneToolResult } from "./tool-result.js";

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
        "Coordinate a bounded multi-step objective as ordered durable Agent Runs. Skills and integrations come from the exact Agent revision; optional Brief references freeze owner context across every stage. Omit outputContract for Markdown, or pass one bounded object-root JSON schema for the final deliverable only. Retain workflowId and revision. List compactly, inspect the selected Workflow, request prompts only for plan debugging, and request deliverable content and its exact schema only after completion when needed. Cancel stops future stages. Terminal deletion also removes the isolated Session, prompts, and deliverable.",
      inputSchema: manageAgentWorkflowsInputSchema,
      title: "Manage Crewhelm Agent workflows",
    },
    async (input) => {
      const { action: _action, ...request } = input;

      switch (input.action) {
        case "start":
          return optionalControlPlaneToolResult(
            controlPlane.startAgentWorkflow === undefined
              ? undefined
              : () => controlPlane.startAgentWorkflow!(authority, request),
            manageAgentWorkflowsResultSchema,
          );
        case "list":
          return optionalControlPlaneToolResult(
            controlPlane.listAgentWorkflows === undefined
              ? undefined
              : () => controlPlane.listAgentWorkflows!(authority, request),
            manageAgentWorkflowsResultSchema,
          );
        case "inspect":
          return optionalControlPlaneToolResult(
            controlPlane.inspectAgentWorkflow === undefined
              ? undefined
              : () => controlPlane.inspectAgentWorkflow!(authority, request),
            manageAgentWorkflowsResultSchema,
          );
        case "cancel":
          return optionalControlPlaneToolResult(
            controlPlane.cancelAgentWorkflow === undefined
              ? undefined
              : () => controlPlane.cancelAgentWorkflow!(authority, request),
            manageAgentWorkflowsResultSchema,
          );
        case "delete":
          return optionalControlPlaneToolResult(
            controlPlane.deleteAgentWorkflow === undefined
              ? undefined
              : () => controlPlane.deleteAgentWorkflow!(authority, request),
            manageAgentWorkflowsResultSchema,
          );
      }

      input.action satisfies never;
      throw new Error("Invariant violated: unsupported workflow action.");
    },
  );
}
