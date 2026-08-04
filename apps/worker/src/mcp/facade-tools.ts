import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { FACADE_TOOL_DEFINITIONS } from "./facade-definitions.js";
import type { PrivateToolCatalog } from "./private-tool-catalog.js";
import { registerProgressiveFacadeTools } from "./facade-runtime.js";

export {
  MCP_CHANGE_AGENTS_TOOL_NAME,
  MCP_CHANGE_AUTOMATIONS_TOOL_NAME,
  MCP_CHANGE_CONNECTIONS_TOOL_NAME,
  MCP_CHANGE_CONTEXT_TOOL_NAME,
  MCP_CHANGE_MODELS_TOOL_NAME,
  MCP_CHANGE_RECIPES_TOOL_NAME,
  MCP_CHANGE_WORK_TOOL_NAME,
  MCP_INSPECT_AGENTS_TOOL_NAME,
  MCP_INSPECT_AUTOMATIONS_TOOL_NAME,
  MCP_INSPECT_CONNECTIONS_TOOL_NAME,
  MCP_INSPECT_CONTEXT_TOOL_NAME,
  MCP_INSPECT_MODELS_TOOL_NAME,
  MCP_INSPECT_RECOVERY_TOOL_NAME,
  MCP_INSPECT_RECIPES_TOOL_NAME,
  MCP_INSPECT_WORK_TOOL_NAME,
  MCP_PUBLISH_RECIPE_TOOL_NAME,
  MCP_RECOVER_TOOL_NAME,
} from "./facade-definitions.js";

export function registerFacadeTools(server: McpServer, catalog: PrivateToolCatalog): void {
  registerProgressiveFacadeTools(server, catalog, FACADE_TOOL_DEFINITIONS);
}

export const MCP_FACADE_TOOL_COUNT = FACADE_TOOL_DEFINITIONS.length + 1;
