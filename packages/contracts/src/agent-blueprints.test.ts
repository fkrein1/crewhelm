import { describe, expect, it } from "vitest";

import {
  MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES,
  agentBlueprintPackageSchema,
  listAgentBlueprintsResultSchema,
  publishAgentBlueprintInputSchema,
} from "./agent-blueprints.js";

function packageInput() {
  return {
    agent: {
      capabilities: [
        {
          configuration: {
            fallbackModels: [],
            primaryModel: "@cf/openai/gpt-oss-20b",
          },
          id: "inference.workers-ai",
          schemaVersion: 2,
        },
      ],
      instructions: "Help {{audience}}. Detailed: {{detailed}}. Depth: {{depth}}.",
      name: "{{audience}} helper",
    },
    description: "A configurable research helper.",
    name: "research-helper",
    parameters: [
      {
        description: "Audience name.",
        name: "audience",
        type: "string" as const,
      },
      {
        default: true,
        description: "Whether to include detail.",
        name: "detailed",
        type: "boolean" as const,
      },
      {
        default: 2,
        description: "Research depth.",
        maximum: 5,
        minimum: 1,
        name: "depth",
        type: "integer" as const,
      },
    ],
    provenance: { kind: "authored" as const },
    publisher: { name: "Crewhelm" },
    schemaVersion: 1 as const,
    tags: ["research"],
  };
}

describe("Agent blueprint contracts", () => {
  it("accepts bounded typed parameters used by the Agent template", () => {
    expect(agentBlueprintPackageSchema.parse(packageInput())).toEqual(packageInput());
  });

  it("rejects unknown, unused, duplicate, invalid, and oversized parameters", () => {
    for (const agentBlueprint of [
      {
        ...packageInput(),
        agent: { ...packageInput().agent, instructions: "Unknown {{missing}}." },
      },
      {
        ...packageInput(),
        parameters: [
          ...packageInput().parameters,
          { description: "Unused.", name: "unused", type: "string" },
        ],
      },
      {
        ...packageInput(),
        parameters: [
          ...packageInput().parameters,
          { description: "Duplicate.", name: "audience", type: "string" },
        ],
      },
      {
        ...packageInput(),
        parameters: packageInput().parameters.map((parameter) =>
          parameter.name === "depth" ? { ...parameter, default: 10 } : parameter,
        ),
      },
      {
        ...packageInput(),
        description: "x".repeat(MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES),
      },
    ]) {
      expect(agentBlueprintPackageSchema.safeParse(agentBlueprint).success).toBe(false);
    }
  });

  it("requires idempotency only for apply mode", () => {
    expect(
      publishAgentBlueprintInputSchema.safeParse({
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }).success,
    ).toBe(false);
    expect(
      publishAgentBlueprintInputSchema.safeParse({
        idempotencyKey: "preview-key",
        mode: "preview",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }).success,
    ).toBe(false);
  });

  it("keeps maximum catalog pages compact", () => {
    const page = listAgentBlueprintsResultSchema.parse({
      blueprints: Array.from({ length: 25 }, (_, index) => ({
        createdAt: "2026-01-01T00:00:00.000Z",
        currentVersion: 50,
        description: "d".repeat(320),
        id: `blueprint_00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        name: `blueprint-${index}-${"n".repeat(60)}`.slice(0, 80),
        package: { digest: "a".repeat(64), sizeBytes: MAXIMUM_AGENT_BLUEPRINT_PACKAGE_BYTES },
        publisher: { name: "p".repeat(80), url: "https://example.com" },
        status: "active",
        tags: Array.from({ length: 12 }, (_unusedTagSlot, tag) => `tag-${tag}`),
        updatedAt: "2026-01-01T00:00:00.000Z",
        versionCount: 50,
      })),
      nextCursor: null,
      ok: true,
    });

    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
      32 * 1_024,
    );
  });
});
