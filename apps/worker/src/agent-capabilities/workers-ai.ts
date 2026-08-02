import {
  agentCapabilityConfigurationSchema,
  AI_GATEWAY_AGENT_MODELS,
  CLOUDFLARE_AI_AGENT_MODELS,
  DEFAULT_AI_GATEWAY_AGENT_MODEL,
  WORKERS_AI_AGENT_MODELS,
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  type AgentCapabilityConfiguration,
} from "@crewhelm/contracts";
import * as z from "zod";

import { AI_GATEWAY_PREREQUISITE } from "./ai-gateway.js";
import type { AgentCapabilityModule } from "./kernel.js";
import {
  inferenceConfigurationFields,
  inferenceProfileConfigurationSchema,
  resolveInferenceProfile,
  type InferenceProfileConfiguration,
} from "./inference-profile.js";

export const WORKERS_AI_BINDING_PREREQUISITE = "binding.ai";
export { WORKERS_AI_CAPABILITY_ID, WORKERS_AI_CAPABILITY_SCHEMA_VERSION };

const WORKERS_AI_REASONING_MODELS = new Set([
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-20b",
  "@cf/openai/gpt-oss-120b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
  "openai/gpt-5.6-luna",
]);

export const workersAiCapabilityConfigurationSchema = inferenceProfileConfigurationSchema(
  CLOUDFLARE_AI_AGENT_MODELS,
  WORKERS_AI_REASONING_MODELS,
);

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
  defaultConfiguration: (context) => {
    const gatewayModel = z
      .enum(AI_GATEWAY_AGENT_MODELS)
      .safeParse(context.fleetConfiguration.models.default);

    if (
      gatewayModel.success &&
      (gatewayModel.data !== DEFAULT_AI_GATEWAY_AGENT_MODEL ||
        context.availablePrerequisites.has(AI_GATEWAY_PREREQUISITE))
    ) {
      return undefined;
    }

    const model = z
      .enum(CLOUDFLARE_AI_AGENT_MODELS)
      .safeParse(context.fleetConfiguration.models.default);
    return model.success ? workersAiCapabilityConfiguration(model.data) : undefined;
  },
  descriptor: {
    configurationFields: inferenceConfigurationFields(CLOUDFLARE_AI_AGENT_MODELS),
    description:
      "Selects an ordered direct Cloudflare AI profile for Agent reasoning and tool orchestration.",
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

    const legacy = z
      .strictObject({ model: z.enum(WORKERS_AI_AGENT_MODELS) })
      .safeParse(configuration.configuration);

    return legacy.success ? workersAiCapabilityConfiguration(legacy.data.model) : undefined;
  },
  resolve: (configuration, context) =>
    resolveInferenceProfile(configuration, context.fleetConfiguration),
};
