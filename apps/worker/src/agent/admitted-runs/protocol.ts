export async function digestRunPrompt(prompt: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt)),
  );

  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: JsonValue): string {
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
      .map((key) => {
        const nested = value[key];

        if (nested === undefined) {
          throw new TypeError("Tool input must contain only JSON values.");
        }

        return `${JSON.stringify(key)}:${canonicalJson(nested)}`;
      })
      .join(",")}}`;
  }

  throw new TypeError("Tool input must contain only JSON values.");
}

export async function digestToolInput(input: Record<string, unknown>): Promise<string> {
  const canonicalInput = canonicalJson(jsonValueSchema.parse(input));
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalInput)),
  );

  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
import * as z from "zod";

const jsonValueSchema = z.json();
type JsonValue = z.infer<typeof jsonValueSchema>;
