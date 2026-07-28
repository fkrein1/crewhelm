import type { ThinkModel } from "@cloudflare/think";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";

import { CrewAgent } from "../src/crew-agent.js";

const TEST_REPLY = "Crewhelm completed the admitted test run.";
const LARGE_TEST_PROMPT = "Return an output larger than the retained character boundary.";
const SLOW_TEST_PROMPT = "Hold this test run beyond its deadline.";

interface TestModelCall {
  maxOutputTokens: number | undefined;
  prompt: unknown;
  toolCount: number;
}

export class TestCrewAgent extends CrewAgent {
  readonly #modelCalls: TestModelCall[] = [];
  #rejectNextCancellation = false;
  readonly #model = new MockLanguageModelV3({
    doStream: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });

      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { id: "test-text", type: "text-start" },
            {
              delta: JSON.stringify(options.prompt).includes(LARGE_TEST_PROMPT)
                ? "x".repeat(70_000)
                : TEST_REPLY,
              id: "test-text",
              type: "text-delta",
            },
            { id: "test-text", type: "text-end" },
            {
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage: {
                inputTokens: {
                  cacheRead: 0,
                  cacheWrite: 0,
                  noCache: 8,
                  total: 8,
                },
                outputTokens: {
                  reasoning: 0,
                  text: 7,
                  total: 7,
                },
              },
            },
          ],
          initialDelayInMs: JSON.stringify(options.prompt).includes(SLOW_TEST_PROMPT)
            ? 3_000
            : null,
        }),
      };
    },
  });

  override getModel(): ThinkModel {
    return this.#model;
  }

  modelCallsForTest(): TestModelCall[] {
    return structuredClone(this.#modelCalls);
  }

  failNextCancellationForTest(): void {
    this.#rejectNextCancellation = true;
  }

  protected override cancelAdmittedSubmission(runId: string, reason: string): Promise<void> {
    if (this.#rejectNextCancellation) {
      this.#rejectNextCancellation = false;
      return Promise.reject(new Error("Injected cancellation failure."));
    }

    return super.cancelAdmittedSubmission(runId, reason);
  }
}

export { LARGE_TEST_PROMPT, SLOW_TEST_PROMPT, TEST_REPLY };
