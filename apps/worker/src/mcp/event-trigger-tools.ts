import {
  agentEventTriggersResultSchema,
  agentEventTriggersToolInputSchema,
} from "@crewhelm/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { optionalControlPlaneToolResult } from "./tool-result.js";

export const MCP_AGENT_EVENT_TRIGGERS_TOOL_NAME = "crewhelm_agent_event_triggers";

export function registerEventTriggerTools(server: McpServer, context: McpToolContext): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_AGENT_EVENT_TRIGGERS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description:
        "Create and manage Event Triggers that start a fresh Agent Run when a matching connected-app event occurs. Call sources with an exact Connection first; Crewhelm owns delivery and recovery.",
      inputSchema: agentEventTriggersToolInputSchema,
      title: "Manage Crewhelm Agent Event Triggers",
    },
    async (input) => {
      return optionalControlPlaneToolResult(
        controlPlane.agentEventTriggers === undefined
          ? undefined
          : async () =>
              controlPlane.agentEventTriggers?.(
                authority,
                input.eventTrigger === undefined
                  ? input
                  : {
                      ...input,
                      eventTrigger: {
                        instruction: input.eventTrigger.instruction,
                        name: input.eventTrigger.name,
                        ...(input.eventTrigger.outputContract === undefined
                          ? {}
                          : { outputContract: input.eventTrigger.outputContract }),
                        source: {
                          configuration: input.eventTrigger.filters,
                          connectionId: input.eventTrigger.connectionId,
                          delivery: input.eventTrigger.delivery,
                          integrationSlug: input.eventTrigger.integrationSlug,
                          kind: "connection_event",
                          sourceSlug: input.eventTrigger.eventSlug,
                          sourceVersion: input.eventTrigger.eventVersion,
                        },
                      },
                    },
              ),
        agentEventTriggersResultSchema,
      );
    },
  );
}
