import {
  inferenceReasoningEffortSchema,
  agentModelSchema,
  MAXIMUM_INFERENCE_FALLBACKS,
  type AgentRuntimePlan,
  type AgentCapabilityDescriptor,
  type ModelCatalogData,
} from "@crewhelm/contracts";
import * as z from "zod";

import type { CapabilityModuleResolution } from "./kernel.js";

export function inferenceProfileConfigurationSchema(): z.ZodType<InferenceProfileConfiguration> {
  return z
    .strictObject({
      fallbackModels: z.array(agentModelSchema).max(MAXIMUM_INFERENCE_FALLBACKS).default([]),
      primaryModel: agentModelSchema,
      reasoningEffort: inferenceReasoningEffortSchema.optional(),
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
    })
    .superRefine((profile, context) => {
      const attemptOrder = [profile.primaryModel, ...profile.fallbackModels];

      if (new Set(attemptOrder).size !== attemptOrder.length) {
        context.addIssue({
          code: "custom",
          message: "Inference attempt models must be unique.",
          path: ["fallbackModels"],
        });
      }
    });
}

export type InferenceProfileConfiguration = {
  fallbackModels: string[];
  primaryModel: string;
  reasoningEffort?: "low" | "medium" | "high" | undefined;
  temperature?: number | undefined;
  topP?: number | undefined;
};

export function inferenceRuntimeProfile(
  profile: InferenceProfileConfiguration,
): Omit<AgentRuntimePlan["inference"], "moduleId" | "schemaVersion"> {
  return {
    fallbackModels: profile.fallbackModels,
    model: profile.primaryModel,
    ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
    ...(profile.temperature === undefined ? {} : { temperature: profile.temperature }),
    ...(profile.topP === undefined ? {} : { topP: profile.topP }),
  };
}

export function resolveInferenceProfile(
  profile: InferenceProfileConfiguration,
  modelCatalog: ModelCatalogData,
): CapabilityModuleResolution {
  const attemptOrder = [profile.primaryModel, ...profile.fallbackModels];

  if (
    attemptOrder.some(
      (model) => !modelCatalog.enabledModels.some((enabledModel) => enabledModel === model),
    )
  ) {
    return {
      code: "model_disabled",
      ok: false,
    };
  }

  return {
    contributions: [
      {
        kind: "inference",
        profile: inferenceRuntimeProfile(profile),
      },
    ],
    ok: true,
  };
}

export function inferenceConfigurationFields(): AgentCapabilityDescriptor["configurationFields"] {
  return [
    {
      description: "Exact owner-enabled Cloudflare AI model ID selected for each model turn.",
      name: "primaryModel",
      required: true,
      type: "string" as const,
    },
    {
      description: "Ordered unique fallback models tried only before an attempt emits output.",
      name: "fallbackModels",
      required: false,
      type: "list" as const,
    },
    {
      description: "Optional reasoning effort; every configured model must support it.",
      enum: [...inferenceReasoningEffortSchema.options],
      name: "reasoningEffort",
      required: false,
      type: "string" as const,
    },
    {
      description: "Optional sampling temperature from 0 through 2.",
      name: "temperature",
      required: false,
      type: "number" as const,
    },
    {
      description:
        "Optional nucleus-sampling probability greater than or equal to 0 and at most 1.",
      name: "topP",
      required: false,
      type: "number" as const,
    },
  ];
}
