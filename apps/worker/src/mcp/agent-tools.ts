import {
  createAgentInputSchema,
  createAgentResultSchema,
  getAgentInputSchema,
  getAgentRevisionInputSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsInputSchema,
  listAgentRevisionsResultSchema,
  listAgentsInputSchema,
  listAgentsResultSchema,
  updateAgentInputSchema,
  updateAgentResultSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_CREATE_AGENT_TOOL_NAME = "crewhelm_create_agent";
export const MCP_GET_AGENT_TOOL_NAME = "crewhelm_get_agent";
export const MCP_GET_AGENT_REVISION_TOOL_NAME = "crewhelm_get_agent_revision";
export const MCP_LIST_AGENT_REVISIONS_TOOL_NAME = "crewhelm_list_agent_revisions";
export const MCP_LIST_AGENTS_TOOL_NAME = "crewhelm_list_agents";
export const MCP_UPDATE_AGENT_TOOL_NAME = "crewhelm_update_agent";

export function registerAgentTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_CREATE_AGENT_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Create an owner-scoped Crewhelm Agent with an immutable initial revision and no capability grants.",
      inputSchema: createAgentInputSchema,
      title: "Create Crewhelm agent",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.createAgent(authority, input),
        createAgentResultSchema,
      ),
  );

  server.registerTool(
    MCP_GET_AGENT_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Return the current immutable definition of one authenticated-owner Crewhelm Agent.",
      inputSchema: getAgentInputSchema,
      title: "Get Crewhelm agent",
    },
    async (input) =>
      controlPlaneToolResult(() => controlPlane.getAgent(authority, input), getAgentResultSchema),
  );

  server.registerTool(
    MCP_GET_AGENT_REVISION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Return one exact immutable historical definition of an authenticated-owner Crewhelm Agent.",
      inputSchema: getAgentRevisionInputSchema,
      title: "Get Crewhelm agent revision",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.getAgentRevision(authority, input),
        getAgentRevisionResultSchema,
      ),
  );

  server.registerTool(
    MCP_LIST_AGENTS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "List bounded summaries of the authenticated owner's Crewhelm Agents in stable opaque-ID order.",
      inputSchema: listAgentsInputSchema,
      title: "List Crewhelm agents",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.listAgents(authority, input),
        listAgentsResultSchema,
      ),
  );

  server.registerTool(
    MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "List bounded immutable revision summaries for one authenticated-owner Crewhelm Agent, newest first.",
      inputSchema: listAgentRevisionsInputSchema,
      title: "List Crewhelm agent revisions",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.listAgentRevisions(authority, input),
        listAgentRevisionsResultSchema,
      ),
  );

  server.registerTool(
    MCP_UPDATE_AGENT_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Replace an owner-scoped Crewhelm Agent definition by creating a new immutable revision.",
      inputSchema: updateAgentInputSchema,
      title: "Update Crewhelm agent",
    },
    async (input) =>
      controlPlaneToolResult(
        () => controlPlane.updateAgent(authority, input),
        updateAgentResultSchema,
      ),
  );
}
