import {
  agentCapabilityConfigurationSchema,
  crewhelmStarterModelCatalog,
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  type AgentCapabilityConfiguration,
} from "@crewhelm/contracts";
import * as z from "zod";

import type { AgentCapabilityModule } from "./kernel.js";
import {
  inferenceConfigurationFields,
  inferenceProfileConfigurationSchema,
  resolveInferenceProfile,
  type InferenceProfileConfiguration,
} from "./inference-profile.js";

export const WORKERS_AI_BINDING_PREREQUISITE = "binding.ai";
export { WORKERS_AI_CAPABILITY_ID, WORKERS_AI_CAPABILITY_SCHEMA_VERSION };

export const workersAiCapabilityConfigurationSchema = inferenceProfileConfigurationSchema();

export function workersAiCapabilityConfiguration(
  primaryModel: z.infer<typeof workersAiCapabilityConfigurationSchema>["primaryModel"],
  options: Omit<InferenceProfileConfiguration, "primaryModel"> = { fallbackModels: [] },
): AgentCapabilityConfiguration {
  return agentCapabilityConfigurationSchema.parse({
    configuration: {
      fallbackModels: options.fallbackModels,
      primaryModel,
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.topP === undefined ? {} : { topP: options.topP }),
    },
    id: WORKERS_AI_CAPABILITY_ID,
    schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  });
}

export const workersAiCapabilityModule: AgentCapabilityModule<
  z.infer<typeof workersAiCapabilityConfigurationSchema>
> = {
  configurationSchema: workersAiCapabilityConfigurationSchema,
  defaultConfiguration: (context) =>
    workersAiCapabilityConfiguration(
      context.modelCatalog?.defaultModel ?? crewhelmStarterModelCatalog.defaultModel,
    ),
  descriptor: {
    configurationFields: inferenceConfigurationFields(),
    description:
      "Selects an ordered owner-enabled Cloudflare AI profile for Agent reasoning and tool orchestration.",
    id: WORKERS_AI_CAPABILITY_ID,
    prerequisites: [
      {
        description: "Cloudflare AI binding used for admitted model calls.",
        id: WORKERS_AI_BINDING_PREREQUISITE,
        kind: "binding",
      },
    ],
    schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    title: "Direct Cloudflare AI inference",
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  },
  migrate: (configuration) => {
    if (configuration.schemaVersion !== 1) {
      return undefined;
    }

    const legacy = z.strictObject({ model: z.string() }).safeParse(configuration.configuration);

    return legacy.success ? workersAiCapabilityConfiguration(legacy.data.model) : undefined;
  },
  resolve: (configuration, context) =>
    resolveInferenceProfile(configuration, context.modelCatalog ?? crewhelmStarterModelCatalog),
};
