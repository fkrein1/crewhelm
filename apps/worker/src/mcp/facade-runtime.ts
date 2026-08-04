import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod";

import {
  facadeAgentReferenceSchema,
  facadeConfirmationSchema,
  facadeRequestKeySchema,
  type FacadeOperation,
  type FacadeToolDefinition,
} from "./facade-contract.js";
import { facadeOperationDescription } from "./facade-operation-descriptions.js";
import type { PrivateToolCatalog } from "./private-tool-catalog.js";

export const progressiveFacadeInputSchema = z.looseObject({
  input: z.record(z.string(), z.unknown()).optional(),
  name: z.string().min(1).max(64).optional(),
  request: z.enum(["operations", "schema", "execute"]).optional(),
});

function objectSchema(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
): z.ZodObject<z.ZodRawShape> {
  const schema = catalog.inputSchema(operation.privateTool);

  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`Private MCP operation is not object-shaped: ${operation.privateTool}`);
  }

  return schema;
}

function targetVariant(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
): z.ZodObject | null {
  if (operation.targetKind === undefined) return null;

  const target = objectSchema(catalog, operation).shape.target;
  if (!(target instanceof z.ZodDiscriminatedUnion)) {
    throw new Error(`Private MCP target is not discriminated: ${operation.privateTool}`);
  }
  let variant: z.ZodObject<z.ZodRawShape> | undefined;

  for (const option of target.options) {
    if (
      option instanceof z.ZodObject &&
      option.shape.kind instanceof z.ZodLiteral &&
      option.shape.kind.value === operation.targetKind
    ) {
      variant = option;
      break;
    }
  }

  if (variant === undefined) {
    throw new Error(
      `Private MCP target is missing ${operation.targetKind}: ${operation.privateTool}`,
    );
  }

  return variant;
}

function publicFieldSchema(schema: z.ZodType, required: boolean, description?: string): z.ZodType {
  let field = schema;

  if (required && schema instanceof z.ZodOptional) {
    const unwrapped: unknown = schema.unwrap();
    if (!(unwrapped instanceof z.ZodType)) throw new Error("Invalid optional MCP field schema.");
    field = unwrapped;
  }

  return description === undefined ? field : field.describe(description);
}

export function facadeOperationSchema(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
): z.ZodObject {
  const kindSchema =
    operation.schemaKinds === undefined ? z.literal(operation.kind) : z.enum(operation.schemaKinds);

  if (operation.publicSchema !== undefined) {
    return z.strictObject({ kind: kindSchema, ...operation.publicSchema.shape });
  }

  const privateShape: z.ZodRawShape = { ...objectSchema(catalog, operation).shape };
  const publicShape: Record<string, z.ZodType> = {};
  const coordinateFields = operation.agentCoordinates;
  const referencedFields = new Set(
    (operation.references ?? []).flatMap((reference) => Object.keys(reference.fields)),
  );
  const omittedFields = new Set(operation.omit ?? []);
  const includedFields = operation.only === undefined ? null : new Set(operation.only);
  const requiredFields = new Set(operation.required ?? []);
  const target = targetVariant(catalog, operation);

  for (const [privateName, schema] of Object.entries(privateShape)) {
    if (
      privateName === "idempotencyKey" ||
      (privateName === "action" && operation.action !== undefined) ||
      (privateName === "mode" &&
        (operation.confirmation === true || operation.privateDefaults?.mode !== undefined)) ||
      (privateName === "target" && target !== null) ||
      privateName === coordinateFields?.id ||
      privateName === coordinateFields?.revision ||
      referencedFields.has(privateName) ||
      omittedFields.has(privateName) ||
      (includedFields !== null && !includedFields.has(privateName))
    ) {
      continue;
    }
    if (!(schema instanceof z.ZodType)) throw new Error("Invalid private MCP field schema.");

    const publicName = operation.rename?.[privateName] ?? privateName;
    publicShape[publicName] = publicFieldSchema(
      operation.publicFields?.[publicName] ?? schema,
      requiredFields.has(privateName),
      operation.descriptions?.[publicName],
    );
  }

  if (coordinateFields !== undefined) {
    publicShape.agent = facadeAgentReferenceSchema;
  }

  for (const reference of operation.references ?? []) {
    publicShape[reference.name] = reference.schema;
  }

  if (target !== null) {
    for (const [name, schema] of Object.entries(target.shape)) {
      if (name === "kind") continue;
      if (!(schema instanceof z.ZodType)) throw new Error("Invalid MCP target field schema.");
      publicShape[name] = publicFieldSchema(
        schema,
        requiredFields.has(name),
        operation.descriptions?.[name],
      );
    }
  }

  if (operation.confirmation === true) {
    publicShape.confirm = facadeConfirmationSchema;
  }

  if (
    "idempotencyKey" in privateShape &&
    operation.retryKey !== false &&
    (includedFields === null || includedFields.has("idempotencyKey"))
  ) {
    publicShape.requestKey = facadeRequestKeySchema;
  }

  return z.strictObject({ kind: kindSchema, ...publicShape });
}

