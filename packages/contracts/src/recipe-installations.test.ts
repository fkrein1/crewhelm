import { describe, expect, it } from "vitest";

import { recipeToolMcpInputSchema } from "./recipe-installations.js";

describe("Recipe MCP input", () => {
  it("does not inject search defaults into non-search actions", () => {
    const input = {
      action: "inspect",
      target: {
        digest: "a".repeat(64),
        kind: "recipe",
        name: "decision-memo-advisor",
        namespace: "crewhelm-labs",
        registry: "http://127.0.0.1:8788/",
        version: 1,
      },
    } as const;
    const result = recipeToolMcpInputSchema.safeParse(input);

    expect(result).toEqual({ data: input, success: true });
  });
});
