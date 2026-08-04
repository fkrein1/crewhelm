import {
  controlPlaneStatusInputSchema,
  controlPlaneStatusResultSchema,
  ownerAuthoritySchema,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import {
  createComposioAuthConfigs,
  createComposioCatalog,
  createComposioConnectionLinks,
  createComposioRuntime,
} from "@crewhelm/composio";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod";

import { availableAgentCapabilityPrerequisites } from "../agent-capabilities/registry.js";
import { readBoundedPostRequest } from "../http/request-body.js";
import { recordIntegrationProviderResponse } from "../observability/integrations.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerAuthoringDraftTools } from "./authoring-draft-tools.js";
import { MCP_BRIEFS_TOOL_NAME, registerBriefTools } from "./brief-tools.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerConnectionAttachmentTools } from "./connection-attachment-tools.js";
import {
  MCP_REMOTE_MCP_CONNECTION_TOOL_NAME,
  registerRemoteMcpConnectionTools,
} from "./remote-mcp-connection-tools.js";
import {
  MCP_CONFIGURE_TOOL_NAME,
  MCP_GET_CONFIGURATION_TOOL_NAME,
  registerConfigurationTools,
} from "./configuration-tools.js";
import type { McpEnvironment } from "./context.js";
import {
  MCP_SERVER_INSTRUCTIONS,
  mcpControlPlaneStatusResultSchema,
  statusGuidance,
} from "./guidance.js";
import { registerIntegrationTools } from "./integration-tools.js";
import { registerRunTools } from "./run-tools.js";
import {
  MCP_AGENT_SESSIONS_TOOL_NAME,
  MCP_DELETE_AGENT_SESSION_TOOL_NAME,
  registerSessionTools,
} from "./session-tools.js";
import { registerScheduleTools } from "./schedule-tools.js";
import { registerRecoveryTools } from "./recovery-tools.js";
import { MCP_RECIPES_TOOL_NAME, registerRecipeTools } from "./recipe-tools.js";
import {
  MCP_RECIPE_PUBLICATIONS_TOOL_NAME,
  registerRecipePublicationTools,
} from "./recipe-publication-tools.js";
import { controlPlaneToolResult } from "./tool-result.js";
import { MCP_AGENT_WORKFLOWS_TOOL_NAME, registerWorkflowTools } from "./workflow-tools.js";
import {
  MCP_AGENT_EVENT_TRIGGERS_TOOL_NAME,
  registerEventTriggerTools,
} from "./event-trigger-tools.js";
import {
  MCP_CHANGE_AGENTS_TOOL_NAME,
  MCP_CHANGE_AUTOMATIONS_TOOL_NAME,
  MCP_CHANGE_CONNECTIONS_TOOL_NAME,
  MCP_CHANGE_CONTEXT_TOOL_NAME,
  MCP_CHANGE_RECIPES_TOOL_NAME,
  MCP_CHANGE_WORK_TOOL_NAME,
  MCP_FACADE_TOOL_COUNT,
  MCP_INSPECT_AGENTS_TOOL_NAME,
  MCP_INSPECT_AUTOMATIONS_TOOL_NAME,
  MCP_INSPECT_CONNECTIONS_TOOL_NAME,
  MCP_INSPECT_CONTEXT_TOOL_NAME,
  MCP_INSPECT_RECOVERY_TOOL_NAME,
  MCP_INSPECT_RECIPES_TOOL_NAME,
  MCP_INSPECT_WORK_TOOL_NAME,
  MCP_PUBLISH_RECIPE_TOOL_NAME,
  MCP_RECOVER_TOOL_NAME,
  registerFacadeTools,
} from "./facade-tools.js";
import { createPrivateToolCatalog } from "./private-tool-catalog.js";

export {
  MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME,
  MCP_CONFIGURE_AGENT_REMOTE_MCP_TOOL_NAME,
} from "./connection-attachment-tools.js";
export { MCP_REMOTE_MCP_CONNECTION_TOOL_NAME };
export { MCP_BRIEFS_TOOL_NAME };
export { MCP_CONFIGURE_TOOL_NAME, MCP_GET_CONFIGURATION_TOOL_NAME };
export {
  MCP_CREATE_AGENT_TOOL_NAME,
  MCP_GET_AGENT_REVISION_TOOL_NAME,
  MCP_GET_AGENT_TOOL_NAME,
  MCP_LIST_AGENT_REVISIONS_TOOL_NAME,
  MCP_LIST_AGENTS_TOOL_NAME,
  MCP_UPDATE_AGENT_TOOL_NAME,
} from "./agent-tools.js";
export {
  MCP_CREATE_CONNECTION_LINK_TOOL_NAME,
  MCP_LIST_CONNECTIONS_TOOL_NAME,
} from "./connection-tools.js";
export {
  MCP_ENABLE_INTEGRATION_TOOL_NAME,
  MCP_INSPECT_INTEGRATION_TOOL_NAME,
  MCP_LIST_INTEGRATION_AUTH_CONFIGS_TOOL_NAME,
  MCP_SEARCH_INTEGRATIONS_TOOL_NAME,
  MCP_SEARCH_INTEGRATION_TOOLS_TOOL_NAME,
} from "./integration-tools.js";
export {
  MCP_AGENT_INBOX_TOOL_NAME,
  MCP_CANCEL_RUN_TOOL_NAME,
  MCP_DECIDE_RUN_TOOL_APPROVAL_TOOL_NAME,
  MCP_INSPECT_RUN_TOOL_NAME,
  MCP_LIST_AGENT_RUNS_TOOL_NAME,
  MCP_LIST_RUN_TOOL_APPROVALS_TOOL_NAME,
  MCP_START_RUN_TOOL_NAME,
} from "./run-tools.js";
export { MCP_AGENT_SESSIONS_TOOL_NAME, MCP_DELETE_AGENT_SESSION_TOOL_NAME };
export { MCP_AGENT_WORKFLOWS_TOOL_NAME };
export { MCP_AGENT_EVENT_TRIGGERS_TOOL_NAME };
export {
  MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME,
  MCP_GET_AGENT_SCHEDULE_TOOL_NAME,
  MCP_LIST_AGENT_SCHEDULES_TOOL_NAME,
} from "./schedule-tools.js";
export {
  MCP_BATCH_DISABLE_AGENTS_TOOL_NAME,
  MCP_LIST_UNRESOLVED_TOOL_EFFECTS_TOOL_NAME,
  MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME,
  MCP_REVOKE_AUTHORITY_TOOL_NAME,
} from "./recovery-tools.js";
export { MCP_RECIPES_TOOL_NAME };
export { MCP_RECIPE_PUBLICATIONS_TOOL_NAME };
export {
  MCP_CHANGE_AGENTS_TOOL_NAME,
  MCP_CHANGE_AUTOMATIONS_TOOL_NAME,
  MCP_CHANGE_CONNECTIONS_TOOL_NAME,
  MCP_CHANGE_CONTEXT_TOOL_NAME,
  MCP_CHANGE_RECIPES_TOOL_NAME,
  MCP_CHANGE_WORK_TOOL_NAME,
  MCP_INSPECT_AGENTS_TOOL_NAME,
  MCP_INSPECT_AUTOMATIONS_TOOL_NAME,
  MCP_INSPECT_CONNECTIONS_TOOL_NAME,
  MCP_INSPECT_CONTEXT_TOOL_NAME,
  MCP_INSPECT_RECOVERY_TOOL_NAME,
  MCP_INSPECT_RECIPES_TOOL_NAME,
  MCP_INSPECT_WORK_TOOL_NAME,
  MCP_PUBLISH_RECIPE_TOOL_NAME,
  MCP_RECOVER_TOOL_NAME,
};

const MAX_MCP_BODY_BYTES = 512 * 1024;
export const MCP_MODEL_VISIBLE_CATALOG_SIZE_BUDGET_BYTES = 12 * 1_024;
export const MCP_SERIALIZED_SCHEMA_SIZE_BUDGET_BYTES = 6 * 1_024;
export const MCP_MODEL_VISIBLE_TOOL_SIZE_BUDGET_BYTES = 1_024;
export const MCP_PROGRESSIVE_OPERATION_SCHEMA_SIZE_BUDGET_BYTES = 8 * 1_024;
export const MCP_TOOL_COUNT_BUDGET = MCP_FACADE_TOOL_COUNT;
const MCP_SERVER_INFO = {
  name: "crewhelm",
  version: "0.1.0",
} as const;
const INVALID_AUTH_BODY = JSON.stringify({
  error: {
    code: "invalid_authority",
    message: "MCP request denied.",
  },
});
const REQUEST_TOO_LARGE_BODY = JSON.stringify({
  error: {
    code: "request_too_large",
    message: "MCP request denied.",
  },
});
const INVALID_ORIGIN_BODY = JSON.stringify({
  error: {
    code: "invalid_origin",
    message: "MCP request denied.",
  },
});
const METHOD_NOT_ALLOWED_BODY = JSON.stringify({
  error: {
    code: "method_not_allowed",
    message: "MCP request denied.",
  },
});
const NOT_FOUND_BODY = JSON.stringify({
  error: {
    code: "not_found",
    message: "Not found.",
  },
});

export const MCP_STATUS_TOOL_NAME = "crewhelm_status";

export const mcpAuthPropsSchema = z.strictObject({
  authority: ownerAuthoritySchema,
});

function fixedJsonResponse(body: string, status: number): Response {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    status,
  });
}

