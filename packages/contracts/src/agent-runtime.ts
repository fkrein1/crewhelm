import * as z from "zod";

import {
  agentCapabilityGrantsSchema,
  agentExecutionLimitsSchema,
  agentIdSchema,
  agentInstructionsSchema,
  agentModelSchema,
  agentRevisionNumberSchema,
  ownerKeySchema,
} from "./control-plane.js";

export const crewAgentRuntimeConfigSchema = z.strictObject({
  agentId: agentIdSchema,
  capabilityGrants: agentCapabilityGrantsSchema,
  executionLimits: agentExecutionLimitsSchema,
  instructions: agentInstructionsSchema,
  model: agentModelSchema,
  ownerKey: ownerKeySchema,
  revision: agentRevisionNumberSchema,
});

export type CrewAgentRuntimeConfig = z.infer<typeof crewAgentRuntimeConfigSchema>;

export function crewAgentObjectName(
  configuration: Pick<CrewAgentRuntimeConfig, "agentId" | "ownerKey">,
): string {
  return `crew-agent:${configuration.ownerKey}:${configuration.agentId}`;
}
