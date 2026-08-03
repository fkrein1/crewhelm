import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

type PrivateToolHandler = (
  input: unknown,
  extra: unknown,
) => CallToolResult | Promise<CallToolResult>;

interface PrivateToolConfiguration {
  inputSchema?: z.ZodRawShape | z.ZodType;
}

interface PrivateToolRegistration {
  configuration: PrivateToolConfiguration;
  handler: PrivateToolHandler;
}

export interface PrivateToolCatalog {
  dispatch(name: string, input: unknown, extra: unknown): Promise<CallToolResult>;
  inputSchema(name: string): z.ZodType;
}

/**
 * Captures the existing exact control-plane operations without exposing them in tools/list.
 * The intent facade remains the only public MCP registration surface.
 */
export function createPrivateToolCatalog(
  register: (server: McpServer) => void,
): PrivateToolCatalog {
  const tools = new Map<string, PrivateToolRegistration>();
  const captureTool = (
    name: string,
    configuration: PrivateToolConfiguration,
    handler: PrivateToolHandler,
  ) => {
    if (tools.has(name)) {
      throw new Error(`Duplicate private MCP operation: ${name}`);
    }

    tools.set(name, { configuration, handler });
  };
  const registrar = new Proxy(new McpServer({ name: "crewhelm-private", version: "0.1.0" }), {
    get(_target, property) {
      return property === "registerTool" ? captureTool : undefined;
    },
  });

  register(registrar);

  function exact(name: string): PrivateToolRegistration {
    const tool = tools.get(name);

    if (tool === undefined) {
      throw new Error(`Unknown private MCP operation: ${name}`);
    }

    return tool;
  }

  function normalizedInputSchema(name: string): z.ZodType {
    const schema = exact(name).configuration.inputSchema;

    if (schema === undefined) {
      throw new Error(`Private MCP operation has no input schema: ${name}`);
    }

    return schema instanceof z.ZodType ? schema : z.strictObject(schema);
  }

  return {
    async dispatch(name, input, extra) {
      const tool = exact(name);
      const parsed = await normalizedInputSchema(name).safeParseAsync(input);

      if (!parsed.success) {
        return {
          content: [
            {
              text: "Invalid Crewhelm operation input.",
              type: "text",
            },
          ],
          isError: true,
        };
      }

      return tool.handler(parsed.data, extra);
    },
    inputSchema(name) {
      return normalizedInputSchema(name);
    },
  };
}
