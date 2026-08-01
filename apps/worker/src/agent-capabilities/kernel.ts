import {
  agentCapabilityConfigurationsSchema,
  agentCapabilityDescriptorSchema,
  agentRuntimePlanSchema,
  type AgentCapabilityConfiguration,
  type AgentCapabilityConfigurations,
  type AgentCapabilityDescriptor,
  type AgentRuntimePlan,
  type FleetConfigurationData,
} from "@crewhelm/contracts";
import type * as z from "zod";

export type CapabilityCompilationContext = {
  availablePrerequisites: ReadonlySet<string>;
  checkPrerequisites: boolean;
  fleetConfiguration: FleetConfigurationData;
};

type RuntimeTool = NonNullable<AgentRuntimePlan["tools"]>[number];
type RuntimeToolContribution = RuntimeTool extends infer Tool
  ? Tool extends RuntimeTool
    ? Omit<Tool, "moduleId" | "schemaVersion">
    : never
  : never;

export type CapabilityRuntimeContribution =
  | {
      kind: "inference";
      profile: Omit<AgentRuntimePlan["inference"], "moduleId" | "schemaVersion">;
    }
  | {
      kind: "system-context";
      text: string;
    }
  | {
      kind: "skill-reference";
      skill: {
        id: string;
        version: number;
      };
    }
  | {
      kind: "runtime-tool";
      tool: RuntimeToolContribution;
    };

export type CapabilityModuleResolution =
  | {
      code: "configuration_unavailable";
      ok: false;
    }
  | {
      contributions: readonly CapabilityRuntimeContribution[];
      ok: true;
    };

type CapabilityModuleDescriptor = Omit<AgentCapabilityDescriptor, "availability">;

export type AgentCapabilityModule<Configuration> = {
  configurationSchema: z.ZodType<Configuration>;
  defaultConfiguration?(
    fleetConfiguration: FleetConfigurationData,
  ): AgentCapabilityConfiguration | undefined;
  descriptor: CapabilityModuleDescriptor;
  migrate?(configuration: AgentCapabilityConfiguration): AgentCapabilityConfiguration | undefined;
  resolve(
    configuration: Configuration,
    context: CapabilityCompilationContext,
  ): CapabilityModuleResolution;
};

type CapabilityFailureCode =
  | "capability_conflict"
  | "capability_unavailable"
  | "invalid_configuration"
  | "missing_required_capability"
  | "unknown_capability";

export type CapabilityCompilationResult =
  | {
      capabilities: AgentCapabilityConfigurations;
      ok: true;
      runtimePlan: AgentRuntimePlan;
    }
  | {
      code: "configuration_unavailable";
      moduleId: string;
      ok: false;
    }
  | {
      code: CapabilityFailureCode;
      ok: false;
    };

function unavailableDescriptor(
  module: AgentCapabilityModule<unknown>,
  availablePrerequisites: ReadonlySet<string>,
): AgentCapabilityDescriptor {
  const missingPrerequisites = module.descriptor.prerequisites
    .map(({ id }) => id)
    .filter((id) => !availablePrerequisites.has(id))
    .toSorted();

  return agentCapabilityDescriptorSchema.parse({
    ...module.descriptor,
    availability: {
      missingPrerequisites,
      state: missingPrerequisites.length === 0 ? "available" : "unavailable",
    },
  });
}

export class AgentCapabilityRegistry {
  readonly #modules: ReadonlyMap<string, AgentCapabilityModule<unknown>>;

  constructor(modules: readonly AgentCapabilityModule<unknown>[]) {
    const byId = new Map<string, AgentCapabilityModule<unknown>>();

    for (const module of modules) {
      if (byId.has(module.descriptor.id)) {
        throw new Error(`Duplicate Agent capability module: ${module.descriptor.id}`);
      }

      byId.set(module.descriptor.id, module);
    }

    this.#modules = byId;
  }

