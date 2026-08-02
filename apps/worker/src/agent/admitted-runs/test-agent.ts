import {
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  cancelAdmittedRunInputSchema,
  cancelAdmittedRunResultSchema,
  inspectAdmittedRunResultSchema,
  resolveToolExecutionConnectionResultSchema,
  type ComposioToolCapabilityGrant,
  type WebFetchRuntimeTool,
  type WebSearchRuntimeTool,
} from "@crewhelm/contracts";
import { Session, type ThinkModel } from "@cloudflare/think";
import type { ExecutionResult } from "@cloudflare/sandbox";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import * as z from "zod";

import { CrewAgent } from "../session-directory.js";
import { CrewSession, type CrewAgentToolAdapter } from "./module.js";
import { digestToolInput } from "./protocol.js";
import type { ControlledWebFetchResult, WebSearchEvidence } from "./web-research-execution.js";

const TEST_REPLY = "Crewhelm completed the admitted test run.";
const LARGE_TEST_PROMPT = "Return an output larger than the retained character boundary.";
const DEADLINE_TEST_PROMPT = "Hold this test run well beyond its short deadline.";
const SLOW_TEST_PROMPT = "Hold this test run beyond its deadline.";
const REJECTED_SESSION_PROMPT = "Reject this durable session submission for recovery testing.";
const TOOL_TEST_PROMPT = "Use the exact admitted test tool.";
const TOOL_RESULT_FALLBACK_TEST_PROMPT =
  "Use the exact admitted test tool without a final model response.";
const TEST_TOOL_NAME = "projectToolkitReadItem";
const SANDBOX_TEST_PROMPT = "Use the bounded Sandbox to calculate six times seven.";
const SANDBOX_LIMIT_TEST_PROMPT = "Use the bounded Sandbox and exercise its execution limit.";
const WEB_RESEARCH_TEST_PROMPT = "Search for and read the exact public Crewhelm test source.";
const JSON_OUTPUT_TEST_PROMPT = "Return the admitted JSON test deliverable.";
const JSON_REPAIR_TEST_PROMPT = "Return malformed JSON once for repair testing.";
const JSON_FAILURE_TEST_PROMPT = "Return malformed JSON through repair failure testing.";
const JSON_TEST_REPLY = '{"answer":"Crewhelm concluiu a execução admitida."}';

function testOutput(serializedPrompt: string): string {
  const isOutputRepair = serializedPrompt.includes(
    "Repair one candidate into exactly one JSON object",
  );
  return serializedPrompt.includes(JSON_FAILURE_TEST_PROMPT)
    ? JSON_FAILURE_TEST_PROMPT
    : isOutputRepair || serializedPrompt.includes(JSON_OUTPUT_TEST_PROMPT)
      ? JSON_TEST_REPLY
      : serializedPrompt.includes(JSON_REPAIR_TEST_PROMPT)
        ? "not json"
        : TEST_REPLY;
}