function parseAuthority(props: unknown): OwnerAuthority | null {
  const result = mcpAuthPropsSchema.safeParse(props);

  return result.success ? result.data.authority : null;
}

function hasValidOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  if (origin === null) {
    return true;
  }

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function createMcpServer(
  env: McpEnvironment,
  authority: OwnerAuthority,
  signal: AbortSignal,
): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: MCP_SERVER_INSTRUCTIONS });
  const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
  const context = {
    authority,
    availableAgentCapabilityPrerequisites: availableAgentCapabilityPrerequisites(
      env.AI_GATEWAY_ID,
      env.CODE_SANDBOX !== undefined,
      env.BRAVE_SEARCH_API_KEY !== undefined && env.BRAVE_SEARCH_API_KEY.trim().length > 0,
    ),
    controlPlane,
  };

  const privateTools = createPrivateToolCatalog((privateServer) => {
    registerConfigurationTools(privateServer, context);
    registerAgentTools(privateServer, context);
    registerAuthoringDraftTools(privateServer, context);
    registerBriefTools(privateServer, context);
    registerRunTools(privateServer, context);
    registerSessionTools(privateServer, context);
    registerWorkflowTools(privateServer, context);
    registerEventTriggerTools(privateServer, context);
    registerScheduleTools(privateServer, context);
    registerRecoveryTools(privateServer, context);
    registerRecipeTools(privateServer, context);
    registerRecipePublicationTools(privateServer, context);
    registerConnectionTools(privateServer, context, {
      connectionLinks: createComposioConnectionLinks({
        apiKey: env.COMPOSIO_API_KEY,
        onResponse: recordIntegrationProviderResponse,
        signal,
      }),
      publicOrigin: env.PUBLIC_ORIGIN,
      runtime: createComposioRuntime({
        apiKey: env.COMPOSIO_API_KEY,
      }),
      signingSecret: env.BETTER_AUTH_SECRET,
      signal,
    });
    registerRemoteMcpConnectionTools(privateServer, context, {
      publicOrigin: env.PUBLIC_ORIGIN,
      signingSecret: env.BETTER_AUTH_SECRET,
      signal,
    });
    registerConnectionAttachmentTools(privateServer, context, {
      catalog: createComposioCatalog({
        apiKey: env.COMPOSIO_API_KEY,
        signal,
      }),
      runtime: createComposioRuntime({
        apiKey: env.COMPOSIO_API_KEY,
      }),
      signal,
    });
    registerIntegrationTools(privateServer, context, {
      authConfigs: createComposioAuthConfigs({
        apiKey: env.COMPOSIO_API_KEY,
        onResponse: recordIntegrationProviderResponse,
        signal,
      }),
      catalog: createComposioCatalog({
        apiKey: env.COMPOSIO_API_KEY,
        signal,
      }),
    });
  });

  registerFacadeTools(server, privateTools);

  server.registerTool(
    MCP_STATUS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description:
        "Start here for an owner-local dashboard, diagnostics, and at most three advisory next steps.",
      inputSchema: controlPlaneStatusInputSchema,
      title: "Crewhelm status",
    },
    async (input) =>
      controlPlaneToolResult(async () => {
        const response = await controlPlane.status(authority, input);
        const result = controlPlaneStatusResultSchema.safeParse(response);

        if (!result.success) {
          return response;
        }

        return result.data.ok
          ? { ...result.data, guidance: statusGuidance(result.data.status) }
          : result.data;
      }, mcpControlPlaneStatusResultSchema),
  );

  return server;
}

