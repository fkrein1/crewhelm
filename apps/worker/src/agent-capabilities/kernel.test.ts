import {
  DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
  DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  RUNNABLE_AGENT_MODELS,
  defaultFleetCapacity,
  defaultFleetExecutionLimits,
  defaultFleetRetention,
  crewAgentSystemPrompt,
  fleetConfigurationDataSchema,
} from "@crewhelm/contracts";
import { describe, expect, it } from "vitest";
import * as z from "zod";

import { AgentCapabilityRegistry, type AgentCapabilityModule } from "./kernel.js";
import { skillsCapabilityConfiguration, skillsCapabilityModule } from "./skills.js";
import {
  WORKERS_AI_BINDING_PREREQUISITE,
  workersAiCapabilityConfiguration,
  workersAiCapabilityModule,
} from "./workers-ai.js";

const fleetConfiguration = fleetConfigurationDataSchema.parse({
  capacity: defaultFleetCapacity,
  execution: defaultFleetExecutionLimits,
  integrations: {
    callsPerDay: DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
    callsPerThirtyDays: DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
    duplicateToolCallLimit: DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
    maxCallsPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
    maxCallsPerToolPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
    maxConcurrencyPerGrant: DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
  },
  models: {
    allowed: [...RUNNABLE_AGENT_MODELS].toSorted(),
    default: "@cf/meta/llama-4-scout-17b-16e-instruct",
  },
  retention: defaultFleetRetention,
  schedules: {
    minimumIntervalSeconds: DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  },
});
const availablePrerequisites = new Set([WORKERS_AI_BINDING_PREREQUISITE]);

function contextModule(id = "context.test"): AgentCapabilityModule<{ text: string }> {
  return {
    configurationSchema: z.strictObject({ text: z.string().min(1).max(100) }),
    descriptor: {
      configurationFields: [
        {
          description: "Static context used only to prove a non-inference contribution.",
          name: "text",
          required: true,
          type: "string",
        },
      ],
      description: "Test-only system context capability.",
      id,
      prerequisites: [],
      schemaVersion: 1,
      title: "Test context",
      trust: {
        configuration: "untrusted-until-validated",
        runtimeContribution: "module-validated",
      },
    },
    resolve(configuration) {
      return {
        contributions: [{ kind: "system-context", text: configuration.text }],
        ok: true,
      };
    },
  };
}

