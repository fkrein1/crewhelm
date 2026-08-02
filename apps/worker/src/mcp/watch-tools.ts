import { agentWatchesResultSchema, agentWatchesToolInputSchema } from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_AGENT_WATCHES_TOOL_NAME = "crewhelm_agent_watches";

export function registerWatchTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_AGENT_WATCHES_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Tell an Agent when to check something, then inspect, pause, resume, update, or delete that Watch. Start with sources to see what Crewhelm can notice. Scheduled checks may find nothing and require no webhook, bearer token, API workflow, or external setup.",
      inputSchema: agentWatchesToolInputSchema,
      title: "Manage Crewhelm Agent Watches",
    },
    async (input) =>
      controlPlaneToolResult(
        () =>
          controlPlane.agentWatches?.(
            authority,
            input.watch === undefined
              ? input
              : {
                  ...input,
                  watch: {
                    instruction: input.watch.instruction,
                    name: input.watch.name,
                    ...(input.watch.outputContract === undefined
                      ? {}
                      : { outputContract: input.watch.outputContract }),
                    source: {
                      kind: "scheduled_check",
                      trigger: {
                        intervalSeconds: input.watch.everyMinutes * 60,
                        type: "interval",
                      },
                    },
                  },
                },
          ) ?? Promise.reject(new Error("Watch control plane unavailable.")),
        agentWatchesResultSchema,
      ),
  );
}
