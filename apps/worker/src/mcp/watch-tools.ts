import { agentWatchesResultSchema, agentWatchesToolInputSchema } from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { optionalControlPlaneToolResult } from "./tool-result.js";

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
        "Create and manage Watches that start a fresh Agent Run on a schedule or connected-app event. Call sources first; Crewhelm owns delivery and recovery.",
      inputSchema: agentWatchesToolInputSchema,
      title: "Manage Crewhelm Agent Watches",
    },
    async (input) => {
      return optionalControlPlaneToolResult(
        controlPlane.agentWatches === undefined
          ? undefined
          : async () =>
              controlPlane.agentWatches?.(
                authority,
                input.watch === undefined
                  ? input
                  : "everyMinutes" in input.watch
                    ? {
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
                      }
                    : {
                        ...input,
                        watch: {
                          instruction: input.watch.instruction,
                          name: input.watch.name,
                          ...(input.watch.outputContract === undefined
                            ? {}
                            : { outputContract: input.watch.outputContract }),
                          source: {
                            configuration: input.watch.filters,
                            connectionId: input.watch.connectionId,
                            delivery: input.watch.delivery,
                            integrationSlug: input.watch.integrationSlug,
                            kind: "connection_event",
                            sourceSlug: input.watch.eventSlug,
                            sourceVersion: input.watch.eventVersion,
                          },
                        },
                      },
              ),
        agentWatchesResultSchema,
      );
    },
  );
}
