import {
  configureAgentScheduleInputSchema,
  configureAgentScheduleResultSchema,
  getAgentScheduleInputSchema,
  getAgentScheduleResultSchema,
  listAgentSchedulesInputSchema,
  listAgentSchedulesResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME = "crewhelm_configure_agent_schedule";
export const MCP_GET_AGENT_SCHEDULE_TOOL_NAME = "crewhelm_get_agent_schedule";
export const MCP_LIST_AGENT_SCHEDULES_TOOL_NAME = "crewhelm_list_agent_schedules";

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
        "Create, update, or independently pause a named recurring responsibility bound to an exact Crewhelm Agent revision. Optionally attach exact Brief revisions for context on every occurrence. Use scheduleId null to create another schedule, list schedules before exact updates, and update a paused schedule to reuse one of the eight bounded slots.",
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
    MCP_LIST_AGENT_SCHEDULES_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "List every bounded recurring responsibility for one Agent, including exact IDs, trigger configuration, status, and next dispatch time.",
      inputSchema: listAgentSchedulesInputSchema,
      title: "List Crewhelm Agent schedules",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.listAgentSchedules(authority, input),
        listAgentSchedulesResultSchema,
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
        "Inspect one exact Agent schedule, its next dispatch time, and its most recent scheduled run. Omit scheduleId only when the Agent has at most one schedule.",
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
