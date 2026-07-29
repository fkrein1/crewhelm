import {
  configureAgentScheduleInputSchema,
  configureAgentScheduleResultSchema,
  getAgentScheduleInputSchema,
  getAgentScheduleResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME = "crewhelm_configure_agent_schedule";
export const MCP_GET_AGENT_SCHEDULE_TOOL_NAME = "crewhelm_get_agent_schedule";

export function registerScheduleTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Configure or pause one recurring schedule bound to an exact Crewhelm Agent revision.",
      inputSchema: configureAgentScheduleInputSchema,
      title: "Configure Crewhelm Agent schedule",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.configureAgentSchedule(authority, input),
        configureAgentScheduleResultSchema,
      ),
  );

  server.registerTool(
    MCP_GET_AGENT_SCHEDULE_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Inspect one Agent schedule, its next dispatch time, and its most recent scheduled run.",
      inputSchema: getAgentScheduleInputSchema,
      title: "Get Crewhelm Agent schedule",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.getAgentSchedule(authority, input),
        getAgentScheduleResultSchema,
      ),
  );
}
