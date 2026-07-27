import {
  controlPlaneStatusResultSchema,
  ownerAuthoritySchema,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod";

import type { WorkerEnv } from "./env.js";
import { readBoundedPostRequest } from "./request-body.js";

interface McpEnvironment {
  OWNER_CONTROL_PLANE: {
    getByName(ownerKey: string): {
      status(authorityInput: unknown): Promise<unknown>;
    };
  };
}

const MAX_MCP_BODY_BYTES = 64 * 1024;
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
const CONTROL_PLANE_UNAVAILABLE_BODY = JSON.stringify({
  error: {
    code: "control_plane_unavailable",
    message: "Control-plane request denied.",
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

function createMcpServer(env: McpEnvironment, authority: OwnerAuthority): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);

  server.registerTool(
    MCP_STATUS_TOOL_NAME,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Return the authenticated owner's Crewhelm control-plane status.",
      inputSchema: z.strictObject({}),
      title: "Crewhelm status",
    },
    async () => {
      let result: z.infer<typeof controlPlaneStatusResultSchema>;

      try {
        const rawResult = await env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey).status(
          authority,
        );
        result = controlPlaneStatusResultSchema.parse(rawResult);
      } catch {
        return {
          content: [
            {
              text: CONTROL_PLANE_UNAVAILABLE_BODY,
              type: "text" as const,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            text: JSON.stringify(result),
            type: "text" as const,
          },
        ],
        isError: !result.ok,
      };
    },
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

  const server = createMcpServer(env, authority);
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
