import * as z from "zod";

export const WORKERS_AI_AGENT_MODELS = [
  "@cf/ibm-granite/granite-4.0-h-micro",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.7-code",
  "@cf/openai/gpt-oss-20b",
  "@cf/openai/gpt-oss-120b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/zai-org/glm-5.2",
] as const;

export const AI_GATEWAY_AGENT_MODELS = [
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
] as const;

export const RUNNABLE_AGENT_MODELS = [
  ...WORKERS_AI_AGENT_MODELS,
  ...AI_GATEWAY_AGENT_MODELS,
] as const;

export const DEFAULT_RUNNABLE_AGENT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const MAXIMUM_INFERENCE_FALLBACKS = 2;

export const workersAiAgentModelSchema = z.enum(WORKERS_AI_AGENT_MODELS);
export const aiGatewayAgentModelSchema = z.enum(AI_GATEWAY_AGENT_MODELS);
export const runnableAgentModelSchema = z.enum(RUNNABLE_AGENT_MODELS);
export const inferenceReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export type RunnableAgentModel = z.infer<typeof runnableAgentModelSchema>;
export type InferenceReasoningEffort = z.infer<typeof inferenceReasoningEffortSchema>;
