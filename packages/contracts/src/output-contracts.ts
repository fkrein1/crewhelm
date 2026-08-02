import * as z from "zod";

import { sha256DigestSchema } from "./capabilities.js";

export const MAXIMUM_OUTPUT_SCHEMA_BYTES = 16 * 1_024;
export const MAXIMUM_OUTPUT_SCHEMA_DEPTH = 8;
export const MAXIMUM_OUTPUT_SCHEMA_NODES = 128;
export const MAXIMUM_OUTPUT_VALIDATION_ISSUES = 8;

const jsonValueSchema = z.json();
const outputSchemaNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "Expected a portable schema name.");
const outputSchemaVersionSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Expected a portable schema version.");
const propertyNamePattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const unsafePropertyNames = new Set(["__proto__", "constructor", "prototype"]);
const schemaTypes = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const commonSchemaFields = new Set(["description", "enum", "type"]);
const fieldsByType: Record<string, ReadonlySet<string>> = {
  array: new Set([...commonSchemaFields, "items", "maxItems", "minItems"]),
  boolean: commonSchemaFields,
  integer: new Set([...commonSchemaFields, "maximum", "minimum"]),
  null: commonSchemaFields,
  number: new Set([...commonSchemaFields, "maximum", "minimum"]),
  object: new Set([
    ...commonSchemaFields,
    "additionalProperties",
    "maxProperties",
    "minProperties",
    "properties",
    "required",
  ]),
  string: new Set([...commonSchemaFields, "maxLength", "minLength"]),
};
const MAXIMUM_OUTPUT_SCHEMA_JSON_DEPTH = 32;
const MAXIMUM_OUTPUT_SCHEMA_JSON_CONTAINERS = 1_024;
const MAXIMUM_OUTPUT_VALUE_CONTAINERS = 65_536;

export type JsonValue = z.infer<typeof jsonValueSchema>;
type PublicJsonScalar = boolean | null | number | string;
type PublicJsonValue1 = PublicJsonScalar | PublicJsonScalar[] | Record<string, PublicJsonScalar>;
type PublicJsonValue2 = PublicJsonScalar | PublicJsonValue1[] | Record<string, PublicJsonValue1>;
type PublicJsonValue3 = PublicJsonScalar | PublicJsonValue2[] | Record<string, PublicJsonValue2>;
type PublicJsonValue4 = PublicJsonScalar | PublicJsonValue3[] | Record<string, PublicJsonValue3>;
type PublicJsonValue5 = PublicJsonScalar | PublicJsonValue4[] | Record<string, PublicJsonValue4>;
type PublicJsonValue6 = PublicJsonScalar | PublicJsonValue5[] | Record<string, PublicJsonValue5>;
type PublicJsonValue7 = PublicJsonScalar | PublicJsonValue6[] | Record<string, PublicJsonValue6>;
export type PublicJsonObject = Record<string, PublicJsonValue7>;
export const publicJsonObjectSchema = jsonValueSchema.refine(
  (value): value is PublicJsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value),
  "Expected a JSON object.",
) as z.ZodType<PublicJsonObject>;

export type OutputValidationIssue = {
  code: "additional_property" | "bound" | "enum" | "invalid_json" | "required" | "type_mismatch";
  path: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIssue(context: z.RefinementCtx, path: PropertyKey[], message: string): void {
  context.addIssue({ code: "custom", message, path });
}

function jsonValuePreflight(
  value: unknown,
  limits: { maxContainers: number; maxDepth: number },
): "cycle" | "depth" | "invalid" | "size" | null {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 1, value }];
  const seen = new WeakSet<object>();
  let containers = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.depth > limits.maxDepth) return "depth";
    if (typeof current.value !== "object" || current.value === null) {
      if (
        current.value !== null &&
        typeof current.value !== "string" &&
        typeof current.value !== "boolean" &&
        !finiteNumber(current.value)
      ) {
        return "invalid";
      }
      continue;
    }
    if (seen.has(current.value)) {
      return "cycle";
    }
    seen.add(current.value);
    containers += 1;
    if (containers > limits.maxContainers) return "size";
    const container: object = current.value;
    const children = Array.isArray(container)
      ? container
      : Reflect.ownKeys(container).map((key) => Reflect.get(container, key));
    for (const child of children) stack.push({ depth: current.depth + 1, value: child });
  }

  return null;
}

