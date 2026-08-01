import { AI_GATEWAY_PREREQUISITE, aiGatewayCapabilityModule } from "./ai-gateway.js";
import { AgentCapabilityRegistry } from "./kernel.js";
import { skillsCapabilityModule } from "./skills.js";
import { sandboxCodeCapabilityModule } from "./sandbox-code.js";
import { WORKERS_AI_BINDING_PREREQUISITE, workersAiCapabilityModule } from "./workers-ai.js";

export function availableAgentCapabilityPrerequisites(
  gatewayId?: string,
  sandboxAvailable = false,
): ReadonlySet<string> {
  return new Set([
    WORKERS_AI_BINDING_PREREQUISITE,
    ...(gatewayId === undefined || gatewayId.trim().length === 0 ? [] : [AI_GATEWAY_PREREQUISITE]),
    ...(sandboxAvailable ? ["cloudflare.sandbox"] : []),
  ]);
}

export const agentCapabilityRegistry = new AgentCapabilityRegistry([
  aiGatewayCapabilityModule,
  sandboxCodeCapabilityModule,
  skillsCapabilityModule,
  workersAiCapabilityModule,
]);