export async function handleAuthenticatedMcpRequest(
  request: Request,
  env: McpEnvironment,
  props: unknown,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/mcp") {
    return fixedJsonResponse(NOT_FOUND_BODY, 404);
  }

  if (request.method !== "POST") {
    const response = fixedJsonResponse(METHOD_NOT_ALLOWED_BODY, 405);
    response.headers.set("allow", "POST");
    return response;
  }

  const authority = parseAuthority(props);

  if (authority === null) {
    return fixedJsonResponse(INVALID_AUTH_BODY, 401);
  }

  if (!hasValidOrigin(request)) {
    return fixedJsonResponse(INVALID_ORIGIN_BODY, 403);
  }

  const boundedRequest = await readBoundedPostRequest(request, MAX_MCP_BODY_BYTES);

  if (boundedRequest === null) {
    return fixedJsonResponse(REQUEST_TOO_LARGE_BODY, 413);
  }

  const server = createMcpServer(env, authority, boundedRequest.signal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    return await transport.handleRequest(boundedRequest);
  } finally {
    await server.close();
  }
}

export const mcpApiHandler: ExportedHandler<McpEnvironment> = {
  fetch(request, env, context): Promise<Response> {
    const props = (context as ExecutionContext & { props?: unknown }).props;

    return handleAuthenticatedMcpRequest(request, env, props);
  },
};
