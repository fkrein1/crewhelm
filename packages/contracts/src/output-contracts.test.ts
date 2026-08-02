import { describe, expect, it } from "vitest";

import {
  MAXIMUM_OUTPUT_VALIDATION_ISSUES,
  canonicalJson,
  outputContractSchema,
  publicJsonObjectSchema,
  validateJsonOutput,
} from "./output-contracts.js";

const reportSchema = {
  additionalProperties: false,
  properties: {
    confidence: { maximum: 1, minimum: 0, type: "number" },
    findings: {
      items: {
        additionalProperties: false,
        properties: {
          severity: { enum: ["high", "low"], type: "string" },
          summary: { maxLength: 200, minLength: 1, type: "string" },
        },
        required: ["summary", "severity"],
        type: "object",
      },
      maxItems: 10,
      type: "array",
    },
  },
  required: ["findings", "confidence"],
  type: "object",
} as const;

function singleReflectionProxy<const Value extends object>(
  value: Value,
): {
  ownKeysCalls(): number;
  value: Value;
} {
  let calls = 0;

  return {
    ownKeysCalls: () => calls,
    value: new Proxy(value, {
      ownKeys(target) {
        calls += 1;

        if (calls > 1) {
          throw new Error("Injected repeated reflection failure.");
        }

        return Reflect.ownKeys(target);
      },
    }),
  };
}

