import {
  APICallError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
  type LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { createInferenceFallbackModel, type InferenceAttemptEvent } from "./inference-fallback.js";

const callOptions = { prompt: [] } satisfies LanguageModelV4CallOptions;

function providerFailure(statusCode = 503): APICallError {
  return new APICallError({
    isRetryable: statusCode >= 500 || statusCode === 408 || statusCode === 429,
    message: "provider unavailable",
    requestBodyValues: {},
    statusCode,
    url: "https://provider.invalid",
  });
}

function stream(...chunks: LanguageModelV4StreamPart[]): LanguageModelV4StreamResult {
  return {
    stream: simulateReadableStream({ chunks }),
  };
}

async function consume(model: ReturnType<typeof createInferenceFallbackModel>) {
  const result = await model.doStream(callOptions);
  const parts = [];
  const reader = result.stream.getReader();

  while (true) {
    const next = await reader.read();

    if (next.done) {
      return parts;
    }

    parts.push(next.value);
  }
}

function fixture(primary: MockLanguageModelV4, fallback: MockLanguageModelV4) {
  const events: InferenceAttemptEvent[] = [];
  const beforeAttempt = vi.fn<(attemptIndex: number) => Promise<number>>(
    async (attemptIndex) => attemptIndex + 1,
  );
  const model = createInferenceFallbackModel({
    attempts: [
      { model: primary, modelId: "primary" },
      { model: fallback, modelId: "fallback" },
    ],
    beforeAttempt,
    recordEvent: async (event) => {
      events.push(event);
    },
  });

  return { beforeAttempt, events, model };
}

describe("inference fallback", () => {
  it("generates with the next model after a retryable rate limit", async () => {
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        throw providerFailure(429);
      },
    });
    const fallback = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "fallback", type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      },
    });
    const test = fixture(primary, fallback);

    await expect(test.model.doGenerate(callOptions)).resolves.toEqual(
      expect.objectContaining({ content: expect.any(Array) }),
    );
    expect(primary.doGenerateCalls).toHaveLength(1);
    expect(fallback.doGenerateCalls).toHaveLength(1);
    expect(test.events).toEqual([
      {
        event: "inference.attempt_failed",
        model: "primary",
        modelCall: 1,
        reason: "rate_limited",
      },
      {
        event: "inference.model_selected",
        model: "fallback",
        modelCall: 2,
      },
    ]);
  });

  it("preserves the final provider error after ordered fallback exhaustion", async () => {
    const primaryFailure = providerFailure(408);
    const fallbackFailure = providerFailure(503);
    const primary = new MockLanguageModelV4({
      doGenerate: async () => {
        throw primaryFailure;
      },
    });
    const fallback = new MockLanguageModelV4({
      doGenerate: async () => {
        throw fallbackFailure;
      },
    });
    const test = fixture(primary, fallback);

    await expect(test.model.doGenerate(callOptions)).rejects.toBe(fallbackFailure);
    expect(test.events).toEqual([
      {
        event: "inference.attempt_failed",
        model: "primary",
        modelCall: 1,
        reason: "timeout",
      },
      {
        event: "inference.attempt_failed",
        model: "fallback",
        modelCall: 2,
        reason: "provider_unavailable",
      },
    ]);
  });

  it("falls back when a retryable provider failure arrives before semantic output", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () =>
        stream({ type: "stream-start", warnings: [] }, { error: providerFailure(), type: "error" }),
    });
    const fallback = new MockLanguageModelV4({
      doStream: async () =>
        stream(
          { type: "stream-start", warnings: [] },
          { id: "answer", type: "text-start" },
          { delta: "ok", id: "answer", type: "text-delta" },
        ),
    });
    const test = fixture(primary, fallback);

    await expect(consume(test.model)).resolves.toMatchObject([
      { type: "stream-start" },
      { id: "answer", type: "text-start" },
      { delta: "ok", type: "text-delta" },
    ]);
    expect(test.beforeAttempt).toHaveBeenCalledTimes(2);
    expect(test.events).toEqual([
      {
        event: "inference.attempt_failed",
        model: "primary",
        modelCall: 1,
        reason: "provider_unavailable",
      },
      {
        event: "inference.model_selected",
        model: "fallback",
        modelCall: 2,
      },
    ]);
  });

  it("does not switch models after semantic output begins", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () =>
        stream({ id: "answer", type: "text-start" }, { error: providerFailure(), type: "error" }),
    });
    const fallback = new MockLanguageModelV4();
    const test = fixture(primary, fallback);

    await expect(consume(test.model)).resolves.toMatchObject([
      { id: "answer", type: "text-start" },
      { type: "error" },
    ]);
    expect(test.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(test.events).toEqual([
      {
        event: "inference.model_selected",
        model: "primary",
        modelCall: 1,
      },
    ]);
  });

  it("does not retry a rejected request", async () => {
    const failure = providerFailure(400);
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        throw failure;
      },
    });
    const test = fixture(primary, new MockLanguageModelV4());

    await expect(test.model.doStream(callOptions)).rejects.toBe(failure);
    expect(test.beforeAttempt).toHaveBeenCalledTimes(1);
    expect(test.events).toEqual([]);
  });

  it("preserves abort errors without selecting a fallback", async () => {
    const aborted = new DOMException("inference cancelled", "AbortError");
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        throw aborted;
      },
    });
    const fallback = new MockLanguageModelV4();
    const test = fixture(primary, fallback);

    await expect(test.model.doStream(callOptions)).rejects.toBe(aborted);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(test.events).toEqual([]);
  });

  it("does not call the fallback when its budget claim is denied", async () => {
    const primary = new MockLanguageModelV4({
      doStream: async () => {
        throw providerFailure();
      },
    });
    const fallback = new MockLanguageModelV4();
    const denied = new Error("budget denied");
    const events: InferenceAttemptEvent[] = [];
    const model = createInferenceFallbackModel({
      attempts: [
        { model: primary, modelId: "primary" },
        { model: fallback, modelId: "fallback" },
      ],
      beforeAttempt: async (attemptIndex) => {
        if (attemptIndex === 1) {
          throw denied;
        }

        return 1;
      },
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    await expect(model.doStream(callOptions)).rejects.toBe(denied);
    expect(fallback.doStreamCalls).toHaveLength(0);
    expect(events).toEqual([
      {
        event: "inference.attempt_failed",
        model: "primary",
        modelCall: 1,
        reason: "provider_unavailable",
      },
    ]);
  });
});
