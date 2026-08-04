import { DEFAULT_RUNNABLE_AGENT_MODEL, type RunnableAgentModel } from "@crewhelm/contracts";

import { AI_GATEWAY_PREREQUISITE, aiGatewayCapabilityModule } from "./ai-gateway.js";
import { AgentCapabilityRegistry } from "./kernel.js";
import { skillsCapabilityModule } from "./skills.js";
import { sandboxCodeCapabilityModule } from "./sandbox-code.js";
import { BRAVE_SEARCH_PREREQUISITE, webSearchCapabilityModule } from "./web-search.js";
import { webFetchCapabilityModule } from "./web-fetch.js";
import { WORKERS_AI_BINDING_PREREQUISITE, workersAiCapabilityModule } from "./workers-ai.js";

export function availableAgentCapabilityPrerequisites(
  gatewayId?: string,
  sandboxAvailable = false,
  braveSearchAvailable = false,
): ReadonlySet<string> {
  return new Set([
    WORKERS_AI_BINDING_PREREQUISITE,
    ...(gatewayId === undefined || gatewayId.trim().length === 0 ? [] : [AI_GATEWAY_PREREQUISITE]),
    ...(sandboxAvailable ? ["cloudflare.sandbox"] : []),
    ...(braveSearchAvailable ? [BRAVE_SEARCH_PREREQUISITE] : []),
  ]);
}

export function defaultAgentModelForPrerequisites(
  _prerequisites: ReadonlySet<string>,
): RunnableAgentModel {
  return DEFAULT_RUNNABLE_AGENT_MODEL;
}

export const agentCapabilityRegistry = new AgentCapabilityRegistry([
  aiGatewayCapabilityModule,
  sandboxCodeCapabilityModule,
  skillsCapabilityModule,
  webFetchCapabilityModule,
  webSearchCapabilityModule,
  workersAiCapabilityModule,
]);
