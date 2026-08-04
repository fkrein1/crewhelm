import {
  agentCapabilityConfigurationSchema,
  crewhelmStarterModelCatalog,
  AI_GATEWAY_CAPABILITY_ID,
  AI_GATEWAY_CAPABILITY_SCHEMA_VERSION,
  type AgentCapabilityConfiguration,
} from "@crewhelm/contracts";
import type * as z from "zod";

import type { AgentCapabilityModule } from "./kernel.js";
import {
  inferenceConfigurationFields,
  inferenceProfileConfigurationSchema,
  resolveInferenceProfile,
  type InferenceProfileConfiguration,
} from "./inference-profile.js";

export const AI_GATEWAY_PREREQUISITE = "gateway.ai";
export { AI_GATEWAY_CAPABILITY_ID, AI_GATEWAY_CAPABILITY_SCHEMA_VERSION };

export const aiGatewayCapabilityConfigurationSchema = inferenceProfileConfigurationSchema();

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
  defaultConfiguration: () => undefined,
  descriptor: {
    configurationFields: inferenceConfigurationFields(),
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
    resolveInferenceProfile(configuration, context.modelCatalog ?? crewhelmStarterModelCatalog),
};
