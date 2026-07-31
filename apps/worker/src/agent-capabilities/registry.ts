import { AI_GATEWAY_PREREQUISITE, aiGatewayCapabilityModule } from "./ai-gateway.js";
import { AgentCapabilityRegistry } from "./kernel.js";
import { skillsCapabilityModule } from "./skills.js";
import { WORKERS_AI_BINDING_PREREQUISITE, workersAiCapabilityModule } from "./workers-ai.js";

export function availableAgentCapabilityPrerequisites(gatewayId?: string): ReadonlySet<string> {
  return new Set([
    WORKERS_AI_BINDING_PREREQUISITE,
    ...(gatewayId === undefined || gatewayId.trim().length === 0 ? [] : [AI_GATEWAY_PREREQUISITE]),
  ]);
}

export const agentCapabilityRegistry = new AgentCapabilityRegistry([
  aiGatewayCapabilityModule,
  skillsCapabilityModule,
  workersAiCapabilityModule,
]);
