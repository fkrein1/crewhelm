import { AgentCapabilityRegistry } from "./kernel.js";
import { WORKERS_AI_BINDING_PREREQUISITE, workersAiCapabilityModule } from "./workers-ai.js";

export const AVAILABLE_AGENT_CAPABILITY_PREREQUISITES = new Set([WORKERS_AI_BINDING_PREREQUISITE]);

export const agentCapabilityRegistry = new AgentCapabilityRegistry([workersAiCapabilityModule]);
