import { describe, expect, it } from "vitest";

import {
  MAXIMUM_OUTPUT_VALIDATION_ISSUES,
  canonicalJson,
  outputContractSchema,
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
