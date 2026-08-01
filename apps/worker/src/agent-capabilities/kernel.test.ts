import {
  DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
  DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  DEFAULT_AI_GATEWAY_AGENT_MODEL,
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
import {
  availableAgentCapabilityPrerequisites,
  defaultAgentModelForPrerequisites,
} from "./registry.js";
import {
  AI_GATEWAY_PREREQUISITE,
  aiGatewayCapabilityConfiguration,
  aiGatewayCapabilityModule,
} from "./ai-gateway.js";
import { skillsCapabilityConfiguration, skillsCapabilityModule } from "./skills.js";
import { sandboxCodeCapabilityConfiguration, sandboxCodeCapabilityModule } from "./sandbox-code.js";
import { webFetchCapabilityConfiguration, webFetchCapabilityModule } from "./web-fetch.js";
import {
  BRAVE_SEARCH_PREREQUISITE,
  webSearchCapabilityConfiguration,
  webSearchCapabilityModule,
} from "./web-search.js";
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
  it("defaults budgeted Gateway installations to Luna and keeps the Workers AI fallback", () => {
    expect(
      defaultAgentModelForPrerequisites(availableAgentCapabilityPrerequisites("crewhelm")),
    ).toBe(DEFAULT_AI_GATEWAY_AGENT_MODEL);
    expect(defaultAgentModelForPrerequisites(availableAgentCapabilityPrerequisites())).toBe(
      "@cf/zai-org/glm-4.7-flash",
    );
    expect(defaultAgentModelForPrerequisites(availableAgentCapabilityPrerequisites("   "))).toBe(
      "@cf/zai-org/glm-4.7-flash",
    );
  });

  it("compiles an AI Gateway profile with bounded fallbacks and sampling controls", () => {
    const registry = new AgentCapabilityRegistry([aiGatewayCapabilityModule]);
    const result = registry.compile(
      [
        aiGatewayCapabilityConfiguration("openai/gpt-5.6-luna", {
          fallbackModels: ["openai/gpt-5.6-sol"],
          reasoningEffort: "medium",
          temperature: 0.4,
          topP: 0.9,
        }),
      ],
      {
        availablePrerequisites: new Set([AI_GATEWAY_PREREQUISITE]),
        checkPrerequisites: true,
        fleetConfiguration,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      runtimePlan: {
        inference: {
          fallbackModels: ["openai/gpt-5.6-sol"],
          model: "openai/gpt-5.6-luna",
          moduleId: "inference.ai-gateway",
          reasoningEffort: "medium",
          schemaVersion: 1,
          temperature: 0.4,
          topP: 0.9,
        },
      },
    });
  });

  it("rejects unavailable Gateway infrastructure and invalid Workers AI profiles", () => {
    const gatewayRegistry = new AgentCapabilityRegistry([aiGatewayCapabilityModule]);
    const workersRegistry = new AgentCapabilityRegistry([workersAiCapabilityModule]);

    expect(
      gatewayRegistry.compile([aiGatewayCapabilityConfiguration("openai/gpt-5.6-luna")], {
        availablePrerequisites: new Set(),
        checkPrerequisites: true,
        fleetConfiguration,
      }),
    ).toEqual({
      code: "capability_unavailable",
      ok: false,
    });
    expect(
      workersRegistry.compile(
        [
          {
            configuration: {
              fallbackModels: ["@cf/meta/llama-4-scout-17b-16e-instruct"],
              primaryModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
            },
            id: "inference.workers-ai",
            schemaVersion: 2,
          },
        ],
        { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
      ),
    ).toEqual({ code: "invalid_configuration", ok: false });
    expect(
      workersRegistry.compile(
        [
          workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct", {
            fallbackModels: [],
            reasoningEffort: "high",
          }),
        ],
        { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
      ),
    ).toEqual({ code: "invalid_configuration", ok: false });
  });

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
          fallbackModels: [],
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          moduleId: "inference.workers-ai",
          schemaVersion: 2,
        },
        modules: [{ id: "inference.workers-ai", schemaVersion: 2 }],
        skillReferences: [],
        systemContext: [],
        tools: [],
      },
    });
  });

  it("freezes a bounded no-egress Sandbox tool into the runtime plan", () => {
    const registry = new AgentCapabilityRegistry([
      sandboxCodeCapabilityModule,
      workersAiCapabilityModule,
    ]);
    const result = registry.compile(
      [
        workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
        sandboxCodeCapabilityConfiguration({
          languages: ["python"],
          maxCodeBytes: 4_096,
          maxDurationMs: 5_000,
          maxOutputBytes: 16_384,
        }),
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
      {
        availablePrerequisites: new Set([WORKERS_AI_BINDING_PREREQUISITE, "cloudflare.sandbox"]),
        checkPrerequisites: true,
        fleetConfiguration,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      runtimePlan: {
        tools: [
          {
            effect: "local-compute",
            id: "sandbox.code",
            kind: "sandbox-code",
            languages: ["python"],
            limits: {
              maxCodeBytes: 4_096,
              maxDurationMs: 5_000,
              maxOutputBytes: 16_384,
            },
            moduleId: "tools.sandbox-code",
            network: "none",
            schemaVersion: 1,
          },
        ],
      },
    });
  });

  it("denies Sandbox configuration when its isolated runtime is unavailable", () => {
    const registry = new AgentCapabilityRegistry([
      sandboxCodeCapabilityModule,
      workersAiCapabilityModule,
    ]);

    expect(
      registry.compile(
        [
          workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
          sandboxCodeCapabilityConfiguration(),
        ].toSorted((left, right) => left.id.localeCompare(right.id)),
        { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
      ),
    ).toEqual({ code: "capability_unavailable", ok: false });
  });

  it("freezes separate search and controlled-fetch policies into the runtime plan", () => {
    const registry = new AgentCapabilityRegistry([
      webFetchCapabilityModule,
      webSearchCapabilityModule,
      workersAiCapabilityModule,
    ]);
    const capabilities = [
      workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
      webFetchCapabilityConfiguration({ maxRedirects: 1 }),
      webSearchCapabilityConfiguration({ maxResults: 4, safeSearch: "moderate" }),
    ].toSorted((left, right) => left.id.localeCompare(right.id));

    expect(
      registry.compile(capabilities, {
        availablePrerequisites: new Set([
          WORKERS_AI_BINDING_PREREQUISITE,
          BRAVE_SEARCH_PREREQUISITE,
        ]),
        checkPrerequisites: true,
        fleetConfiguration,
      }),
    ).toMatchObject({
      ok: true,
      runtimePlan: {
        tools: [
          { id: "web.fetch", kind: "web-fetch", limits: { maxRedirects: 1 } },
          {
            id: "web.search",
            kind: "web-search",
            limits: { maxResults: 4 },
            provider: "brave",
            safeSearch: "moderate",
          },
        ],
      },
    });
    expect(
      registry.compile(capabilities, {
        availablePrerequisites,
        checkPrerequisites: true,
        fleetConfiguration,
      }),
    ).toEqual({ code: "capability_unavailable", ok: false });
    expect(registry.catalog(new Set(), "tools.web-search")).toMatchObject([
      {
        availability: {
          missingPrerequisites: [BRAVE_SEARCH_PREREQUISITE],
          state: "unavailable",
        },
        prerequisites: [
          {
            setup: {
              command: "crewhelm up",
              requirement: "Brave Search API plan and CREWHELM_BRAVE_SEARCH_API_KEY",
            },
          },
        ],
      },
    ]);
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
            configuration: {
              fallbackModels: [],
              primaryModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
            },
            id: "inference.conflict",
            schemaVersion: 2,
          },
          workersAiCapabilityConfiguration("@cf/meta/llama-4-scout-17b-16e-instruct"),
        ],
        { availablePrerequisites, checkPrerequisites: true, fleetConfiguration },
      ),
    ).toEqual({ code: "capability_conflict", ok: false });
  });
});
