import {
  agentIdSchema,
  capabilityGrantIdSchema,
  changeAuthorityResultSchema,
  connectionIdSchema,
  reconcileToolExecutionInputSchema,
  reconcileToolExecutionResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_REVOKE_AUTHORITY_TOOL_NAME = "crewhelm_revoke_authority";
export const MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME = "crewhelm_reconcile_tool_execution";
const changeAuthorityToolInputShape = {
  agentId: agentIdSchema
    .optional()
    .describe('Required when target is "agent"; omit for other targets.'),
  connectionId: connectionIdSchema
    .optional()
    .describe('Required when target is "connection"; omit for other targets.'),
  grantId: capabilityGrantIdSchema
    .optional()
    .describe('Required when target is "capability"; omit for other targets.'),
  target: z
    .enum(["agent", "connection", "capability"])
    .describe("Authority type to revoke. Supply only its corresponding ID field."),
};

export function registerRecoveryTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_REVOKE_AUTHORITY_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Immediately disable one Crewhelm Agent or permanently revoke one connection or capability grant. Revoked connections must be reconnected before they can be used again.",
      inputSchema: changeAuthorityToolInputShape,
      title: "Disable or revoke Crewhelm authority",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.changeAuthority(authority, input),
        changeAuthorityResultSchema,
      ),
  );

  server.registerTool(
    MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Resolve one unknown provider effect only after independently verifying whether it was applied. Only a not-applied resolution permits an equivalent mutating effect to be retried.",
      inputSchema: reconcileToolExecutionInputSchema,
      title: "Reconcile unknown tool execution",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.reconcileToolExecution(authority, input),
        reconcileToolExecutionResultSchema,
      ),
  );
}
