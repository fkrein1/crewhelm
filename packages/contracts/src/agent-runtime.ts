import * as z from "zod";

import {
  agentCapabilityConfigurationsSchema,
  agentCapabilityModuleIdSchema,
  agentCapabilitySchemaVersionSchema,
} from "./agent-capabilities.js";
import {
  agentCapabilityGrantsSchema,
  agentExecutionLimitsSchema,
  agentIdSchema,
  agentInstructionsSchema,
  agentRevisionNumberSchema,
  ownerKeySchema,
} from "./control-plane.js";

export const agentRuntimePlanSchema = z.strictObject({
  inference: z.strictObject({
    model: z.string().min(1).max(160),
    moduleId: agentCapabilityModuleIdSchema,
    schemaVersion: agentCapabilitySchemaVersionSchema,
  }),
  modules: z
    .array(
      z.strictObject({
        id: agentCapabilityModuleIdSchema,
        schemaVersion: agentCapabilitySchemaVersionSchema,
      }),
    )
    .min(1)
    .max(16),
  systemContext: z
    .array(
      z.strictObject({
        moduleId: agentCapabilityModuleIdSchema,
        schemaVersion: agentCapabilitySchemaVersionSchema,
        text: z
          .string()
          .min(1)
          .max(8 * 1_024),
      }),
    )
    .max(16)
    .refine(
      (contributions) =>
        contributions.reduce((total, contribution) => total + contribution.text.length, 0) <=
        8 * 1_024,
      "System-context contributions exceed the runtime prompt budget.",
    ),
});

export const crewAgentRuntimeConfigSchema = z.strictObject({
  agentId: agentIdSchema,
  capabilities: agentCapabilityConfigurationsSchema,
  capabilityGrants: agentCapabilityGrantsSchema,
  executionLimits: agentExecutionLimitsSchema,
  instructions: agentInstructionsSchema,
  ownerKey: ownerKeySchema,
  revision: agentRevisionNumberSchema,
  runtimePlan: agentRuntimePlanSchema,
});

export type AgentRuntimePlan = z.infer<typeof agentRuntimePlanSchema>;
export type CrewAgentRuntimeConfig = z.infer<typeof crewAgentRuntimeConfigSchema>;

export function crewAgentSystemPrompt(
  configuration: Pick<CrewAgentRuntimeConfig, "instructions" | "runtimePlan">,
): string {
  return [
    configuration.instructions,
    ...configuration.runtimePlan.systemContext.map(({ text }) => text),
  ].join("\n\n");
}

export function crewAgentObjectName(
  configuration: Pick<CrewAgentRuntimeConfig, "agentId" | "ownerKey">,
): string {
  return `crew-agent:${configuration.ownerKey}:${configuration.agentId}`;
}
