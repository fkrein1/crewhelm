import {
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

import type { WorkerEnv } from "../env.js";
import { readBoundedPostRequest } from "../http/request-body.js";
import { recordIntegrationProviderResponse } from "../observability/integrations.js";
import { registerAgentTools } from "./agent-tools.js";
import { registerConnectionTools } from "./connection-tools.js";
import { registerConnectionAttachmentTools } from "./connection-attachment-tools.js";
import {
  MCP_CONFIGURE_TOOL_NAME,
  MCP_GET_CONFIGURATION_TOOL_NAME,
  registerConfigurationTools,
} from "./configuration-tools.js";
import type { McpEnvironment } from "./context.js";
import { registerIntegrationTools } from "./integration-tools.js";
import { registerRunTools } from "./run-tools.js";
import { registerScheduleTools } from "./schedule-tools.js";
import { registerRecoveryTools } from "./recovery-tools.js";
import { controlPlaneToolResult } from "./tool-result.js";

export { MCP_CONFIGURE_AGENT_CONNECTION_TOOL_NAME } from "./connection-attachment-tools.js";
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
export {
  MCP_CONFIGURE_AGENT_SCHEDULE_TOOL_NAME,
  MCP_GET_AGENT_SCHEDULE_TOOL_NAME,
} from "./schedule-tools.js";
export {
  MCP_BATCH_DISABLE_AGENTS_TOOL_NAME,
  MCP_LIST_UNRESOLVED_TOOL_EFFECTS_TOOL_NAME,
  MCP_RECONCILE_TOOL_EXECUTION_TOOL_NAME,
  MCP_REVOKE_AUTHORITY_TOOL_NAME,
} from "./recovery-tools.js";

const MAX_MCP_BODY_BYTES = 64 * 1024;
export const MCP_SERIALIZED_SCHEMA_SIZE_BUDGET_BYTES = 64 * 1_024;
export const MCP_TOOL_COUNT_BUDGET = 30;
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
  const server = new McpServer(MCP_SERVER_INFO);
  const controlPlane = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
  const context = { authority, controlPlane };

  registerConfigurationTools(server, context);
  registerAgentTools(server, context);
  registerRunTools(server, context);
  registerScheduleTools(server, context);
  registerRecoveryTools(server, context);
  registerConnectionTools(server, context, {
    connectionLinks: createComposioConnectionLinks({
      apiKey: env.COMPOSIO_API_KEY,
      onResponse: recordIntegrationProviderResponse,
      signal,
    }),
    publicOrigin: env.PUBLIC_ORIGIN,
    signingSecret: env.BETTER_AUTH_SECRET,
  });
  registerConnectionAttachmentTools(server, context, {
    catalog: createComposioCatalog({
      apiKey: env.COMPOSIO_API_KEY,
      signal,
    }),
    runtime: createComposioRuntime({
      apiKey: env.COMPOSIO_API_KEY,
    }),
    signal,
  });
  registerIntegrationTools(server, context, {
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
        "Return a cheap owner-local fleet dashboard with active usage, inbox and unresolved-effect counts, and configured capacity.",
      inputSchema: z.strictObject({}),
      title: "Crewhelm status",
    },
    async () =>
      controlPlaneToolResult(() => controlPlane.status(authority), controlPlaneStatusResultSchema),
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

export const mcpApiHandler = {
  fetch(request, env, context) {
    const props = (context as ExecutionContext & { props?: unknown }).props;

    return handleAuthenticatedMcpRequest(request, env, props);
  },
} satisfies ExportedHandler<WorkerEnv>;
