import {
  AUTONOMY_WRITE_SCOPE,
  INTEGRATIONS_READ_SCOPE,
  configureAgentConnectionInputSchema,
  configureAgentConnectionResultSchema,
  isCredentialBearingComposioTool,
  lookupAgentConnectionConfigurationResultSchema,
  resolvedConnectionForAttachmentSchema,
} from "@crewhelm/contracts";
import { type ComposioCatalog, type ComposioRuntime } from "@crewhelm/composio";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context.js";
import { controlPlaneToolResult } from "./tool-result.js";

export const MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME = "crewhelm_configure_agent_connection";

function denied(code: "connection_unavailable" | "insufficient_scope" | "invalid_request") {
  return {
    error: {
      code,
      message: "Connection attachment request denied." as const,
    },
    ok: false as const,
  };
}

export function registerConnectionAttachmentTools(
  server: McpServer,
  context: McpToolContext,
  adapters: { catalog: ComposioCatalog; runtime: ComposioRuntime; signal: AbortSignal },
): void {
  const { authority, controlPlane } = context;

  server.registerTool(
    MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false,
      },
      description:
        "Replace the Composio tools exposed from one authorized connection on an Agent. Crewhelm snapshots public, version-pinned tool definitions; Composio remains the authorization source.",
      inputSchema: configureAgentConnectionInputSchema,
      title: "Configure Agent connection tools",
    },
    async (input) =>
      controlPlaneToolResult(async () => {
        if (!authority.scopes.includes(INTEGRATIONS_READ_SCOPE)) {
          return denied("insufficient_scope");
        }

        if (
          input.tools.some(({ authorization }) => authorization === "standing") &&
          !authority.scopes.includes(AUTONOMY_WRITE_SCOPE)
        ) {
          return denied("insufficient_scope");
        }

        const lookup = lookupAgentConnectionConfigurationResultSchema.safeParse(
          await controlPlane.lookupAgentConnectionConfiguration(authority, input),
        );

        if (!lookup.success || !lookup.data.ok) {
          return lookup.success ? lookup.data : denied("invalid_request");
        }

        if (lookup.data.replay !== null) {
          return lookup.data.replay;
        }

        if (input.tools.length === 0) {
          return controlPlane.configureAgentConnection(authority, {
            ...input,
            providerConnectionId: null,
            tools: [],
            verifiedToolkitSlug: null,
          });
        }

        const resolved = resolvedConnectionForAttachmentSchema.safeParse(
          await controlPlane.resolveConnectionForAttachment(authority, {
            agentId: input.agentId,
            connectionId: input.connectionId,
            expectedRevision: input.expectedRevision,
          }),
        );

        if (!resolved.success || !resolved.data.ok) {
          return resolved.success ? resolved.data : denied("invalid_request");
        }

        const verified = await adapters.runtime.verifyConnection(
          resolved.data.providerConnectionId,
          adapters.signal,
        );

        if (!verified.ok) {
          return denied("connection_unavailable");
        }

        const inspected = await Promise.all(
          input.tools.map(({ slug, version }) => adapters.catalog.inspectTool({ slug, version })),
        );
        const configuredTools = [];

        for (const [index, result] of inspected.entries()) {
          const requested = input.tools[index];

          if (
            requested === undefined ||
            !result.ok ||
            result.tool.integration.slug !== verified.toolkitSlug ||
            isCredentialBearingComposioTool(result.tool)
          ) {
            return denied("invalid_request");
          }

          configuredTools.push({
            ...result.tool,
            authorization: requested.authorization,
          });
        }

        return controlPlane.configureAgentConnection(authority, {
          ...input,
          providerConnectionId: resolved.data.providerConnectionId,
          tools: configuredTools,
          verifiedToolkitSlug: verified.toolkitSlug,
        });
      }, configureAgentConnectionResultSchema),
  );
}
