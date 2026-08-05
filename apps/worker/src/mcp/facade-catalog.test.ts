import { env } from "cloudflare:test";
import { OWNER_READ_SCOPE, ownerAuthoritySchema } from "@crewhelm/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";

import { deriveOwnerKey } from "../owner/identity.js";
import { FACADE_TOOL_DEFINITIONS } from "./facade-definitions.js";
import { facadeOperationDescription } from "./facade-operation-descriptions.js";
import { expectConstructibleAuthoringInputs, schemaObject } from "./facade-test-support.js";
import {
  MCP_PROGRESSIVE_OPERATION_SCHEMA_SIZE_BUDGET_BYTES,
  MCP_STATUS_TOOL_NAME,
  handleAuthenticatedMcpRequest,
} from "./server.js";

const origin = "https://crewhelm.test";
const toolListResponseSchema = z.looseObject({
  result: z.looseObject({
    tools: z.array(
      z.looseObject({
        inputSchema: z.record(z.string(), z.unknown()),
        name: z.string(),
      }),
    ),
  }),
});
const toolCallResponseSchema = z.looseObject({
  result: z.looseObject({
    content: z.array(z.looseObject({ text: z.string().optional(), type: z.string() })),
    isError: z.boolean(),
  }),
});
const operationListSchema = z.looseObject({
  ok: z.literal(true),
  operations: z.array(
    z.looseObject({
      description: z.string(),
      name: z.string(),
    }),
  ),
  tool: z.string(),
});
const operationSchemaResultSchema = z.looseObject({
  ok: z.literal(true),
  operation: z.string(),
  schema: z.record(z.string(), z.unknown()),
  tool: z.string(),
});

let authority: z.infer<typeof ownerAuthoritySchema>;
let requestId = 1;

beforeAll(async () => {
  authority = ownerAuthoritySchema.parse({
    clientId: "mcp-facade-contract",
    ownerKey: await deriveOwnerKey({
      issuer: "https://github.com",
      subject: "mcp-facade-contract",
    }),
    scopes: [OWNER_READ_SCOPE],
  });
});

function mcpRequest(method: string, params: Record<string, unknown>): Request {
  return new Request(`${origin}/mcp`, {
    body: JSON.stringify({ id: requestId++, jsonrpc: "2.0", method, params }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    method: "POST",
  });
}

async function toolsList() {
  const response = await handleAuthenticatedMcpRequest(mcpRequest("tools/list", {}), env, {
    authority,
  });
  return toolListResponseSchema.parse(await response.json()).result.tools;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const response = await handleAuthenticatedMcpRequest(
    mcpRequest("tools/call", { arguments: args, name }),
    env,
    { authority },
  );
  return toolCallResponseSchema.parse(await response.json()).result;
}

function textJson(result: z.infer<typeof toolCallResponseSchema>["result"]): unknown {
  return JSON.parse(result.content[0]?.text ?? "null") as unknown;
}

describe("authenticated MCP facade catalog", () => {
  it("exposes exactly the facade entry points plus status", async () => {
    const tools = await toolsList();

    expect(tools.map(({ name }) => name).toSorted()).toEqual(
      [...FACADE_TOOL_DEFINITIONS.map(({ name }) => name), MCP_STATUS_TOOL_NAME].toSorted(),
    );
    for (const tool of tools.filter(({ name }) => name !== MCP_STATUS_TOOL_NAME)) {
      expect(tool.inputSchema).toMatchObject({
        properties: {
          input: expect.objectContaining({ type: "object" }),
          name: expect.objectContaining({ type: "string" }),
          request: expect.objectContaining({
            enum: ["operations", "schema", "execute"],
          }),
        },
        type: "object",
      });
      expect(JSON.stringify(tool.inputSchema)).not.toContain('"kind"');
    }
  });

  it("lists every configured operation with its exact public description", async () => {
    for (const definition of FACADE_TOOL_DEFINITIONS) {
      const result = await callTool(definition.name, { request: "operations" });
      const listed = operationListSchema.parse(textJson(result));

      expect(result.isError).toBe(false);
      expect(listed).toEqual({
        ok: true,
        operations: definition.operations.map(({ kind }) => ({
          description: facadeOperationDescription(definition.name, kind),
          name: kind,
        })),
        tool: definition.name,
      });
      expect(JSON.stringify(listed)).not.toContain("privateTool");
    }
  });

  it("discloses a bounded, constructible, self-contained schema for every operation", async () => {
    for (const definition of FACADE_TOOL_DEFINITIONS) {
      for (const operation of definition.operations) {
        const result = await callTool(definition.name, {
          name: operation.kind,
          request: "schema",
        });
        const described = operationSchemaResultSchema.parse(textJson(result));
        const label = `${definition.name}.${operation.kind}`;
        const serialized = JSON.stringify(described.schema);

        expect(result.isError).toBe(false);
        expect(described).toMatchObject({
          ok: true,
          operation: operation.kind,
          schema: { type: "object" },
          tool: definition.name,
        });
        expect(schemaObject(described.schema.properties)).not.toHaveProperty("kind");
        expect(serialized).not.toContain('"$ref"');
        expect(serialized).not.toContain('"$defs"');
        expect(serialized).not.toContain(operation.privateTool);
        expectConstructibleAuthoringInputs(described.schema, label);
        expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
          MCP_PROGRESSIVE_OPERATION_SCHEMA_SIZE_BUDGET_BYTES,
        );
      }
    }
  });

  it("rejects unknown operations and every malformed execution before dispatch", async () => {
    for (const definition of FACADE_TOOL_DEFINITIONS) {
      const unknown = await callTool(definition.name, {
        name: "not_an_operation",
        request: "schema",
      });
      expect(unknown).toMatchObject({
        content: [expect.objectContaining({ text: "Unknown Crewhelm operation." })],
        isError: true,
      });

      for (const operation of definition.operations) {
        const invalid = await callTool(definition.name, {
          input: { __unexpected: true },
          name: operation.kind,
          request: "execute",
        });
        expect(invalid).toMatchObject({
          content: [
            expect.objectContaining({
              text: expect.stringMatching(/^Invalid Crewhelm operation input(?: at [^:]+)?:/),
            }),
          ],
          isError: true,
        });
      }
    }
  });
});