function findWebSource(value: unknown): { token: string; url: string } | undefined {
  if (typeof value === "string") {
    try {
      return findWebSource(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      const source = findWebSource(child);
      if (source !== undefined) return source;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const token = Reflect.get(value, "token");
  const url = Reflect.get(value, "url");
  if (typeof token === "string" && typeof url === "string" && token.length === 43) {
    return { token, url };
  }
  for (const key of Reflect.ownKeys(value)) {
    const child = Reflect.get(value, key);
    const source = findWebSource(child);
    if (source !== undefined) return source;
  }
  return undefined;
}

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
    doGenerate: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });
      return {
        content: [{ text: testOutput(JSON.stringify(options.prompt)), type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
          outputTokens: { reasoning: 0, text: 8, total: 8 },
        },
        warnings: [],
      };
    },
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
                : testOutput(serializedPrompt),
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
  #rejectNextCancellation = false;
  #releaseDeletion: (() => void) | undefined;
  readonly #modelCalls: TestModelCall[] = [];
  readonly #sandboxExecutions: Array<{ code: string; language: string }> = [];
  readonly #webFetchExecutions: string[] = [];
  readonly #webSearchExecutions: string[] = [];
  readonly #model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });
      return {
        content: [{ text: testOutput(JSON.stringify(options.prompt)), type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 8, total: 8 },
          outputTokens: { reasoning: 0, text: 8, total: 8 },
        },
        warnings: [],
      };
    },
    doStream: async (options) => {
      this.#modelCalls.push({
        maxOutputTokens: options.maxOutputTokens,
        prompt: structuredClone(options.prompt),
        toolCount: options.tools?.length ?? 0,
      });
      const serializedPrompt = JSON.stringify(options.prompt);

      if (
        serializedPrompt.includes(WEB_RESEARCH_TEST_PROMPT) &&
        (JSON.stringify(options.tools) ?? "").includes("web_search") &&
        this.#webSearchExecutions.length === 0
      ) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                input: JSON.stringify({ query: "Crewhelm public test source" }),
                toolCallId: "framework-web-search-call",
                toolName: "web_search",
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

      const webSource = findWebSource(options.prompt);
      if (
        serializedPrompt.includes(WEB_RESEARCH_TEST_PROMPT) &&
        (JSON.stringify(options.tools) ?? "").includes("web_fetch_source") &&
        this.#webFetchExecutions.length === 0 &&
        webSource !== undefined
      ) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                input: JSON.stringify({ source: webSource }),
                toolCallId: "framework-web-fetch-call",
                toolName: "web_fetch_source",
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

      if (
        (serializedPrompt.includes(SANDBOX_TEST_PROMPT) ||
          serializedPrompt.includes(SANDBOX_LIMIT_TEST_PROMPT)) &&
        (JSON.stringify(options.tools) ?? "").includes("sandbox_run_code") &&
        this.#sandboxExecutions.length === 0
      ) {
        const code = serializedPrompt.includes(SANDBOX_LIMIT_TEST_PROMPT)
          ? "policy-limit"
          : "print(6 * 7)";
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              {
                input: JSON.stringify({ code, language: "python" }),
                toolCallId: "framework-sandbox-call-42",
                toolName: "sandbox_run_code",
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
            { id: "session-text", type: "text-start" },
            { delta: testOutput(serializedPrompt), id: "session-text", type: "text-delta" },
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

  sandboxExecutionsForTest(): Array<{ code: string; language: string }> {
    return structuredClone(this.#sandboxExecutions);
  }

  webExecutionsForTest(): { fetches: string[]; searches: string[] } {
    return {
      fetches: structuredClone(this.#webFetchExecutions),
      searches: structuredClone(this.#webSearchExecutions),
    };
  }

  protected override runWebSearch(input: {
    query: string;
    signal: AbortSignal;
    tool: WebSearchRuntimeTool;
  }): Promise<{ query: string; results: WebSearchEvidence[] }> {
    if (input.signal.aborted) return Promise.reject(new Error("Test search was cancelled."));
    this.#webSearchExecutions.push(input.query);
    return Promise.resolve({
      query: input.query,
      results: [
        {
          snippet: "A bounded public test source.",
          title: "Crewhelm source",
          url: "https://example.com/crewhelm-source",
        },
      ],
    });
  }

  protected override runWebFetch(input: {
    signal: AbortSignal;
    tool: WebFetchRuntimeTool;
    url: string;
  }): Promise<ControlledWebFetchResult> {
    if (input.signal.aborted) return Promise.reject(new Error("Test fetch was cancelled."));
    this.#webFetchExecutions.push(input.url);
    return Promise.resolve({
      contentType: "text/plain",
      digest: "a".repeat(64),
      finalUrl: input.url,
      redirects: 0,
      text: "Crewhelm public source evidence.",
      truncated: false,
    });
  }

  protected override runSandboxCode(input: {
    code: string;
    language: "javascript" | "python";
    signal: AbortSignal;
  }): Promise<ExecutionResult> {
    if (input.signal.aborted) {
      return Promise.reject(new Error("Test Sandbox was cancelled."));
    }

    this.#sandboxExecutions.push({ code: input.code, language: input.language });
    if (input.code === "policy-limit") {
      return Promise.resolve({
        code: input.code,
        error: {
          message: "Sandbox execution timed out.",
          name: "TimeoutError",
          traceback: [],
        },
        logs: { stderr: [], stdout: [] },
        results: [],
      });
    }
    return Promise.resolve({
      code: input.code,
      logs: { stderr: [], stdout: ["42"] },
      results: [],
    });
  }

  completeBeforeNextCancellationForTest(): void {
    this.#completeBeforeNextCancellation = true;
  }

  failNextCancellationForTest(): void {
    this.#rejectNextCancellation = true;
  }

  async appendCancellationDescendantsForTest(runId: string): Promise<void> {
    const childId = `${runId}:cancel-child`;
    const session = Session.create(this);
    await session.appendMessage(
      {
        id: childId,
        parts: [{ text: "Cancelled child output.", type: "text" }],
        role: "assistant",
      },
      `crewhelm:${runId}:user`,
    );
    await session.appendMessage(
      {
        id: `${runId}:cancel-grandchild`,
        parts: [{ text: "Cancelled grandchild output.", type: "text" }],
        role: "assistant",
      },
      childId,
    );
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

  protected override cancelAdmittedSubmission(runId: string, reason: string): Promise<void> {
    if (this.#rejectNextCancellation) {
      this.#rejectNextCancellation = false;
      return Promise.reject(new Error("Injected Session cancellation failure."));
    }

    return super.cancelAdmittedSubmission(runId, reason);
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
  SANDBOX_LIMIT_TEST_PROMPT,
  SANDBOX_TEST_PROMPT,
  WEB_RESEARCH_TEST_PROMPT,
  SLOW_TEST_PROMPT,
  TEST_REPLY,
  JSON_FAILURE_TEST_PROMPT,
  JSON_OUTPUT_TEST_PROMPT,
  JSON_REPAIR_TEST_PROMPT,
  JSON_TEST_REPLY,
  TOOL_RESULT_FALLBACK_TEST_PROMPT,
  TOOL_TEST_PROMPT,
};