function legacyFacadeInputSchema(
  catalog: PrivateToolCatalog,
  operations: readonly FacadeOperation[],
) {
  const schemas = operations
    .filter((operation) => operation.schemaAlias === undefined)
    .map((operation) => facadeOperationSchema(catalog, operation));
  const first = schemas.at(0);

  if (first === undefined) throw new Error("Crewhelm facade tool has no operations.");

  const second = schemas.at(1);
  const operation = second === undefined ? first : z.union([first, second, ...schemas.slice(2)]);

  return z.strictObject({ operation });
}

export function facadeOperationPayloadSchema(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
): z.ZodObject {
  return facadeOperationSchema(catalog, operation).omit({ kind: true });
}

const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export function inlineFacadeSchemaReferences(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const parsedDefinitions = jsonSchemaObjectSchema.safeParse(schema.$defs);
  const definitions = parsedDefinitions.success ? parsedDefinitions.data : {};

  function inline(value: unknown, resolving: ReadonlySet<string>): unknown {
    if (Array.isArray(value)) return value.map((item) => inline(item, resolving));
    const parsedObject = jsonSchemaObjectSchema.safeParse(value);
    if (!parsedObject.success) return value;

    const object = parsedObject.data;
    if (typeof object.$ref === "string" && object.$ref.startsWith("#/$defs/")) {
      const name = object.$ref.slice("#/$defs/".length);
      const definition = definitions[name];
      if (definition === undefined || resolving.has(name)) {
        throw new Error(`Cannot inline Crewhelm schema reference: ${name}`);
      }
      const resolved = jsonSchemaObjectSchema.parse(
        inline(definition, new Set([...resolving, name])),
      );
      const siblings = Object.fromEntries(
        Object.entries(object)
          .filter(([key]) => key !== "$ref")
          .map(([key, nested]) => [key, inline(nested, resolving)]),
      );
      return { ...resolved, ...siblings };
    }

    return Object.fromEntries(
      Object.entries(object)
        .filter(([name]) => name !== "$defs")
        .map(([name, nested]) => [name, inline(nested, resolving)]),
    );
  }

  return jsonSchemaObjectSchema.parse(inline(schema, new Set()));
}

export function facadeOperationJsonSchema(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
): Record<string, unknown> {
  return inlineFacadeSchemaReferences(
    z.toJSONSchema(facadeOperationPayloadSchema(catalog, operation), { io: "input" }),
  );
}

function progressiveResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ text: JSON.stringify(value), type: "text" }],
    isError: false,
    structuredContent: value,
  };
}

function progressiveError(message: string): CallToolResult {
  return {
    content: [{ text: message, type: "text" }],
    isError: true,
  };
}

function catalogDescription(description: string): string {
  return description.match(/^.*?[.!?](?:\s|$)/)?.[0].trim() ?? description;
}

export function facadeDerivedRequestKey(extra: unknown): string {
  const requestId =
    typeof extra === "object" && extra !== null && "requestId" in extra
      ? String(extra.requestId)
      : crypto.randomUUID();
  const safe = requestId.replaceAll(/[^A-Za-z0-9._~-]/g, "-").slice(0, 96);

  return `mcp-${safe}`;
}

