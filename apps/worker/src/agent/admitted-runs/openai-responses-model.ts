import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";

type CloudflareAiRunBinding = {
  run(
    model: string,
    input: Record<string, unknown>,
    options: { returnRawResponse: true; signal?: AbortSignal },
  ): Promise<Response>;
};

export function isOpenAIResponsesModel(modelId: string): boolean {
  return modelId.startsWith("openai/");
}

export function createCloudflareOpenAIResponsesModel(
  binding: CloudflareAiRunBinding,
  modelId: string,
): LanguageModelV4 {
  if (!isOpenAIResponsesModel(modelId)) {
    throw new Error("Expected a Cloudflare OpenAI catalog model ID.");
  }

  const gatewayFetch: typeof fetch = async (_input, init) => {
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const parsedBody: unknown = JSON.parse(rawBody);
    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      throw new Error("OpenAI Responses request body was invalid.");
    }
    const body = Object.fromEntries(Object.entries(parsedBody));
    delete body.model;

    return binding.run(modelId, body, {
      returnRawResponse: true,
      ...(init?.signal === null || init?.signal === undefined ? {} : { signal: init.signal }),
    });
  };

  return createOpenAI({ apiKey: "unused", fetch: gatewayFetch }).responses(modelId);
}
