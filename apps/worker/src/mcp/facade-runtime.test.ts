import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { CLOSED_CHANGE_FACADE, type FacadeToolDefinition } from "./facade-contract.js";
import {
  facadeDerivedRequestKey,
  inlineFacadeSchemaReferences,
  registerProgressiveFacadeTools,
} from "./facade-runtime.js";
import type { PrivateToolCatalog } from "./private-tool-catalog.js";

type RegisteredHandler = (input: unknown, extra: unknown) => Promise<CallToolResult>;
type RegisterToolStub = (
  name: string,
  configuration: Record<string, unknown>,
  handler: RegisteredHandler,
) => void;

function testHarness() {
  let handler: RegisteredHandler | undefined;
  let configuration: Record<string, unknown> | undefined;
  const registerTool = vi.fn<RegisterToolStub>(
    (
      _name: string,
      registeredConfiguration: Record<string, unknown>,
      registeredHandler: RegisteredHandler,
    ) => {
      configuration = registeredConfiguration;
      handler = registeredHandler;
    },
  );
  const dispatch = vi.fn<PrivateToolCatalog["dispatch"]>(
    async (): Promise<CallToolResult> => ({
      content: [{ text: JSON.stringify({ ok: true }), type: "text" }],
      isError: false,
    }),
  );
  const privateInputSchema = z.strictObject({
    agentId: z.string().min(1),
    agentRevision: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
    mode: z.enum(["preview", "apply"]),
    name: z.string().min(1).optional(),
  });
  const catalog: PrivateToolCatalog = {
    description: () => undefined,
    dispatch,
    inputSchema: () => privateInputSchema,
  };
  const definitions: readonly FacadeToolDefinition[] = [
    {
      annotations: CLOSED_CHANGE_FACADE,
      description: "Test progressive facade. Additional catalog guidance is hidden.",
      name: "crewhelm_test_facade",
      operations: [
        {
          agentCoordinates: { id: "agentId", revision: "agentRevision" },
          confirmation: true,
          kind: "create",
          privateTool: "crewhelm_private_create",
          rename: { name: "title" },
          required: ["name"],
        },
      ],
      title: "Test Crewhelm facade",
    },
  ];

  const server = new Proxy(new McpServer({ name: "facade-runtime-test", version: "0.1.0" }), {
    get(target, property, receiver) {
      return property === "registerTool" ? registerTool : Reflect.get(target, property, receiver);
    },
  });
  registerProgressiveFacadeTools(server, catalog, definitions);

  if (handler === undefined || configuration === undefined) {
    throw new Error("Facade was not registered.");
  }

  return { configuration, dispatch, handler };
}