function privateInput(
  catalog: PrivateToolCatalog,
  operation: FacadeOperation,
  input: Record<string, unknown>,
  extra: unknown,
): Record<string, unknown> {
  if (operation.toPrivate !== undefined) return operation.toPrivate(input, extra);

  const privateShape = objectSchema(catalog, operation).shape;
  const result: Record<string, unknown> = {};
  const target = targetVariant(catalog, operation);
  const targetFields = new Set(target === null ? [] : Object.keys(target.shape));

  for (const [publicName, value] of Object.entries(input)) {
    if (
      publicName === "kind" ||
      publicName === "requestKey" ||
      publicName === "agent" ||
      publicName === "confirm" ||
      targetFields.has(publicName) ||
      operation.references?.some((reference) => reference.name === publicName)
    ) {
      continue;
    }

    const privateName =
      Object.entries(operation.rename ?? {}).find(
        ([, candidate]) => candidate === publicName,
      )?.[0] ?? publicName;
    result[privateName] = operation.transformFields?.[publicName]?.(value) ?? value;
  }

  if (operation.action !== undefined) result.action = operation.action;

  Object.assign(result, operation.privateDefaults);

  if (target !== null) {
    result.target = {
      kind: operation.targetKind,
      ...Object.fromEntries(
        [...targetFields]
          .filter((name) => name !== "kind" && input[name] !== undefined)
          .map((name) => [name, input[name]]),
      ),
    };
  }

  if (operation.confirmation === true) {
    result.mode = input.confirm === true ? "apply" : "preview";
  }

  if (operation.agentCoordinates !== undefined) {
    const agent = facadeAgentReferenceSchema.parse(input.agent);
    result[operation.agentCoordinates.id] = agent.id;
    result[operation.agentCoordinates.revision] = agent.revision;
  }

  for (const reference of operation.references ?? []) {
    const referenceValue = input[reference.name];

    if (reference.toPrivate !== undefined) {
      Object.assign(result, reference.toPrivate(referenceValue));
      continue;
    }

    const parsed = z.looseObject({}).parse(reference.schema.parse(referenceValue));

    for (const [privateName, referenceName] of Object.entries(reference.fields)) {
      result[privateName] = parsed[referenceName];
    }
  }

  if (
    "idempotencyKey" in privateShape &&
    (operation.only === undefined || operation.only.includes("idempotencyKey"))
  ) {
    if (input.requestKey !== undefined) {
      result.idempotencyKey = input.requestKey;
    } else if (!objectSchema(catalog, operation).safeParse(result).success) {
      result.idempotencyKey = facadeDerivedRequestKey(extra);
    }
  }

  return result;
}

export function registerProgressiveFacadeTools(
  server: McpServer,
  catalog: PrivateToolCatalog,
  definitions: readonly FacadeToolDefinition[],
): void {
  for (const definition of definitions) {
    const operations = new Map<string, FacadeOperation>(
      definition.operations.map((operation) => [operation.kind, operation] as const),
    );
    const legacyInputSchema = legacyFacadeInputSchema(catalog, definition.operations);

    server.registerTool(
      definition.name,
      {
        annotations: definition.annotations,
        description: catalogDescription(definition.description),
        inputSchema: progressiveFacadeInputSchema,
        title: definition.title,
      },
      async (input, extra): Promise<CallToolResult> => {
        const parsed = progressiveFacadeInputSchema.safeParse(input);

        if (!parsed.success) return progressiveError("Invalid Crewhelm request.");

        if (parsed.data.request === "operations") {
          return progressiveResult({
            ok: true,
            operations: definition.operations.map((operation) => ({
              description: facadeOperationDescription(definition.name, operation.kind),
              name: operation.kind,
            })),
            tool: definition.name,
          });
        }

        if (parsed.data.request === "schema") {
          const selected =
            parsed.data.name === undefined ? undefined : operations.get(parsed.data.name);
          if (selected === undefined) return progressiveError("Unknown Crewhelm operation.");
          return progressiveResult({
            ok: true,
            operation: selected.kind,
            schema: facadeOperationJsonSchema(catalog, selected),
            tool: definition.name,
          });
        }

        if (parsed.data.request === "execute") {
          const selected =
            parsed.data.name === undefined ? undefined : operations.get(parsed.data.name);
          if (selected === undefined) return progressiveError("Unknown Crewhelm operation.");
          const payload = facadeOperationPayloadSchema(catalog, selected).safeParse(
            parsed.data.input ?? {},
          );
          if (!payload.success) return progressiveError("Invalid Crewhelm operation input.");

          try {
            const operation = { kind: selected.kind, ...payload.data };
            return selected.run === undefined
              ? await catalog.dispatch(
                  selected.privateTool,
                  privateInput(catalog, selected, operation, extra),
                  extra,
                )
              : await selected.run(catalog, operation, extra);
          } catch {
            return progressiveError("Invalid Crewhelm operation.");
          }
        }

        const legacy = legacyInputSchema.safeParse(input);
        if (!legacy.success) return progressiveError("Invalid Crewhelm request.");

        const operation = z.looseObject({ kind: z.string() }).parse(legacy.data.operation);
        const selected = operations.get(operation.kind);
        if (selected === undefined) return progressiveError("Unknown Crewhelm operation.");

        try {
          return selected.run === undefined
            ? await catalog.dispatch(
                selected.privateTool,
                privateInput(catalog, selected, operation, extra),
                extra,
              )
            : await selected.run(catalog, operation, extra);
        } catch {
          return progressiveError("Invalid Crewhelm operation.");
        }
      },
    );
  }
}
