import { remoteMcpToolSchema } from "@crewhelm/contracts";
import * as z from "zod";

const MAXIMUM_SCHEMA_DEPTH = 16;
const MAXIMUM_SCHEMA_NODES = 2_048;
const MAXIMUM_SCHEMA_PROPERTIES = 256;
const MAXIMUM_SCHEMA_PROPERTY_NAME_CHARACTERS = 256;
const schemaKeywords = new Set([
  "$schema",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "uniqueItems",
  "writeOnly",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertSchemaComplexity(schema: Record<string, unknown>): void {
  const pending: Array<{ depth: number; schema: Record<string, unknown> }> = [{ depth: 0, schema }];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) throw new Error("Remote MCP schema traversal failed.");
    nodes += 1;
    if (nodes > MAXIMUM_SCHEMA_NODES || current.depth > MAXIMUM_SCHEMA_DEPTH) {
      throw new Error("Remote MCP schema is too complex.");
    }

    for (const key of Object.keys(current.schema)) {
      if (!schemaKeywords.has(key)) throw new Error("Remote MCP schema keyword is unsupported.");
    }

    const properties = current.schema.properties;
    if (properties !== undefined) {
      if (!isPlainObject(properties)) throw new Error("Remote MCP properties are invalid.");
      const entries = Object.entries(properties);
      if (
        entries.length > MAXIMUM_SCHEMA_PROPERTIES ||
        entries.some(
          ([name]) => name.length === 0 || name.length > MAXIMUM_SCHEMA_PROPERTY_NAME_CHARACTERS,
        )
      ) {
        throw new Error("Remote MCP properties are too complex.");
      }
      for (const [, child] of entries) {
        if (!isPlainObject(child)) throw new Error("Remote MCP property schema is invalid.");
        pending.push({ depth: current.depth + 1, schema: child });
      }
    }

    const additional = current.schema.additionalProperties;
    if (additional !== undefined && typeof additional !== "boolean") {
      if (!isPlainObject(additional)) {
        throw new Error("Remote MCP additionalProperties is invalid.");
      }
      pending.push({ depth: current.depth + 1, schema: additional });
    }

    const items = current.schema.items;
    if (items !== undefined) {
      if (!isPlainObject(items)) throw new Error("Remote MCP items schema is invalid.");
      pending.push({ depth: current.depth + 1, schema: items });
    }

    const negated = current.schema.not;
    if (negated !== undefined) {
      if (!isPlainObject(negated)) throw new Error("Remote MCP not schema is invalid.");
      pending.push({ depth: current.depth + 1, schema: negated });
    }

    for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
      const alternatives = current.schema[keyword];
      if (alternatives === undefined) continue;
      if (
        !Array.isArray(alternatives) ||
        alternatives.length === 0 ||
        alternatives.length > MAXIMUM_SCHEMA_PROPERTIES
      ) {
        throw new Error("Remote MCP schema alternatives are invalid.");
      }
      for (const child of alternatives as unknown[]) {
        if (!isPlainObject(child)) throw new Error("Remote MCP alternative schema is invalid.");
        pending.push({ depth: current.depth + 1, schema: child });
      }
    }
  }
}

export function createRemoteMcpInputSchema(input: unknown): z.ZodType<Record<string, unknown>> {
  const schema = remoteMcpToolSchema.shape.inputSchema.parse(input);
  assertSchemaComplexity(schema);
  const compiled = z.fromJSONSchema(schema);
  return z.pipe(compiled, z.record(z.string(), z.unknown()));
}