function preflightSchemaValue(value: unknown, context: z.RefinementCtx): boolean {
  const failure = jsonValuePreflight(value, {
    maxContainers: MAXIMUM_OUTPUT_SCHEMA_JSON_CONTAINERS,
    maxDepth: MAXIMUM_OUTPUT_SCHEMA_JSON_DEPTH,
  });
  if (failure === null) return true;
  const message = {
    cycle: "Output schema must not contain cycles.",
    depth: "Output schema JSON is nested too deeply.",
    invalid: "Output schema must contain only finite JSON values.",
    size: "Output schema JSON has too many containers.",
  }[failure];
  schemaIssue(context, [], message);
  return false;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateBounds(
  node: Record<string, unknown>,
  minimumKey: string,
  maximumKey: string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const minimum = node[minimumKey];
  const maximum = node[maximumKey];

  if (
    minimum !== undefined &&
    (typeof minimum !== "number" || !Number.isInteger(minimum) || minimum < 0 || minimum > 65_536)
  ) {
    schemaIssue(context, [...path, minimumKey], "Expected a bounded non-negative integer.");
  }
  if (
    maximum !== undefined &&
    (typeof maximum !== "number" || !Number.isInteger(maximum) || maximum < 0 || maximum > 65_536)
  ) {
    schemaIssue(context, [...path, maximumKey], "Expected a bounded non-negative integer.");
  }
  if (
    typeof minimum === "number" &&
    typeof maximum === "number" &&
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    minimum > maximum
  ) {
    schemaIssue(context, [...path, maximumKey], "Maximum must not be less than minimum.");
  }
}

function valueMatchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isSafeInteger(value);
    case "null":
      return value === null;
    case "number":
      return finiteNumber(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return false;
  }
}

function inspectSchemaNode(
  node: unknown,
  path: PropertyKey[],
  depth: number,
  state: { nodes: number },
  context: z.RefinementCtx,
): void {
  state.nodes += 1;
  if (state.nodes > MAXIMUM_OUTPUT_SCHEMA_NODES) {
    schemaIssue(context, path, "Output schema has too many nodes.");
    return;
  }
  if (depth > MAXIMUM_OUTPUT_SCHEMA_DEPTH) {
    schemaIssue(context, path, "Output schema is nested too deeply.");
    return;
  }
  if (!isRecord(node)) {
    schemaIssue(context, path, "Expected a JSON Schema object.");
    return;
  }

  const type = node.type;
  if (typeof type !== "string" || !schemaTypes.has(type)) {
    schemaIssue(context, [...path, "type"], "Expected one supported JSON Schema type.");
    return;
  }

  const allowedFields = fieldsByType[type] ?? commonSchemaFields;
  for (const key of Object.keys(node)) {
    if (!allowedFields.has(key)) {
      schemaIssue(context, [...path, key], "Unsupported JSON Schema field.");
    }
  }

  if (
    node.description !== undefined &&
    (typeof node.description !== "string" || node.description.length > 256)
  ) {
    schemaIssue(
      context,
      [...path, "description"],
      "Schema descriptions are limited to 256 characters.",
    );
  }

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0 || node.enum.length > 50) {
      schemaIssue(context, [...path, "enum"], "Enums require one to fifty values.");
    } else {
      const canonicalValues = new Set<string>();
      for (const [index, value] of node.enum.entries()) {
        if (!valueMatchesType(value, type)) {
          schemaIssue(
            context,
            [...path, "enum", index],
            "Enum value does not match the schema type.",
          );
          continue;
        }
        const canonical = canonicalJson(jsonValueSchema.parse(value));
        if (canonicalValues.has(canonical)) {
          schemaIssue(context, [...path, "enum", index], "Enum values must be unique.");
        }
        canonicalValues.add(canonical);
      }
    }
  }

  if (type === "object") {
    const properties = node.properties;
    const required = node.required;
    if (!isRecord(properties) || Object.keys(properties).length > 64) {
      schemaIssue(context, [...path, "properties"], "Objects require at most 64 named properties.");
      return;
    }
    if (node.additionalProperties !== false) {
      schemaIssue(
        context,
        [...path, "additionalProperties"],
        "Objects must deny additional properties.",
      );
    }
    if (!Array.isArray(required) || required.some((value) => typeof value !== "string")) {
      schemaIssue(
        context,
        [...path, "required"],
        "Objects require an explicit property-name array.",
      );
    } else {
      const unique = new Set(required);
      if (
        unique.size !== required.length ||
        required.some((key) => !Object.hasOwn(properties, key))
      ) {
        schemaIssue(
          context,
          [...path, "required"],
          "Required properties must be unique and declared.",
        );
      }
    }
    validateBounds(node, "minProperties", "maxProperties", path, context);
    for (const [key, child] of Object.entries(properties)) {
      if (!propertyNamePattern.test(key) || unsafePropertyNames.has(key)) {
        schemaIssue(context, [...path, "properties", key], "Expected a portable property name.");
      }
      inspectSchemaNode(child, [...path, "properties", key], depth + 1, state, context);
    }
    return;
  }

  if (type === "array") {
    if (node.items === undefined) {
      schemaIssue(context, [...path, "items"], "Arrays require one item schema.");
    } else {
      inspectSchemaNode(node.items, [...path, "items"], depth + 1, state, context);
    }
    validateBounds(node, "minItems", "maxItems", path, context);
    return;
  }

  if (type === "string") {
    validateBounds(node, "minLength", "maxLength", path, context);
  }

  if (type === "number" || type === "integer") {
    const minimum = node.minimum;
    const maximum = node.maximum;
    if (minimum !== undefined && !finiteNumber(minimum)) {
      schemaIssue(context, [...path, "minimum"], "Expected a finite numeric minimum.");
    }
    if (maximum !== undefined && !finiteNumber(maximum)) {
      schemaIssue(context, [...path, "maximum"], "Expected a finite numeric maximum.");
    }
    if (finiteNumber(minimum) && finiteNumber(maximum) && minimum > maximum) {
      schemaIssue(context, [...path, "maximum"], "Maximum must not be less than minimum.");
    }
  }
}

