import {
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  cancelAdmittedRunInputSchema,
  cancelAdmittedRunResultSchema,
  inspectAdmittedRunResultSchema,
  resolveToolExecutionConnectionResultSchema,
  type ComposioToolCapabilityGrant,
} from "@crewhelm/contracts";
import type { ThinkModel } from "@cloudflare/think";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import * as z from "zod";

import { CrewAgent } from "../session-directory.js";
import { CrewSession, type CrewAgentToolAdapter } from "./module.js";
import { digestToolInput } from "./protocol.js";

const TEST_REPLY = "Crewhelm completed the admitted test run.";
const LARGE_TEST_PROMPT = "Return an output larger than the retained character boundary.";
const DEADLINE_TEST_PROMPT = "Hold this test run well beyond its short deadline.";
const SLOW_TEST_PROMPT = "Hold this test run beyond its deadline.";
const REJECTED_SESSION_PROMPT = "Reject this durable session submission for recovery testing.";
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
  #cancellationCount = 0;
  readonly #completedBeforeCancellation = new Map<string, string>();
  #inspectionCount = 0;
  readonly #modelCalls: TestModelCall[] = [];
  readonly #toolExecutions: unknown[] = [];
  #durableSessions = false;
  #completeBeforeNextCancellation = false;
  #delayNextAdmissionMs = 0;
  #rejectNextCancellation = false;
  readonly #model = new MockLanguageModelV4({
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
          initialDelayInMs: JSON.stringify(options.prompt).includes(DEADLINE_TEST_PROMPT)
            ? 10_000
            : JSON.stringify(options.prompt).includes(SLOW_TEST_PROMPT)
              ? 3_000
              : null,
        }),
      };
    },
  });

  enableDurableSessionsForTest(): void {
    this.#durableSessions = true;
  }

  protected override durableSessionsEnabled(): boolean {
    return this.#durableSessions;
  }

  override getModel(): ThinkModel {
    return this.#model;
  }

  modelCallsForTest(): TestModelCall[] {
    return structuredClone(this.#modelCalls);
  }

  inspectionCountForTest(): number {
    return this.#inspectionCount;
  }

  delayNextAdmissionForTest(delayMs = 50): void {
    this.#delayNextAdmissionMs = delayMs;
  }

  override async acceptRunAdmission(input: unknown) {
    const delayMs = this.#delayNextAdmissionMs;
    this.#delayNextAdmissionMs = 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return super.acceptRunAdmission(input);
  }

  failNextCancellationForTest(): void {
    this.#rejectNextCancellation = true;
  }

  completeBeforeNextCancellationForTest(): void {
    this.#completeBeforeNextCancellation = true;
  }

  cancellationCountForTest(): number {
    return this.#cancellationCount;
  }

  override async cancelAdmittedRun(input: unknown) {
    this.#cancellationCount += 1;
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
    this.#inspectionCount += 1;
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

export class TestCrewSession extends CrewSession {
  readonly #completedBeforeCancellation = new Map<string, string>();
  #completeBeforeNextCancellation = false;
  #delayDeletion = false;
  #deletionWaiting = false;
  #failDeletionResponse = false;
  #releaseDeletion: (() => void) | undefined;
  readonly #modelCalls: TestModelCall[] = [];
  readonly #model = new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ text: TEST_REPLY, type: "text" }],
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
        outputTokens: { reasoning: 0, text: 8, total: 8 },
      },
      warnings: [],
    }),
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
            { id: "session-text", type: "text-start" },
            { delta: TEST_REPLY, id: "session-text", type: "text-delta" },
            { id: "session-text", type: "text-end" },
            {
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
                outputTokens: { reasoning: 0, text: 8, total: 8 },
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
    return cancelAdmittedRunResultSchema.parse({ cancelled: false, ok: true });
  }

  override async inspectAdmittedRun(input: unknown) {
    const result = await super.inspectAdmittedRun(input);
    if (!result.ok) return result;
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

  delayNextDeletionForTest(): void {
    this.#delayDeletion = true;
  }

  deletionWaitingForTest(): boolean {
    return this.#deletionWaiting;
  }

  releaseDeletionForTest(): void {
    this.#releaseDeletion?.();
  }

  failNextDeletionResponseForTest(): void {
    this.#failDeletionResponse = true;
  }

  override async deleteSessionStorage(input: unknown): Promise<boolean> {
    if (this.#delayDeletion) {
      this.#delayDeletion = false;
      this.#deletionWaiting = true;
      await new Promise<void>((resolve) => {
        this.#releaseDeletion = resolve;
      });
      this.#deletionWaiting = false;
      this.#releaseDeletion = undefined;
    }

    const deleted = await super.deleteSessionStorage(input);

    if (this.#failDeletionResponse) {
      this.#failDeletionResponse = false;
      throw new Error("Injected lost session deletion response.");
    }

    return deleted;
  }

  protected override rejectAdmittedSubmission(prompt: string): boolean {
    return prompt === REJECTED_SESSION_PROMPT;
  }
}

export {
  DEADLINE_TEST_PROMPT,
  LARGE_TEST_PROMPT,
  REJECTED_SESSION_PROMPT,
  SLOW_TEST_PROMPT,
  TEST_REPLY,
  TOOL_RESULT_FALLBACK_TEST_PROMPT,
  TOOL_TEST_PROMPT,
};