describe("typed output contracts", () => {
  it("accepts and canonicalizes the restricted object-root schema", () => {
    const parsed = outputContractSchema.parse({
      kind: "json",
      schema: { jsonSchema: reportSchema, name: "review_report", version: "1.0" },
    });
    if (parsed.kind !== "json") throw new Error("Expected JSON contract.");

    expect(parsed).toMatchObject({
      kind: "json",
      schema: {
        jsonSchema: {
          required: ["confidence", "findings"],
          type: "object",
        },
      },
    });
    const replay = outputContractSchema.parse(parsed);
    if (replay.kind !== "json") throw new Error("Expected JSON contract replay.");
    expect(canonicalJson(parsed.schema.jsonSchema)).toBe(canonicalJson(replay.schema.jsonSchema));
  });

  it.each([
    [{ additionalProperties: true, properties: {}, required: [], type: "object" }, "additional"],
    [
      {
        additionalProperties: false,
        properties: {},
        required: [],
        type: "object",
        $ref: "https://example.com/schema.json",
      },
      "Unsupported",
    ],
    [{ items: { type: "string" }, type: "array" }, "root"],
    [
      {
        additionalProperties: false,
        properties: { value: { pattern: ".*", type: "string" } },
        required: ["value"],
        type: "object",
      },
      "Unsupported",
    ],
  ])("rejects unsupported or unbounded schemas", (jsonSchema, message) => {
    expect(() =>
      outputContractSchema.parse({
        kind: "json",
        schema: { jsonSchema, name: "invalid", version: "1" },
      }),
    ).toThrow(message);
  });

  it("validates JSON values with bounded stable issues", () => {
    const contract = outputContractSchema.parse({
      kind: "json",
      schema: { jsonSchema: reportSchema, name: "review_report", version: "1" },
    });
    if (contract.kind !== "json") throw new Error("Expected JSON contract.");

    expect(
      validateJsonOutput(contract.schema.jsonSchema, {
        confidence: 0.9,
        findings: [{ severity: "high", summary: "Credential leak" }],
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateJsonOutput(contract.schema.jsonSchema, {
        confidence: 2,
        findings: [{ extra: true, severity: "medium" }],
      }),
    ).toEqual({
      issues: [
        { code: "bound", path: "$.confidence" },
        { code: "required", path: "$.findings[0].summary" },
        { code: "additional_property", path: "$.findings[0].extra" },
        { code: "enum", path: "$.findings[0].severity" },
      ],
      ok: false,
    });
  });

  it("bounds validation evidence when many fields are missing", () => {
    const required = Array.from({ length: 20 }, (_, index) => `field_${index}`);
    const properties = Object.fromEntries(required.map((name) => [name, { type: "string" }]));
    const contract = outputContractSchema.parse({
      kind: "json",
      schema: {
        jsonSchema: { additionalProperties: false, properties, required, type: "object" },
        name: "bounded_report",
        version: "1",
      },
    });
    if (contract.kind !== "json") throw new Error("Expected JSON contract.");

    const result = validateJsonOutput(contract.schema.jsonSchema, {});
    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected validation failure.");
    expect(result.issues).toHaveLength(MAXIMUM_OUTPUT_VALIDATION_ISSUES);
  });

  it("denies hostile deep schemas and outputs without recursive parser failure", () => {
    let deepSchema: unknown = { type: "string" };
    let deepValue: unknown = "leaf";
    for (let depth = 0; depth < 2_000; depth += 1) {
      deepSchema = { items: deepSchema, type: "array" };
      deepValue = [deepValue];
    }

    expect(
      outputContractSchema.safeParse({
        kind: "json",
        schema: {
          jsonSchema: {
            additionalProperties: false,
            properties: { value: deepSchema },
            required: ["value"],
            type: "object",
          },
          name: "deep_report",
          version: "1",
        },
      }).success,
    ).toBe(false);
    const contract = outputContractSchema.parse({
      kind: "json",
      schema: { jsonSchema: reportSchema, name: "deep_value", version: "1" },
    });
    if (contract.kind !== "json") throw new Error("Expected JSON contract.");
    expect(
      validateJsonOutput(contract.schema.jsonSchema, { confidence: 1, findings: deepValue }),
    ).toEqual({
      issues: [{ code: "bound", path: "$" }],
      ok: false,
    });
  });

  it("rejects hostile object reflection as a bounded value instead of throwing", () => {
    const hostileSchema = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("Injected schema reflection failure.");
        },
      },
    );
    const parsed = outputContractSchema.safeParse({
      kind: "json",
      schema: { jsonSchema: hostileSchema, name: "hostile_schema", version: "1" },
    });

    expect(parsed.success).toBe(false);
    expect(publicJsonObjectSchema.safeParse(hostileSchema).success).toBe(false);

    const contract = outputContractSchema.parse({
      kind: "json",
      schema: { jsonSchema: reportSchema, name: "hostile_value", version: "1" },
    });
    if (contract.kind !== "json") throw new Error("Expected JSON contract.");
    let getterCalled = false;
    const hostileValue = Object.defineProperty({}, "confidence", {
      enumerable: true,
      get() {
        getterCalled = true;
        throw new Error("Injected value getter failure.");
      },
    });

    expect(validateJsonOutput(contract.schema.jsonSchema, hostileValue)).toEqual({
      issues: [{ code: "bound", path: "$" }],
      ok: false,
    });
    expect(getterCalled).toBe(false);
  });

  it("validates a stable snapshot without reflecting over stateful input twice", () => {
    const statefulSchema = singleReflectionProxy(reportSchema);
    const parsed = outputContractSchema.safeParse({
      kind: "json",
      schema: { jsonSchema: statefulSchema.value, name: "stateful_schema", version: "1" },
    });

    expect(parsed.success).toBe(true);
    expect(statefulSchema.ownKeysCalls()).toBe(1);

    if (!parsed.success || parsed.data.kind !== "json") {
      throw new Error("Expected stateful JSON contract.");
    }

    const statefulValue = singleReflectionProxy({
      confidence: 0.9,
      findings: [{ severity: "high", summary: "Stable snapshot" }],
    });

    expect(validateJsonOutput(parsed.data.schema.jsonSchema, statefulValue.value)).toMatchObject({
      ok: true,
    });
    expect(statefulValue.ownKeysCalls()).toBe(1);

    const publicValue = singleReflectionProxy({ answer: "Stable snapshot" });
    expect(publicJsonObjectSchema.safeParse(publicValue.value).success).toBe(true);
    expect(publicValue.ownKeysCalls()).toBe(1);
  });

  it.each(["__proto__", "constructor", "prototype"])(
    "denies the prototype-sensitive property %s cleanly",
    (property) => {
      expect(() =>
        outputContractSchema.parse({
          kind: "json",
          schema: {
            jsonSchema: {
              additionalProperties: false,
              properties: Object.fromEntries([[property, { type: "string" }]]),
              required: [property],
              type: "object",
            },
            name: "prototype_safe",
            version: "1",
          },
        }),
      ).toThrow(/Required properties|portable property/);
    },
  );
});