  catalog(availablePrerequisites: ReadonlySet<string>, id?: string): AgentCapabilityDescriptor[] {
    const descriptors = [...this.#modules.values()]
      .filter((module) => id === undefined || module.descriptor.id === id)
      .map((module) => unavailableDescriptor(module, availablePrerequisites))
      .toSorted((left, right) => left.id.localeCompare(right.id));

    return descriptors;
  }

  compile(
    input: AgentCapabilityConfigurations | undefined,
    context: CapabilityCompilationContext,
  ): CapabilityCompilationResult {
    const candidate =
      input ??
      [...this.#modules.values()]
        .flatMap((module) => {
          const configuration = module.defaultConfiguration?.(context.fleetConfiguration);

          return configuration === undefined ? [] : [configuration];
        })
        .toSorted((left, right) => left.id.localeCompare(right.id));
    const parsedEnvelope = agentCapabilityConfigurationsSchema.safeParse(candidate);

    if (!parsedEnvelope.success) {
      return { code: "invalid_configuration", ok: false };
    }

    let inference: AgentRuntimePlan["inference"] | undefined;
    const modules: AgentRuntimePlan["modules"] = [];
    const skillReferences: AgentRuntimePlan["skillReferences"] = [];
    const systemContext: AgentRuntimePlan["systemContext"] = [];
    const tools: NonNullable<AgentRuntimePlan["tools"]> = [];
    const canonicalCapabilities: AgentCapabilityConfiguration[] = [];

    for (const persistedCapability of parsedEnvelope.data) {
      let capability = persistedCapability;
      const module = this.#modules.get(capability.id);

      if (module === undefined) {
        return { code: "unknown_capability", ok: false };
      }

      if (capability.schemaVersion !== module.descriptor.schemaVersion) {
        const migratedCapability = module.migrate?.(capability);

        if (
          migratedCapability === undefined ||
          migratedCapability.id !== module.descriptor.id ||
          migratedCapability.schemaVersion !== module.descriptor.schemaVersion
        ) {
          return { code: "invalid_configuration", ok: false };
        }

        capability = migratedCapability;
      }

      if (
        context.checkPrerequisites &&
        module.descriptor.prerequisites.some(({ id }) => !context.availablePrerequisites.has(id))
      ) {
        return { code: "capability_unavailable", ok: false };
      }

      const parsedConfiguration = module.configurationSchema.safeParse(capability.configuration);

      if (!parsedConfiguration.success) {
        return { code: "invalid_configuration", ok: false };
      }

      const resolution = module.resolve(parsedConfiguration.data, context);

      if (!resolution.ok) {
        return {
          code: resolution.code,
          moduleId: capability.id,
          ok: false,
        };
      }

      for (const contribution of resolution.contributions) {
        if (contribution.kind === "inference") {
          if (inference !== undefined) {
            return { code: "capability_conflict", ok: false };
          }

          inference = {
            ...contribution.profile,
            moduleId: capability.id,
            schemaVersion: capability.schemaVersion,
          };
        } else if (contribution.kind === "system-context") {
          systemContext.push({
            moduleId: capability.id,
            schemaVersion: capability.schemaVersion,
            text: contribution.text,
          });
        } else if (contribution.kind === "skill-reference") {
          skillReferences.push({
            ...contribution.skill,
            moduleId: capability.id,
            schemaVersion: capability.schemaVersion,
          });
        } else {
          tools.push({
            ...contribution.tool,
            moduleId: capability.id,
            schemaVersion: capability.schemaVersion,
          });
        }
      }

      modules.push({
        id: capability.id,
        schemaVersion: capability.schemaVersion,
      });
      canonicalCapabilities.push(capability);
    }

    if (inference === undefined) {
      return { code: "missing_required_capability", ok: false };
    }

    return {
      capabilities: agentCapabilityConfigurationsSchema.parse(canonicalCapabilities),
      ok: true,
      runtimePlan: agentRuntimePlanSchema.parse({
        inference,
        modules,
        skillReferences,
        systemContext,
        tools: tools.toSorted((left, right) => left.id.localeCompare(right.id)),
      }),
    };
  }
}
