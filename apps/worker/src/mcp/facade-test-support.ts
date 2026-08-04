import { expect } from "vitest";
import * as z from "zod";

const authoringInputNames = new Set([
  "definition",
  "eventTrigger",
  "jsonSchema",
  "outputContract",
  "package",
  "patch",
  "schedule",
  "value",
]);

export function schemaObject(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function expectConstructibleAuthoringInputs(
  schema: Record<string, unknown>,
  label: string,
): void {
  const properties = schemaObject(schema.properties);
  if (properties !== null) {
    for (const [name, value] of Object.entries(properties)) {
      const property = schemaObject(value) ?? {};
      if (authoringInputNames.has(name)) {
        expect(
          ["allOf", "anyOf", "const", "enum", "oneOf", "type"].some((key) => key in property),
          `${label}.${name} exposes a constructible schema`,
        ).toBe(true);
        if (name === "jsonSchema") {
          expect(
            property.description,
            `${label}.${name} explains the restricted dialect`,
          ).toContain("Restricted object-root JSON Schema");
        }
      }
      expectConstructibleAuthoringInputs(property, `${label}.${name}`);
    }
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    for (const alternative of alternatives) {
      const parsed = schemaObject(alternative);
      if (parsed !== null) expectConstructibleAuthoringInputs(parsed, label);
    }
  }
}