function normalizeSchemaNode(node: Record<string, JsonValue>): Record<string, JsonValue>;
function normalizeSchemaNode(node: JsonValue): JsonValue;
function normalizeSchemaNode(node: JsonValue): JsonValue {
  if (Array.isArray(node)) {
    return node.map((value) => normalizeSchemaNode(value));
  }
  if (!isRecord(node)) {
    return node;
  }

  const entries: Array<[string, JsonValue]> = [];
  for (const key of Object.keys(node).toSorted()) {
    const value = jsonValueSchema.parse(node[key]);
    if (key === "required" && Array.isArray(value)) {
      entries.push([
        key,
        [...value].toSorted((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      ]);
    } else if (key === "enum" && Array.isArray(value)) {
      entries.push([
        key,
        [...value].toSorted((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        ),
      ]);
    } else {
      entries.push([key, normalizeSchemaNode(value)]);
    }
  }
  return Object.fromEntries(entries);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`)
      .join(",")}}`;
  }
  throw new TypeError("Expected a JSON value.");
}

const restrictedJsonSchema = z
  .preprocess(
    (value) =>
      jsonValuePreflight(value, {
        maxContainers: MAXIMUM_OUTPUT_SCHEMA_JSON_CONTAINERS,
        maxDepth: MAXIMUM_OUTPUT_SCHEMA_JSON_DEPTH,
      }) === null
        ? value
        : null,
    z.record(z.string(), z.json()),
  )
  .superRefine((schema, context) => {
    if (!preflightSchemaValue(schema, context)) return;
    if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > MAXIMUM_OUTPUT_SCHEMA_BYTES) {
      schemaIssue(context, [], "Output schema exceeds the byte limit.");
      return;
    }
    inspectSchemaNode(schema, [], 1, { nodes: 0 }, context);
    if (schema.type !== "object") {
      schemaIssue(context, ["type"], "The output schema root must be an object.");
    }
  })
  .transform((schema) => {
    const parsed = jsonValueSchema.parse(schema);
    if (!isRecord(parsed)) throw new TypeError("Expected an output schema object.");
    return normalizeSchemaNode(
      Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key, jsonValueSchema.parse(value)]),
      ),
    );
  })
  .describe(
    "Restricted object-root JSON Schema: scalar, array, and nested object types; required, enum, and basic bounds; additionalProperties must be false. Remote references, recursion, patterns, and composition are unsupported.",
  );

export const outputContractSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("markdown") }),
  z.strictObject({
    kind: z.literal("json"),
    schema: z.strictObject({
      jsonSchema: restrictedJsonSchema,
      name: outputSchemaNameSchema,
      version: outputSchemaVersionSchema,
    }),
  }),
]);

export const admittedOutputContractSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("markdown") }),
  z.strictObject({
    kind: z.literal("json"),
    schema: outputContractSchema.options[1].shape.schema.extend({ digest: sha256DigestSchema }),
  }),
]);

export const outputContractSummarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("markdown") }),
  z.strictObject({
    kind: z.literal("json"),
    schema: z.strictObject({
      digest: sha256DigestSchema,
      name: outputSchemaNameSchema,
      version: outputSchemaVersionSchema,
    }),
  }),
]);

export const outputValidationIssueSchema = z.strictObject({
  code: z.enum([
    "additional_property",
    "bound",
    "enum",
    "invalid_json",
    "required",
    "type_mismatch",
  ]),
  path: z.string().max(256),
});

