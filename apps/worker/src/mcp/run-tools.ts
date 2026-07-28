import {
  decideRunToolApprovalInputSchema,
  decideRunToolApprovalResultSchema,
  inspectRunInputSchema,
  inspectRunResultSchema,
  listRunToolApprovalsInputSchema,
  listRunToolApprovalsResultSchema,
  startRunInputSchema,
  startRunResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_DECIDE_RUN_TOOL_APPROVAL_TOOL_NAME = "crewhelm_decide_run_tool_approval";
export const MCP_INSPECT_RUN_TOOL_NAME = "crewhelm_inspect_run";
export const MCP_LIST_RUN_TOOL_APPROVALS_TOOL_NAME = "crewhelm_list_run_tool_approvals";
export const MCP_START_RUN_TOOL_NAME = "crewhelm_start_run";

export function registerRunTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_INSPECT_RUN_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Inspect the bounded status and completed text output of one authenticated-owner Crewhelm Agent run.",
      inputSchema: inspectRunInputSchema,
      title: "Inspect Crewhelm run",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.inspectRun(authority, input),
        inspectRunResultSchema,
      ),
  );

  server.registerTool(
    MCP_LIST_RUN_TOOL_APPROVALS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "List sensitive tool actions waiting for this authenticated owner.",
      inputSchema: listRunToolApprovalsInputSchema,
      title: "List run tool approvals",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.listRunToolApprovals(authority, input),
        listRunToolApprovalsResultSchema,
      ),
  );

  server.registerTool(
    MCP_DECIDE_RUN_TOOL_APPROVAL_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Approve or reject one exact sensitive tool action waiting in an authenticated-owner run.",
      inputSchema: decideRunToolApprovalInputSchema,
      title: "Decide run tool approval",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.decideRunToolApproval(authority, input),
        decideRunToolApprovalResultSchema,
      ),
  );

  server.registerTool(
    MCP_START_RUN_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Durably start one bounded turn for an exact authenticated-owner Crewhelm Agent revision.",
      inputSchema: startRunInputSchema,
      title: "Start Crewhelm run",
    },
    async (input) =>
      controlPlaneToolResult(() => controlPlane.startRun(authority, input), startRunResultSchema),
  );
}
