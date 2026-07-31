import {
  agentCapabilityConfigurationSchema,
  AI_GATEWAY_AGENT_MODELS,
  AI_GATEWAY_CAPABILITY_ID,
  AI_GATEWAY_CAPABILITY_SCHEMA_VERSION,
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

export const AI_GATEWAY_PREREQUISITE = "gateway.ai";
export { AI_GATEWAY_CAPABILITY_ID, AI_GATEWAY_CAPABILITY_SCHEMA_VERSION };

const AI_GATEWAY_REASONING_MODELS = new Set(AI_GATEWAY_AGENT_MODELS);

export const aiGatewayCapabilityConfigurationSchema = inferenceProfileConfigurationSchema(
  AI_GATEWAY_AGENT_MODELS,
  AI_GATEWAY_REASONING_MODELS,
);

export function aiGatewayCapabilityConfiguration(
  primaryModel: z.infer<typeof aiGatewayCapabilityConfigurationSchema>["primaryModel"],
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
    id: AI_GATEWAY_CAPABILITY_ID,
    schemaVersion: AI_GATEWAY_CAPABILITY_SCHEMA_VERSION,
  });
}

export const aiGatewayCapabilityModule: AgentCapabilityModule<
  z.infer<typeof aiGatewayCapabilityConfigurationSchema>
> = {
  configurationSchema: aiGatewayCapabilityConfigurationSchema,
  defaultConfiguration: (fleetConfiguration) => {
    const model = z.enum(AI_GATEWAY_AGENT_MODELS).safeParse(fleetConfiguration.models.default);
    return model.success ? aiGatewayCapabilityConfiguration(model.data) : undefined;
  },
  descriptor: {
    configurationFields: inferenceConfigurationFields(AI_GATEWAY_AGENT_MODELS),
    description:
      "Selects an ordered third-party inference profile routed through Cloudflare AI Gateway.",
    id: AI_GATEWAY_CAPABILITY_ID,
    prerequisites: [
      {
        description: "Cloudflare AI Gateway with an installation-wide hard spend limit.",
        id: AI_GATEWAY_PREREQUISITE,
        kind: "resource",
      },
    ],
    schemaVersion: AI_GATEWAY_CAPABILITY_SCHEMA_VERSION,
    title: "AI Gateway inference",
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  },
  resolve: (configuration, context) =>
    resolveInferenceProfile(configuration, context.fleetConfiguration),
};
