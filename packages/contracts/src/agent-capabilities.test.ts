import { describe, expect, it } from "vitest";

import {
  MAXIMUM_AGENT_CAPABILITY_CONFIGURATION_BYTES,
  agentCapabilityConfigurationsSchema,
} from "./agent-capabilities.js";

describe("Agent capability contracts", () => {
  it("accepts canonical bounded module configuration", () => {
    expect(
      agentCapabilityConfigurationsSchema.parse([
        {
          configuration: {
            enabled: true,
            model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          },
          id: "inference.workers-ai",
          schemaVersion: 1,
        },
      ]),
    ).toHaveLength(1);
  });

  it("accepts bounded nested configuration for resource references", () => {
    expect(
      agentCapabilityConfigurationsSchema.parse([
        {
          configuration: {
            skills: [
              {
                id: "skill_00000000-0000-4000-8000-000000000001",
                version: 1,
              },
            ],
          },
          id: "context.skills",
          schemaVersion: 1,
        },
      ]),
    ).toHaveLength(1);
  });

  it.each([
    [
      "duplicate or unordered IDs",
      [
        { configuration: {}, id: "module.second", schemaVersion: 1 },
        { configuration: {}, id: "module.first", schemaVersion: 1 },
      ],
    ],
    [
      "non-JSON values",
      [
        {
          configuration: { callback: () => undefined },
          id: "module.invalid",
          schemaVersion: 1,
        },
      ],
    ],
    [
      "oversized module configuration",
      [
        {
          configuration: {
            value: "x".repeat(MAXIMUM_AGENT_CAPABILITY_CONFIGURATION_BYTES),
          },
          id: "module.large",
          schemaVersion: 1,
        },
      ],
    ],
    [
      "deeply nested module configuration",
      [
        {
          configuration: { first: { second: { third: { fourth: true } } } },
          id: "module.deep",
          schemaVersion: 1,
        },
      ],
    ],
  ])("rejects %s", (_label, capabilities) => {
    expect(agentCapabilityConfigurationsSchema.safeParse(capabilities).success).toBe(false);
  });
});
