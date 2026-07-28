import {
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import type { ThinkModel } from "@cloudflare/think";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import * as z from "zod";

import { CrewAgent, type CrewAgentToolAdapter } from "../src/crew-agent.js";

const TEST_REPLY = "Crewhelm completed the admitted test run.";
const LARGE_TEST_PROMPT = "Return an output larger than the retained character boundary.";
const SLOW_TEST_PROMPT = "Hold this test run beyond its deadline.";
const TOOL_TEST_PROMPT = "Use the exact admitted test tool.";
const TEST_TOOL_NAME = "projectToolkitReadItem";

interface TestModelCall {
  maxOutputTokens: number | undefined;
  prompt: unknown;
  toolCount: number;
}

export class TestCrewAgent extends CrewAgent {
  readonly #modelCalls: TestModelCall[] = [];
  readonly #toolExecutions: unknown[] = [];
  #rejectNextCancellation = false;
  readonly #model = new MockLanguageModelV3({
    doStream: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });

      const usesTestTool = JSON.stringify(options.prompt).includes(TOOL_TEST_PROMPT);

      if (usesTestTool && this.#toolExecutions.length === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                input: JSON.stringify({ itemId: "item-701" }),
                toolCallId: "framework-tool-call-701",
                toolName: TEST_TOOL_NAME,
                type: "tool-call",
              },
              {
                finishReason: { raw: "tool-calls", unified: "tool-calls" },
                type: "finish",
                usage: {
                  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
                  outputTokens: { reasoning: 0, text: 1, total: 1 },
                },
              },
            ],
          }),
        };
      }

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

  protected override createToolAdapter(
    grant: ComposioToolCapabilityGrant,
  ): CrewAgentToolAdapter | undefined {
    if (grant.capabilityId !== COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID) {
      return undefined;
    }

    return {
      description: "Read one exact test item.",
      grant,
      inputSchema: z.strictObject({ itemId: z.string().min(1).max(80) }),
      name: TEST_TOOL_NAME,
      classify: async (input, context) => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(input)),
        );
        const inputDigest = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");

        return {
          agentId: grant.agentId,
          agentRevision: grant.agentRevision,
          capabilityId: grant.capabilityId,
          connectionId: grant.connectionId,
          effect: grant.effect,
          estimatedCostMicrousd: 0,
          grantId: grant.grantId,
          inputDigest,
          integrationSlug: grant.integrationSlug,
          ownerKey: grant.ownerKey,
          runId: context.runId,
          targetDigests: [grant.targetDigests[0] ?? ""],
          toolCallId: context.toolCallId,
          toolkitVersion: grant.toolkitVersion,
          toolSlug: grant.toolSlug,
        };
      },
      execute: async (input, context) => {
        if (context.signal.aborted) {
          throw new Error("Test tool was cancelled.");
        }

        this.#toolExecutions.push({
          input: structuredClone(input),
          permit: structuredClone(context.permit),
        });
        return { itemId: input.itemId, status: "found" };
      },
    };
  }

  toolExecutionsForTest(): unknown[] {
    return structuredClone(this.#toolExecutions);
  }

  protected override cancelAdmittedSubmission(runId: string, reason: string): Promise<void> {
    if (this.#rejectNextCancellation) {
      this.#rejectNextCancellation = false;
      return Promise.reject(new Error("Injected cancellation failure."));
    }

    return super.cancelAdmittedSubmission(runId, reason);
  }
}

export { LARGE_TEST_PROMPT, SLOW_TEST_PROMPT, TEST_REPLY, TOOL_TEST_PROMPT };