export const jsonDeliverableSchema = z.discriminatedUnion("state", [
  z.strictObject({
    contentDigest: sha256DigestSchema,
    kind: z.literal("json"),
    mediaType: z.literal("application/json"),
    repairAttempted: z.boolean(),
    schema: z.strictObject({
      digest: sha256DigestSchema,
      name: outputSchemaNameSchema,
      version: outputSchemaVersionSchema,
    }),
    sizeCharacters: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1_024),
    state: z.literal("valid"),
  }),
  z.strictObject({
    issues: z.array(outputValidationIssueSchema).min(1).max(MAXIMUM_OUTPUT_VALIDATION_ISSUES),
    kind: z.literal("json"),
    mediaType: z.literal("application/json"),
    repairAttempted: z.boolean(),
    schema: z.strictObject({
      digest: sha256DigestSchema,
      name: outputSchemaNameSchema,
      version: outputSchemaVersionSchema,
    }),
    state: z.literal("invalid"),
  }),
]);

function outputPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "$";
  return `$${path.map((part) => (typeof part === "number" ? `[${part}]` : `.${part}`)).join("")}`.slice(
    0,
    256,
  );
}

function addOutputIssue(issues: OutputValidationIssue[], issue: OutputValidationIssue): void {
  if (issues.length < MAXIMUM_OUTPUT_VALIDATION_ISSUES) issues.push(issue);
}

function validateValue(
  node: Record<string, unknown>,
  value: unknown,
  path: Array<string | number>,
  issues: OutputValidationIssue[],
): void {
  if (issues.length >= MAXIMUM_OUTPUT_VALIDATION_ISSUES) return;
  const type = String(node.type);
  if (!valueMatchesType(value, type)) {
    addOutputIssue(issues, { code: "type_mismatch", path: outputPath(path) });
    return;
  }

  const enumValues = node.enum;
  if (
    Array.isArray(enumValues) &&
    !enumValues.some(
      (candidate) =>
        canonicalJson(jsonValueSchema.parse(candidate)) ===
        canonicalJson(jsonValueSchema.parse(value)),
    )
  ) {
    addOutputIssue(issues, { code: "enum", path: outputPath(path) });
  }

  if (type === "object" && isRecord(value)) {
    const properties = isRecord(node.properties) ? node.properties : {};
    const required = Array.isArray(node.required) ? node.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) {
        addOutputIssue(issues, { code: "required", path: outputPath([...path, key]) });
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (!isRecord(childSchema)) {
        addOutputIssue(issues, {
          code: "additional_property",
          path: outputPath([...path, key]),
        });
      } else {
        validateValue(childSchema, child, [...path, key], issues);
      }
    }
    const size = Object.keys(value).length;
    if (
      (typeof node.minProperties === "number" && size < node.minProperties) ||
      (typeof node.maxProperties === "number" && size > node.maxProperties)
    ) {
      addOutputIssue(issues, { code: "bound", path: outputPath(path) });
    }
  } else if (type === "array" && Array.isArray(value)) {
    if (
      (typeof node.minItems === "number" && value.length < node.minItems) ||
      (typeof node.maxItems === "number" && value.length > node.maxItems)
    ) {
      addOutputIssue(issues, { code: "bound", path: outputPath(path) });
    }
    if (isRecord(node.items)) {
      for (const [index, child] of value.entries())
        validateValue(node.items, child, [...path, index], issues);
    }
  } else if (type === "string" && typeof value === "string") {
    if (
      (typeof node.minLength === "number" && value.length < node.minLength) ||
      (typeof node.maxLength === "number" && value.length > node.maxLength)
    ) {
      addOutputIssue(issues, { code: "bound", path: outputPath(path) });
    }
  } else if ((type === "number" || type === "integer") && typeof value === "number") {
    if (
      (typeof node.minimum === "number" && value < node.minimum) ||
      (typeof node.maximum === "number" && value > node.maximum)
    ) {
      addOutputIssue(issues, { code: "bound", path: outputPath(path) });
    }
  }
}

export function validateJsonOutput(
  schema: Record<string, JsonValue>,
  value: unknown,
): { issues: OutputValidationIssue[]; ok: false } | { ok: true; value: JsonValue } {
  if (
    jsonValuePreflight(value, {
      maxContainers: MAXIMUM_OUTPUT_VALUE_CONTAINERS,
      maxDepth: MAXIMUM_OUTPUT_SCHEMA_DEPTH + 1,
    }) !== null
  ) {
    return { issues: [{ code: "bound", path: "$" }], ok: false };
  }
  const parsed = jsonValueSchema.safeParse(value);
  if (!parsed.success) return { issues: [{ code: "invalid_json", path: "$" }], ok: false };
  const issues: OutputValidationIssue[] = [];
  validateValue(schema, parsed.data, [], issues);
  return issues.length === 0 ? { ok: true, value: parsed.data } : { issues, ok: false };
}

export type AdmittedOutputContract = z.infer<typeof admittedOutputContractSchema>;
export type JsonDeliverable = z.infer<typeof jsonDeliverableSchema>;
export type OutputContract = z.infer<typeof outputContractSchema>;
