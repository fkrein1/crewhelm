import {
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  cancelAdmittedRunInputSchema,
  cancelAdmittedRunResultSchema,
  inspectAdmittedRunResultSchema,
  resolveToolExecutionConnectionResultSchema,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import type { ThinkModel } from "@cloudflare/think";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import * as z from "zod";

import { CrewAgent, type CrewAgentToolAdapter } from "./module.js";
import { digestToolInput } from "./protocol.js";

const TEST_REPLY = "Crewhelm completed the admitted test run.";
const LARGE_TEST_PROMPT = "Return an output larger than the retained character boundary.";
const SLOW_TEST_PROMPT = "Hold this test run beyond its deadline.";
const TOOL_TEST_PROMPT = "Use the exact admitted test tool.";
const TOOL_RESULT_FALLBACK_TEST_PROMPT =
  "Use the exact admitted test tool without a final model response.";
const TEST_TOOL_NAME = "projectToolkitReadItem";

interface TestModelCall {
  maxOutputTokens: number | undefined;
  prompt: unknown;
  toolCount: number;
}

export class TestCrewAgent extends CrewAgent {
  readonly #completedBeforeCancellation = new Map<string, string>();
  readonly #modelCalls: TestModelCall[] = [];
  readonly #toolExecutions: unknown[] = [];
  #completeBeforeNextCancellation = false;
  #rejectNextCancellation = false;
  readonly #model = new MockLanguageModelV3({
    doStream: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });

      const serializedPrompt = JSON.stringify(options.prompt);
      const usesToolResultFallback = serializedPrompt.includes(TOOL_RESULT_FALLBACK_TEST_PROMPT);
      const usesTestTool = usesToolResultFallback || serializedPrompt.includes(TOOL_TEST_PROMPT);

      if (usesTestTool && this.#toolExecutions.length === 0) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { id: "pending-text", type: "text-start" },
              {
                delta: "The tool action is pending approval.",
                id: "pending-text",
                type: "text-delta",
              },
              { id: "pending-text", type: "text-end" },
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

      if (usesToolResultFallback) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                finishReason: { raw: "stop", unified: "stop" },
                type: "finish",
                usage: {
                  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
                  outputTokens: { reasoning: 0, text: 0, total: 0 },
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

  completeBeforeNextCancellationForTest(): void {
    this.#completeBeforeNextCancellation = true;
  }

  override async cancelAdmittedRun(input: unknown) {
    const request = cancelAdmittedRunInputSchema.safeParse(input);

    if (!this.#completeBeforeNextCancellation || !request.success) {
      return super.cancelAdmittedRun(input);
    }

    this.#completeBeforeNextCancellation = false;
    const redeemed = await this.env.OWNER_CONTROL_PLANE.getByName(
      request.data.capability.ownerKey,
    ).redeemRunReceiverCapability(request.data.capability);

    if (!redeemed.ok) {
      return cancelAdmittedRunResultSchema.parse(redeemed);
    }

    this.#completedBeforeCancellation.set(request.data.capability.runId, new Date().toISOString());

    return cancelAdmittedRunResultSchema.parse({
      cancelled: false,
      ok: true,
    });
  }

  override async inspectAdmittedRun(input: unknown) {
    const result = await super.inspectAdmittedRun(input);

    if (!result.ok) {
      return result;
    }

    const completedAt = this.#completedBeforeCancellation.get(result.run.runId);

    return completedAt === undefined
      ? result
      : inspectAdmittedRunResultSchema.parse({
          ok: true,
          run: {
            ...result.run,
            completedAt,
            output: TEST_REPLY,
            outputTruncated: false,
            status: "completed",
          },
          trace: result.trace,
        });
  }

  protected override createToolAdapter(
    grant: ComposioToolCapabilityGrant,
  ): CrewAgentToolAdapter | undefined {
    if (grant.capabilityId !== COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID) {
      return undefined;
    }

    return {
      approvalSummary: grant.tool.name,
      description: grant.tool.description ?? grant.tool.name,
      grant,
      inputSchema: z.strictObject({ itemId: z.string().min(1).max(80) }),
      name: TEST_TOOL_NAME,
      classify: async (input, context) => {
        return {
          agentId: grant.agentId,
          agentRevision: grant.agentRevision,
          capabilityId: grant.capabilityId,
          connectionId: grant.connectionId,
          effect: grant.effect,
          estimatedCostMicrousd: 0,
          grantId: grant.grantId,
          inputDigest: await digestToolInput(input),
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

        const resolved = resolveToolExecutionConnectionResultSchema.parse(
          await this.env.OWNER_CONTROL_PLANE.getByName(
            context.permit.action.ownerKey,
          ).resolveToolExecutionConnection(context.permit),
        );

        if (!resolved.ok) {
          throw new Error("Test tool dispatch was denied.");
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

export {
  LARGE_TEST_PROMPT,
  SLOW_TEST_PROMPT,
  TEST_REPLY,
  TOOL_RESULT_FALLBACK_TEST_PROMPT,
  TOOL_TEST_PROMPT,
};
