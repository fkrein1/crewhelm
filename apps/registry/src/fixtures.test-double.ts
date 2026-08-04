import type { RecipePackage, RegistrySkillPackage } from "@crewhelm/contracts";

export function recipeFixture(): RecipePackage {
  return {
    agent: {
      capabilities: [
        {
          configuration: {
            fallbackModels: ["@cf/openai/gpt-oss-20b"],
            primaryModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
          },
          id: "inference.workers-ai",
          schemaVersion: 2,
        },
      ],
      executionLimits: {
        maxDurationSeconds: 300,
        maxModelTokens: 50_000,
        maxToolCalls: 10,
        maxTurns: 8,
      },
      instructions: "Research the supplied topic and produce a concise, source-backed brief.",
      suggestedName: "Research brief steward",
    },
    connections: [],
    discovery: {
      description: "Research a topic and turn evidence into a decision-ready markdown brief.",
      license: "MIT",
      provenance: { kind: "authored" },
      tags: ["research", "writing"],
    },
    inputs: [
      {
        description: "The topic or decision to research.",
        kind: "invocation",
        name: "topic",
        required: true,
      },
    ],
    name: "research-brief-steward",
    operations: {
      eventTriggers: [],
      primary: {
        inputNames: ["topic"],
        kind: "run",
        name: "research-topic",
        outputContract: { kind: "markdown" },
        prompt: "Research the supplied topic and return a decision-ready brief with sources.",
      },
      schedules: [],
    },
    responsibility: {
      boundaries: ["Never fabricate a source."],
      outcome: "The owner receives a concise evidence-backed brief that supports a decision.",
      summary: "Turn focused research into a source-backed markdown brief.",
      title: "Research Brief Steward",
    },
    sampleDeliverable: {
      content: "# Recommendation\n\nProceed after validating the two material assumptions.",
      kind: "markdown",
    },
    schemaVersion: 1,
    setupParameters: [],
    skills: [],
  };
}

export function skillFixture(): RegistrySkillPackage {
  return {
    description: "A bounded method for weighing evidence and stating uncertainty.",
    files: [
      {
        content:
          "# Evidence review\n\nCompare independent sources and state uncertainty explicitly.",
        path: "SKILL.md",
      },
    ],
    license: "MIT",
    name: "evidence-review",
    provenance: { kind: "authored" },
    schemaVersion: 1,
  };
}
