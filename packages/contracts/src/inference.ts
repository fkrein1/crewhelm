import * as z from "zod";

export const DEFAULT_RUNNABLE_AGENT_MODEL = "@cf/zai-org/glm-4.7-flash";
export const CREWHELM_STARTER_AGENT_MODELS = [
  DEFAULT_RUNNABLE_AGENT_MODEL,
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/openai/gpt-oss-120b",
] as const;
export const MAXIMUM_INFERENCE_FALLBACKS = 2;

export const cloudflareAiModelIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(
    /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/,
    "Expected an exact Cloudflare AI provider/model identifier.",
  );

export const runnableAgentModelSchema = cloudflareAiModelIdSchema;
export const inferenceReasoningEffortSchema = z.enum(["low", "medium", "high"]);

export type RunnableAgentModel = z.infer<typeof runnableAgentModelSchema>;
export type InferenceReasoningEffort = z.infer<typeof inferenceReasoningEffortSchema>;