describe("Agent capability registry", () => {
  it("defaults and compiles Workers AI into a deterministic runtime plan", () => {
    const registry = new AgentCapabilityRegistry([workersAiCapabilityModule]);
    const result = registry.compile(undefined, {
      availablePrerequisites,
      checkPrerequisites: true,
      fleetConfiguration,
    });

    expect(result).toEqual({
      capabilities: [workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct")],
      ok: true,
      runtimePlan: {
        inference: {
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          moduleId: "inference.workers-ai",
          schemaVersion: 1,
        },
        modules: [{ id: "inference.workers-ai", schemaVersion: 1 }],
        skillReferences: [],
        systemContext: [],
      },
    });
  });

  it("accepts another contribution shape without changing the kernel", () => {
    const registry = new AgentCapabilityRegistry([contextModule(), workersAiCapabilityModule]);
    const result = registry.compile(
      [
        {
          configuration: { text: "Owner-authored operating context." },
          id: "context.test",
          schemaVersion: 1,
        },
        workersAiCapabilityConfiguration("@cf/zai-org/glm-4.7-flash"),
      ],
      { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
    );

    expect(result).toMatchObject({
      ok: true,
      runtimePlan: {
        inference: { model: "@cf/zai-org/glm-4.7-flash" },
        systemContext: [
          {
            moduleId: "context.test",
            text: "Owner-authored operating context.",
          },
        ],
      },
    });
    if (!result.ok) {
      throw new Error("Expected test context compilation.");
    }
    expect(
      crewAgentSystemPrompt({
        instructions: "Base Agent instructions.",
        runtimePlan: result.runtimePlan,
      }),
    ).toBe("Base Agent instructions.\n\nOwner-authored operating context.");
  });

  it("compiles exact Skill references without loading package contents", () => {
    const registry = new AgentCapabilityRegistry([
      skillsCapabilityModule,
      workersAiCapabilityModule,
    ]);
    const reference = {
      id: "skill_00000000-0000-4000-8000-000000000001",
      version: 2,
    };
    const result = registry.compile(
      [
        skillsCapabilityConfiguration([reference]),
        workersAiCapabilityConfiguration("@cf/zai-org/glm-4.7-flash"),
      ],
      { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
    );

    expect(result).toMatchObject({
      ok: true,
      runtimePlan: {
        skillReferences: [
          {
            ...reference,
            moduleId: "context.skills",
            schemaVersion: 1,
          },
        ],
      },
    });
    if (!result.ok) {
      throw new Error("Expected Skill capability compilation.");
    }
    expect(result.capabilities[0]).toEqual({
      configuration: { skills: [reference] },
      id: "context.skills",
      schemaVersion: 1,
    });
    expect(JSON.stringify(result)).not.toContain("SKILL.md");
  });

  it("stores valid configuration before runtime prerequisites become available", () => {
    const registry = new AgentCapabilityRegistry([workersAiCapabilityModule]);

    expect(
      registry.compile(
        [workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct")],
        {
          availablePrerequisites: new Set(),
          checkPrerequisites: false,
          fleetConfiguration,
        },
      ),
    ).toMatchObject({ ok: true });
  });

  it("attributes policy unavailability to the module that owns the configuration", () => {
    const registry = new AgentCapabilityRegistry([workersAiCapabilityModule]);
    const restrictedFleetConfiguration = fleetConfigurationDataSchema.parse({
      ...fleetConfiguration,
      models: {
        allowed: ["@cf/meta/llama-4-scout-17b-16e-instruct"],
        default: "@cf/meta/llama-4-scout-17b-16e-instruct",
      },
    });

    expect(
      registry.compile([workersAiCapabilityConfiguration("@cf/zai-org/glm-4.7-flash")], {
        availablePrerequisites,
        checkPrerequisites: true,
        fleetConfiguration: restrictedFleetConfiguration,
      }),
    ).toEqual({
      code: "configuration_unavailable",
      moduleId: "inference.workers-ai",
      ok: false,
    });
  });

  it("lets the owning module migrate older configuration before planning", () => {
    const migratingContext = contextModule("context.migrated");
    migratingContext.descriptor.schemaVersion = 2;
    migratingContext.migrate = (configuration) =>
      configuration.schemaVersion === 1 ? { ...configuration, schemaVersion: 2 } : undefined;
    const registry = new AgentCapabilityRegistry([migratingContext, workersAiCapabilityModule]);
    const result = registry.compile(
      [
        {
          configuration: { text: "Migrated context." },
          id: "context.migrated",
          schemaVersion: 1,
        },
        workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
      ],
      { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
    );

    expect(result).toMatchObject({
      ok: true,
      runtimePlan: {
        systemContext: [
          {
            moduleId: "context.migrated",
            schemaVersion: 2,
            text: "Migrated context.",
          },
        ],
      },
    });
    if (!result.ok) {
      throw new Error("Expected migrated capability plan.");
    }
    expect(result.capabilities[0]).toMatchObject({
      id: "context.migrated",
      schemaVersion: 2,
    });
  });

  it.each([
    {
      capabilities: [
        {
          configuration: { model: "@cf/example/unknown" },
          id: "inference.workers-ai",
          schemaVersion: 1,
        },
      ],
      code: "invalid_configuration",
      prerequisites: availablePrerequisites,
    },
    {
      capabilities: [
        {
          configuration: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" },
          id: "inference.unknown",
          schemaVersion: 1,
        },
      ],
      code: "unknown_capability",
      prerequisites: availablePrerequisites,
    },
    {
      capabilities: [workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct")],
      code: "capability_unavailable",
      prerequisites: new Set<string>(),
    },
  ])("rejects $code without producing a partial plan", ({ capabilities, code, prerequisites }) => {
    const registry = new AgentCapabilityRegistry([workersAiCapabilityModule]);

    expect(
      registry.compile(capabilities, {
        availablePrerequisites: prerequisites,
        checkPrerequisites: true,
        fleetConfiguration,
      }),
    ).toEqual({ code, ok: false });
  });

  it("rejects singleton contribution collisions deterministically", () => {
    const conflictingInference = {
      ...workersAiCapabilityModule,
      descriptor: {
        ...workersAiCapabilityModule.descriptor,
        id: "inference.conflict",
      },
    };
    const registry = new AgentCapabilityRegistry([conflictingInference, workersAiCapabilityModule]);

    expect(
      registry.compile(
        [
          {
            configuration: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" },
            id: "inference.conflict",
            schemaVersion: 1,
          },
          workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
        ],
        { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
      ),
    ).toEqual({ code: "capability_conflict", ok: false });
  });
});