function jsonResult(result: CallToolResult): unknown {
  const text = result.content.find((content) => content.type === "text")?.text;
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

describe("progressive MCP facade runtime", () => {
  it("registers only the bounded discovery envelope and first-sentence catalog copy", () => {
    const { configuration } = testHarness();

    expect(configuration).toMatchObject({
      annotations: CLOSED_CHANGE_FACADE,
      description: "Test progressive facade.",
      inputSchema: expect.any(z.ZodType),
      title: "Test Crewhelm facade",
    });
    const inputSchema = configuration.inputSchema;
    if (!(inputSchema instanceof z.ZodType)) throw new Error("Facade input schema is missing.");
    expect(JSON.stringify(z.toJSONSchema(inputSchema))).not.toContain("agentRevision");
  });

  it("lists operations without leaking private tool names or schemas", async () => {
    const { handler } = testHarness();
    const result = await handler({ request: "operations" }, {});

    expect(result.isError).toBe(false);
    expect(jsonResult(result)).toEqual({
      ok: true,
      operations: [
        {
          description: "Create an Agent from one bounded definition.",
          name: "create",
        },
      ],
      tool: "crewhelm_test_facade",
    });
    expect(JSON.stringify(jsonResult(result))).not.toContain("crewhelm_private_create");
  });

  it("discloses one exact public payload schema without kind or local references", async () => {
    const { handler } = testHarness();
    const result = await handler({ name: "create", request: "schema" }, {});
    const payload = z
      .looseObject({ schema: z.record(z.string(), z.unknown()) })
      .parse(jsonResult(result));
    const serialized = JSON.stringify(payload.schema);

    expect(result.isError).toBe(false);
    expect(payload.schema).toMatchObject({
      properties: {
        agent: expect.objectContaining({ type: "object" }),
        confirm: expect.objectContaining({ type: "boolean" }),
        requestKey: expect.objectContaining({ type: "string" }),
        title: expect.objectContaining({ type: "string" }),
      },
      required: expect.arrayContaining(["agent", "title"]),
      type: "object",
    });
    expect(serialized).not.toContain('"kind"');
    expect(serialized).not.toContain('"$ref"');
    expect(serialized).not.toContain('"$defs"');
  });

  it("rejects unknown operations and invalid payloads before private dispatch", async () => {
    const { dispatch, handler } = testHarness();

    const unknown = await handler({ name: "missing", request: "schema" }, {});
    const invalid = await handler(
      { input: { title: "Missing Agent" }, name: "create", request: "execute" },
      {},
    );

    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content[0]).toMatchObject({ text: "Unknown Crewhelm operation." });
    expect(invalid).toMatchObject({ isError: true });
    expect(invalid.content[0]).toMatchObject({ text: "Invalid Crewhelm operation input." });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("maps a validated public payload to the exact private dispatch contract", async () => {
    const { dispatch, handler } = testHarness();
    const extra = { requestId: "request with unsafe spaces" };
    const result = await handler(
      {
        input: {
          agent: { id: "agent_00000000-0000-4000-8000-000000000001", revision: 4 },
          confirm: true,
          requestKey: "explicit-retry-key",
          title: "Operator",
        },
        name: "create",
        request: "execute",
      },
      extra,
    );

    expect(result.isError).toBe(false);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      "crewhelm_private_create",
      {
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        agentRevision: 4,
        idempotencyKey: "explicit-retry-key",
        mode: "apply",
        name: "Operator",
      },
      extra,
    );
  });

  it("contains dispatch exceptions behind a stable public error", async () => {
    const harness = testHarness();
    harness.dispatch.mockRejectedValueOnce(new Error("private detail"));

    const result = await harness.handler(
      {
        input: {
          agent: { id: "agent_00000000-0000-4000-8000-000000000001", revision: 4 },
          requestKey: "retry-key",
          title: "Operator",
        },
        name: "create",
        request: "execute",
      },
      {},
    );

    expect(result).toMatchObject({ isError: true });
    expect(result.content[0]).toMatchObject({ text: "Invalid Crewhelm operation." });
    expect(JSON.stringify(result)).not.toContain("private detail");
  });

  it("inlines local schema references and rejects missing or recursive references", () => {
    expect(
      inlineFacadeSchemaReferences({
        $defs: { Name: { minLength: 1, type: "string" } },
        properties: { name: { $ref: "#/$defs/Name", description: "Public name." } },
        type: "object",
      }),
    ).toEqual({
      properties: {
        name: { description: "Public name.", minLength: 1, type: "string" },
      },
      type: "object",
    });
    expect(() => inlineFacadeSchemaReferences({ $ref: "#/$defs/Missing" })).toThrow(
      "Cannot inline Crewhelm schema reference: Missing",
    );
    expect(() =>
      inlineFacadeSchemaReferences({
        $defs: { Recursive: { $ref: "#/$defs/Recursive" } },
        $ref: "#/$defs/Recursive",
      }),
    ).toThrow("Cannot inline Crewhelm schema reference: Recursive");
  });

  it("derives bounded retry keys without reflecting unsafe request identifiers", () => {
    const key = facadeDerivedRequestKey({ requestId: "unsafe request/id?" });

    expect(key).toBe("mcp-unsafe-request-id-");
    expect(key).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(key.length).toBeLessThanOrEqual(100);
  });
});
