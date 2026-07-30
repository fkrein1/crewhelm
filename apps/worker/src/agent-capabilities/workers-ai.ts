import {
  agentCapabilityConfigurationSchema,
  agentRuntimePlanSchema,
  runnableAgentModelSchema,
  WORKERS_AI_CAPABILITY_ID,
  WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  type AgentCapabilityConfiguration,
  type AgentRuntimePlan,
} from "@crewhelm/contracts";
import * as z from "zod";

import type { AgentCapabilityModule } from "./kernel.js";

export const WORKERS_AI_BINDING_PREREQUISITE = "binding.ai";
export { WORKERS_AI_CAPABILITY_ID, WORKERS_AI_CAPABILITY_SCHEMA_VERSION };

export const workersAiCapabilityConfigurationSchema = z.strictObject({
  model: runnableAgentModelSchema,
});

export function workersAiCapabilityConfiguration(
  model: z.infer<typeof runnableAgentModelSchema>,
): AgentCapabilityConfiguration {
  return agentCapabilityConfigurationSchema.parse({
    configuration: { model },
    id: WORKERS_AI_CAPABILITY_ID,
    schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
  });
}

export function workersAiRuntimePlan(
  model: z.infer<typeof runnableAgentModelSchema>,
): AgentRuntimePlan {
  return agentRuntimePlanSchema.parse({
    inference: {
      model,
      moduleId: WORKERS_AI_CAPABILITY_ID,
      schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    },
    modules: [
      {
        id: WORKERS_AI_CAPABILITY_ID,
        schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
      },
    ],
    systemContext: [],
  });
}

export const workersAiCapabilityModule: AgentCapabilityModule<
  z.infer<typeof workersAiCapabilityConfigurationSchema>
> = {
  configurationSchema: workersAiCapabilityConfigurationSchema,
  defaultConfiguration: (fleetConfiguration) =>
    workersAiCapabilityConfiguration(fleetConfiguration.models.default),
  descriptor: {
    configurationFields: [
      {
        description: "Supported Workers AI model; the fleet policy may narrow this list.",
        enum: runnableAgentModelSchema.options,
        name: "model",
        required: true,
        type: "string",
      },
    ],
    description:
      "Selects the Cloudflare Workers AI model used for Agent reasoning and tool orchestration.",
    id: WORKERS_AI_CAPABILITY_ID,
    prerequisites: [
      {
        description: "Cloudflare Workers AI binding used for admitted model calls.",
        id: WORKERS_AI_BINDING_PREREQUISITE,
        kind: "binding",
      },
    ],
    schemaVersion: WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    title: "Workers AI inference",
    trust: {
      configuration: "untrusted-until-validated",
      runtimeContribution: "module-validated",
    },
  },
  resolve: (configuration, context) => {
    if (!context.fleetConfiguration.models.allowed.includes(configuration.model)) {
      return {
        code: "configuration_unavailable",
        ok: false,
      };
    }

    return {
      contributions: [
        {
          kind: "inference",
          model: configuration.model,
        },
      ],
      ok: true,
    };
  },
};
