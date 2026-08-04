import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";

import {
  createCloudflareOpenAIResponsesModel,
  isOpenAIResponsesModel,
} from "./openai-responses-model.js";

const callOptions = {
  prompt: [{ content: [{ text: "Find the forecast.", type: "text" }], role: "user" }],
  tools: [
    {
      description: "Read the forecast.",
      inputSchema: { additionalProperties: false, properties: {}, type: "object" },
      name: "weather",
      type: "function",
    },
  ],
} satisfies LanguageModelV4CallOptions;

describe("Cloudflare OpenAI Responses model", () => {
  it("routes an OpenAI catalog model through AI.run and preserves tool calls", async () => {
    const run = vi.fn<
      (
        model: string,
        input: Record<string, unknown>,
        options: { returnRawResponse: true; signal?: AbortSignal },
      ) => Promise<Response>
    >(async () =>
      Response.json({
        id: "resp_1",
        model: "gpt-5.6-luna",
        output: [
          {
            arguments: "{}",
            call_id: "call_1",
            id: "fc_1",
            name: "weather",
            type: "function_call",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    );
    const model = createCloudflareOpenAIResponsesModel({ run }, "openai/gpt-5.6-luna");

    const result = await model.doGenerate(callOptions);

    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: "{}",
          toolCallId: "call_1",
          toolName: "weather",
          type: "tool-call",
        }),
      ]),
    );
    expect(run).toHaveBeenCalledTimes(1);
    const [modelId, body, options] = run.mock.calls[0] ?? [];
    expect(modelId).toBe("openai/gpt-5.6-luna");
    expect(body).toMatchObject({
      input: expect.any(Array),
      tools: [expect.objectContaining({ name: "weather", type: "function" })],
    });
    expect(body).not.toHaveProperty("model");
    expect(options).toMatchObject({ returnRawResponse: true });
  });

  it("parses streamed Responses tool calls", async () => {
    const events = [
      {
        response: {
          created_at: 1,
          id: "resp_1",
          model: "gpt-5.6-luna",
          service_tier: null,
        },
        type: "response.created",
      },
      {
        item: {
          arguments: "",
          call_id: "call_1",
          caller: null,
          id: "fc_1",
          name: "weather",
          namespace: null,
          type: "function_call",
        },
        output_index: 0,
        type: "response.output_item.added",
      },
      {
        delta: "{}",
        item_id: "fc_1",
        output_index: 0,
        type: "response.function_call_arguments.delta",
      },
      {
        item: {
          arguments: "{}",
          call_id: "call_1",
          caller: null,
          id: "fc_1",
          name: "weather",
          namespace: null,
          status: "completed",
          type: "function_call",
        },
        output_index: 0,
        type: "response.output_item.done",
      },
      {
        response: {
          incomplete_details: null,
          reasoning: null,
          service_tier: null,
          usage: {
            input_tokens: 10,
            input_tokens_details: null,
            output_tokens: 4,
            output_tokens_details: null,
          },
        },
        type: "response.completed",
      },
    ];
    const streamBody = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    const run = vi.fn<() => Promise<Response>>(
      async () => new Response(streamBody, { headers: { "content-type": "text/event-stream" } }),
    );
    const model = createCloudflareOpenAIResponsesModel({ run }, "openai/gpt-5.6-luna");

    const result = await model.doStream(callOptions);
    const parts = [];
    for await (const part of result.stream) parts.push(part);

    expect(parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: "{}",
          toolCallId: "call_1",
          toolName: "weather",
          type: "tool-call",
        }),
      ]),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("selects only OpenAI catalog slugs", () => {
    expect(isOpenAIResponsesModel("openai/gpt-5.6-luna")).toBe(true);
    expect(isOpenAIResponsesModel("anthropic/claude-sonnet-5")).toBe(false);
    expect(() =>
      createCloudflareOpenAIResponsesModel(
        { run: vi.fn<() => Promise<Response>>(async () => new Response()) },
        "anthropic/claude-sonnet-5",
      ),
    ).toThrow("OpenAI catalog model ID");
  });
});
