import {
  acceptRunAdmissionInputSchema,
  acceptRunAdmissionResultSchema,
  cancelAdmittedRunInputSchema,
  cancelAdmittedRunResultSchema,
  confirmRunAdmissionResultSchema,
  crewAgentObjectName,
  inspectAdmittedRunInputSchema,
  inspectAdmittedRunResultSchema,
  MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  recordAgentInboxRunInputSchema,
  recordAgentInboxRunResultSchema,
  redeemRunReceiverCapabilityResultSchema,
  resumeRunAdmissionInputSchema,
  runIdSchema,
  completeToolExecutionResultSchema,
  evaluateToolExecutionResultSchema,
  reserveToolExecutionResultSchema,
  resolveToolExecutionConnectionResultSchema,
  classifiedComposioToolActionSchema,
  decideAdmittedRunToolApprovalInputSchema,
  decideAdmittedRunToolApprovalResultSchema,
  listAdmittedRunToolApprovalsInputSchema,
  listAdmittedRunToolApprovalsResultSchema,
  pendingToolApprovalSchema,
  MAXIMUM_RUN_TIMELINE_EVENTS,
  TOOL_APPROVAL_LIFETIME_MS,
  toolAuthorizationTimelineEventSchema,
  verifyActiveRunAdmissionResultSchema,
  verifyRunAdmissionResultSchema,
  type AcceptRunAdmissionResult,
  type CrewAgentRuntimeConfig,
  type InspectAdmittedRunResult,
  type Run,
  type RunAdmissionPermit,
  type RunBudgetReservation,
  type RunReceiverCapability,
  type ClassifiedComposioToolAction,
  type ComposioToolCapabilityGrant,
  type ToolExecutionPermit,
  type PendingToolApproval,
  type RecordAgentInboxRunInput,
  type ToolAuthorizationTimelineEvent,
} from "@crewhelm/contracts";
import { createComposioRuntime } from "@crewhelm/composio";
import {
  Think,
  Session,
  action as defineAction,
  type Action,
  type ActionAuthorizationContext,
  type ActionAuthorizationDecision,
  type ActionContext,
  type AddMessagesOptions,
  type ChatOptions,
  type ChatResponseResult,
  type DeleteSubmissionsOptions,
  type ListSubmissionsOptions,
  type RunTurnOptions,
  type RunTurnStream,
  type RunTurnSubmit,
  type RunTurnWait,
  type SaveMessagesOptions,
  type SaveMessagesResult,
  type PrepareStepContext,
  type StepConfig,
  type StreamCallback,
  type SubmitMessagesOptions,
  type SubmitMessagesResult,
  type ThinkModel,
  type ThinkSubmissionInspection,
  type TurnConfig,
  type TurnContext,
  type TurnResult,
  type ToolCallContext,
  type ToolCallDecision,
} from "@cloudflare/think";
import type { ToolSet, UIMessage } from "ai";
import type { RetryOptions, Schedule } from "agents";
import * as z from "zod";

import {
  recordExecutionEvent,
  recordExecutionProviderResponse,
} from "../../observability/execution.js";
import { digestRunPrompt, digestToolInput } from "./protocol.js";
import {
  agentInboxProjectionOutboxSchema,
  admittedRunRecordSchema,
  admittedTurnMetadataSchema,
  pendingToolApprovalRecordSchema,
  scheduledInboxProjectionInputSchema,
  scheduledRunInputSchema,
  type AdmittedRunRecord,
  type AdmittedTurnMetadata,
  type AgentInboxProjectionOutbox,
} from "./schema.js";

const RUNTIME_ADMISSION_UNAVAILABLE = "CrewAgent runtime admission is not available.";
const INBOX_PROJECTION_PREFIX = "crewhelm:inbox-projection:";
const RUN_RECORD_PREFIX = "crewhelm:run:";
const RUN_TRACE_PREFIX = "crewhelm:run-trace:";
const TOOL_APPROVAL_PREFIX = "crewhelm:tool-approval:";
const INBOX_PROJECTION_MINIMUM_RETRY_MS = 60_000;
const INBOX_PROJECTION_MAXIMUM_RETRY_MS = 60 * 60 * 1_000;
const INBOX_PROJECTION_SAFETY_WAKEUP_MS = 1_000;
const MAXIMUM_RUN_OUTPUT_PARTS = 256;
const EXECUTION_OUTCOME_PREFIX = "[execute tool]";
const EXECUTION_OUTCOME_MARKER = " Outcome: ";
const INVALID_RUN_ADMISSION = {
  error: {
    code: "invalid_admission",
    message: "Run admission denied.",
  },
  ok: false,
} as const;

export const BLOCKED_CREW_AGENT_AUTHORITY_METHODS = [
  "_cf_acquireFacetKeepAlive",
  "_cf_asDurableObjectNamespace",
  "_cf_broadcastToParentSubAgent",
  "_cf_broadcastToSubAgent",
  "_cf_cancelScheduleForFacet",
  "_cf_checkRunFibersForFacet",
  "_cf_cleanupFacetPrefix",
  "_cf_closeSubAgentConnection",
  "_cf_connectionHasSubAgentTarget",
  "_cf_connectionTargetsSubAgent",
  "_cf_createSubAgentBridgeConnection",
  "_cf_createSubAgentConnectionBridge",
  "_cf_destroyDescendantFacet",
  "_cf_forwardSubAgentWebSocketClose",
  "_cf_forwardSubAgentWebSocketConnect",
  "_cf_forwardSubAgentWebSocketMessage",
  "_cf_forwardToFacet",
  "_cf_getForwardedSubAgentState",
  "_cf_getRawConnectionState",
  "_cf_getScheduleForFacet",
  "_cf_getTopLevelNamespaceByClassName",
  "_cf_handleSubAgentWebSocketClose",
  "_cf_handleSubAgentWebSocketConnect",
  "_cf_handleSubAgentWebSocketMessage",
  "_cf_hydrateSubAgentConnectionsFromRoot",
  "_cf_initAsFacet",
  "_cf_invokeStubMethod",
  "_cf_listSchedulesForFacet",
  "_cf_parentAgentFacetProxy",
  "_cf_registerFacetRun",
  "_cf_releaseFacetKeepAlive",
  "_cf_requestTargetsSubAgent",
  "_cf_resolveSubAgent",
  "_cf_resolveSubAgentConnection",
  "_cf_runWithSubAgentBridge",
  "_cf_sendToSubAgentConnection",
  "_cf_setSubAgentConnectionState",
  "_cf_storeVirtualSubAgentConnection",
  "_cf_subAgentConnectionMetaForPath",
  "_cf_subAgentConnectionMetas",
  "_cf_subAgentIdentity",
  "_cf_subAgentPathFromOuterUri",
  "_cf_subAgentTargetPath",
  "_cf_unregisterFacetRun",
] as const;

export interface CrewAgentToolAdapter {
  readonly approvalSummary: string;
  readonly description: string;
  readonly grant: ComposioToolCapabilityGrant;
  readonly inputSchema: z.ZodType<Record<string, unknown>>;
  readonly name: string;
  classify(
    input: Record<string, unknown>,
    context: { runId: string; toolCallId: string },
  ): Promise<ClassifiedComposioToolAction> | ClassifiedComposioToolAction;
  execute(
    input: Record<string, unknown>,
    context: { permit: ToolExecutionPermit; signal: AbortSignal },
  ): Promise<unknown>;
}

function requiresToolApproval(grant: ComposioToolCapabilityGrant): boolean {
  return (
    grant.effect === "destructive" ||
    (grant.effect === "write" && grant.authorization !== "standing")
  );
}

type ToolAuthorizationFailureReason = Extract<
  ToolAuthorizationTimelineEvent,
  { event: "tool.authorization_blocked" }
>["reason"];

function runtimeAdmissionError(): Error {
  return new Error(RUNTIME_ADMISSION_UNAVAILABLE);
}

export function isToolExecutionPermitFresh(
  permit: { constraints: { decisionExpiresAt: string } },
  currentTime = Date.now(),
): boolean {
  const expiresAt = Date.parse(permit.constraints.decisionExpiresAt);

  return Number.isFinite(expiresAt) && currentTime < expiresAt;
}

function runRecordKey(runId: string): string {
  return `${RUN_RECORD_PREFIX}${runId}`;
}

function runTraceKey(runId: string): string {
  return `${RUN_TRACE_PREFIX}${runId}`;
}

function inboxProjectionKey(runId: string): string {
  return `${INBOX_PROJECTION_PREFIX}${runId}`;
}

function toolApprovalPrefix(runId: string): string {
  return `${TOOL_APPROVAL_PREFIX}${runId}:`;
}

function toolApprovalKey(runId: string, toolCallId: string): string {
  return `${toolApprovalPrefix(runId)}${toolCallId}`;
}

function runUserMessageId(runId: string): string {
  return `crewhelm:${runId}:user`;
}

async function canonicalToolCallId(runId: string, toolCallId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify({ runId, toolCallId })),
    ),
  );
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x40;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );

  return `tool_call_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isoTimestamp(timestamp: number | undefined): string | undefined {
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function resultPreview(message: UIMessage): string | null {
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replaceAll(/\s+/g, " ")
    .trim();

  return text.length === 0 ? null : text.slice(0, MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS);
}

function publicRunStatus(status: ThinkSubmissionInspection["status"]): Run["status"] {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "aborted":
      return "cancelled";
    case "error":
    case "skipped":
      return "failed";
    default:
      return "failed";
  }
}

export class CrewAgent extends Think {
  #approvalTurnMetadata: AdmittedTurnMetadata | undefined;
  #gatewayAiBinding: Ai | undefined;
  #permittedApprovalContinuationRunId: string | undefined;
  #permittedAbortRequestId: string | undefined;
  override chatRecovery = false;
  override fetchTools: false = false;
  override includeMcpTools = false;
  override sendReasoning = false;
  override storeMessages = false;
  override storeTools = false;
  override waitForMcpConnections = false;
  override workspaceBash = false;

  override async onStart(): Promise<void> {
    await super.onStart();

    const records = await this.ctx.storage.list({ prefix: RUN_RECORD_PREFIX });

    for (const [key, stored] of records) {
      const record = admittedRunRecordSchema.safeParse(stored);
      const runId = key.slice(RUN_RECORD_PREFIX.length);

      if (record.success && runIdSchema.safeParse(runId).success) {
        if (JSON.stringify(stored) !== JSON.stringify(record.data)) {
          await this.ctx.storage.put(key, record.data);
        }

        await this.#scheduleRunLifecycle(runId, record.data);
      }
    }

    const projections = await this.ctx.storage.list({ prefix: INBOX_PROJECTION_PREFIX });

    for (const [key, stored] of projections) {
      const outbox = agentInboxProjectionOutboxSchema.safeParse(stored);
      const runId = key.slice(INBOX_PROJECTION_PREFIX.length);

      if (
        !outbox.success ||
        !runIdSchema.safeParse(runId).success ||
        outbox.data.projection.reference.runId !== runId
      ) {
        continue;
      }

      if (Date.now() >= outbox.data.cleanupAt) {
        await this.#deleteInboxProjectionIfCurrent(key, outbox.data);
      } else if (Date.now() >= outbox.data.retryAt) {
        await this.#deliverInboxProjection(runId, outbox.data.attempts);
      } else {
        await this.#scheduleInboxProjection(outbox.data, outbox.data.retryAt);
      }
    }
  }

  override configure(_configuration: unknown): void {
    throw runtimeAdmissionError();
  }

  override getConfig(): null {
    throw runtimeAdmissionError();
  }

  override sql<T = Record<string, string | number | boolean | null>>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null | undefined)[]
  ): T[] {
    if (
      !Object.isFrozen(strings) ||
      !Object.isFrozen(strings.raw) ||
      values.some(
        (value) =>
          value !== null &&
          value !== undefined &&
          !["boolean", "number", "string"].includes(typeof value),
      )
    ) {
      throw runtimeAdmissionError();
    }

    return super.sql<T>(strings, ...values.map((value) => (value === undefined ? null : value)));
  }

  override setState(_state: unknown): void {
    throw runtimeAdmissionError();
  }

  override async schedule<T = string>(
    when: Date | string | number,
    callback: keyof this,
    payload?: T,
    options?: {
      retry?: RetryOptions;
      idempotent?: boolean;
    },
  ): Promise<Schedule<T>> {
    const callbackName = String(callback);

    if (callbackName === "_drainThinkSubmissions") {
      if (when !== 0 || payload !== undefined) {
        throw runtimeAdmissionError();
      }
    } else if (callbackName === "_cleanupStreamBuffers") {
      if (
        typeof when !== "number" ||
        !Number.isFinite(when) ||
        when < 0 ||
        when > 3_600 ||
        payload !== undefined
      ) {
        throw runtimeAdmissionError();
      }
    } else if (callbackName === "expireAdmittedRun" || callbackName === "cleanupAdmittedRun") {
      const scheduled = scheduledRunInputSchema.safeParse(payload);

      if (!scheduled.success || !(when instanceof Date)) {
        throw runtimeAdmissionError();
      }

      const record = await this.#readRunRecord(scheduled.data.runId);
      const expectedAt =
        callbackName === "expireAdmittedRun" ? record?.deadlineAt : record?.cleanupAt;

      if (expectedAt === undefined || when.getTime() !== expectedAt) {
        throw runtimeAdmissionError();
      }
    } else {
      throw runtimeAdmissionError();
    }

    return super.schedule(when, callback, payload, {
      ...options,
      idempotent: true,
    });
  }

  override scheduleEvery<T = string>(..._args: unknown[]): Promise<Schedule<T>> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_scheduleForFacet(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_scheduleEveryForFacet(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_dispatchScheduledCallback(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getSchedule<T = string>(..._args: unknown[]): Schedule<T> | undefined {
    throw runtimeAdmissionError();
  }

  override getScheduleById(..._args: unknown[]): Promise<Schedule<unknown> | undefined> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getSchedules<T = string>(..._args: unknown[]): Schedule<T>[] {
    throw runtimeAdmissionError();
  }

  override listSchedules(..._args: unknown[]): Promise<Schedule<unknown>[]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelSchedule(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override queue(..._args: unknown[]): Promise<string> {
    return Promise.reject(runtimeAdmissionError());
  }

  override dequeue(..._args: unknown[]): void {
    throw runtimeAdmissionError();
  }

  override dequeueAll(): void {
    throw runtimeAdmissionError();
  }

  override dequeueAllByCallback(..._args: unknown[]): void {
    throw runtimeAdmissionError();
  }

  override getQueue(..._args: unknown[]): undefined {
    throw runtimeAdmissionError();
  }

  override getQueues(..._args: unknown[]): never[] {
    throw runtimeAdmissionError();
  }

  override fetch(_request: Request): Promise<Response> {
    return Promise.resolve(new Response("Not found.", { status: 404 }));
  }

  override chat(
    _userMessage: unknown,
    _callback: StreamCallback,
    _options?: ChatOptions,
  ): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override chatWithMessengerContext(
    _userMessage: unknown,
    _callback: StreamCallback,
    _context: unknown,
    _options?: ChatOptions,
  ): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override runTurn(_options: RunTurnWait): Promise<TurnResult>;
  override runTurn(_options: RunTurnSubmit): Promise<SubmitMessagesResult>;
  override runTurn(_options: RunTurnStream): Promise<void>;
  override runTurn(_options: RunTurnOptions): Promise<TurnResult | SubmitMessagesResult | void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override saveMessages(
    _messages: unknown,
    _options?: SaveMessagesOptions,
  ): Promise<SaveMessagesResult> {
    return Promise.reject(runtimeAdmissionError());
  }

  override submitMessages(
    _messages: unknown,
    _options?: SubmitMessagesOptions,
  ): Promise<SubmitMessagesResult> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getMessages(): Promise<UIMessage[]> {
    return Promise.reject(runtimeAdmissionError());
  }

  protected override appendMessageToHistory(
    _message: UIMessage,
    _parentId?: string | null,
  ): Promise<UIMessage> {
    return Promise.reject(runtimeAdmissionError());
  }

  protected override updateMessageInHistory(_message: UIMessage): Promise<UIMessage> {
    return Promise.reject(runtimeAdmissionError());
  }

  protected override syncMessagesFromStorage(): Promise<UIMessage[]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override reportProgress(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override clearMessages(): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override addMessages(_messages: unknown, _options?: AddMessagesOptions): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override inspectSubmission(_submissionId: string): Promise<ThinkSubmissionInspection | null> {
    return Promise.reject(runtimeAdmissionError());
  }

  override listSubmissions(
    _options?: ListSubmissionsOptions,
  ): Promise<ThinkSubmissionInspection[]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override deleteSubmission(_submissionId: string): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override deleteSubmissions(_options?: DeleteSubmissionsOptions): Promise<number> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelSubmission(_submissionId: string, _reason?: unknown): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelChat(_requestId: string, _reason?: string): void {
    throw runtimeAdmissionError();
  }

  override cancelAllChats(): void {
    throw runtimeAdmissionError();
  }

  protected override resetTurnState(): void {
    throw runtimeAdmissionError();
  }

  protected override abortRequest(requestId: string, reason?: unknown): void {
    const activeRunId = admittedTurnMetadataSchema.safeParse(this.activeTurnMetadata).data
      ?.crewhelmRun.runId;

    if (requestId !== this.#permittedAbortRequestId && requestId !== activeRunId) {
      throw runtimeAdmissionError();
    }

    super.abortRequest(requestId, reason);
  }

  protected override abortAllRequests(): void {
    throw runtimeAdmissionError();
  }

  override replyAttachments(_requestId?: string): ReturnType<Think["replyAttachments"]> {
    return [];
  }

  override pendingExecutions(_executionId?: string): ReturnType<Think["pendingExecutions"]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override pendingApprovals(_executionId?: string): ReturnType<Think["pendingApprovals"]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override approveExecution(_executionId: string): ReturnType<Think["approveExecution"]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override rejectExecution(
    _executionId: string,
    _reason?: string,
  ): ReturnType<Think["rejectExecution"]> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostReadFile(..._args: unknown[]): Promise<string | null> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostWriteFile(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostDeleteFile(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostListFiles(
    ..._args: unknown[]
  ): Promise<Array<{ name: string; path: string; size: number; type: string }>> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostGetContext(..._args: unknown[]): Promise<string | null> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostSetContext(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostGetMessages(
    ..._args: unknown[]
  ): Promise<Array<{ content: string; id: string; role: string }>> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostSendMessage(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _hostGetSessionInfo(): Promise<{ messageCount: number }> {
    return Promise.reject(runtimeAdmissionError());
  }

  override destroy(): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_scheduleDestroy(): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getCallableMethods(): never {
    throw runtimeAdmissionError();
  }

  override addMcpServer(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override removeMcpServer(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getMcpServers(): ReturnType<Think["getMcpServers"]> {
    return {
      prompts: [],
      resources: [],
      servers: {},
      tools: [],
    };
  }

  override inspectFiber(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override inspectFiberByKey(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override listFibers(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelFiber(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelFiberByKey(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override resolveFiber(..._args: unknown[]): Promise<boolean> {
    return Promise.reject(runtimeAdmissionError());
  }

  override deleteFibers(..._args: unknown[]): Promise<number> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_invokeAgentPath(..._args: unknown[]): Promise<unknown> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_invokeSubAgent(..._args: unknown[]): Promise<unknown> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cf_invokeSubAgentPath(..._args: unknown[]): Promise<unknown> {
    return Promise.reject(runtimeAdmissionError());
  }

  override runWorkflow(..._args: unknown[]): Promise<string> {
    return Promise.reject(runtimeAdmissionError());
  }

  override sendWorkflowEvent(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override approveWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override rejectWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override terminateWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override pauseWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override resumeWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override restartWorkflow(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getWorkflowStatus(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getWorkflow(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override getWorkflows(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override deleteWorkflow(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override deleteWorkflows(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override migrateWorkflowBinding(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override _workflow_handleCallback(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _workflow_broadcast(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _workflow_updateState(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override abortSubAgent(..._args: unknown[]): void {
    throw runtimeAdmissionError();
  }

  override deleteSubAgent(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override listSubAgents(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override sendEmail(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override replyToEmail(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _onEmail(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getOnStartDegradations(): never {
    throw runtimeAdmissionError();
  }

  override deliverNotice(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getScheduledTasks(): ReturnType<Think["getScheduledTasks"]> {
    return {};
  }

  override internal_reconcileScheduledTasks(): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _runDeclaredScheduledTask(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cfDetachedNotifyFinish(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _cfDetachedReconcileTick(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _chatRecoveryRetry(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override _chatRecoveryContinue(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override runAgentTool(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelAgentTool(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override hasAgentToolRun(..._args: unknown[]): never {
    throw runtimeAdmissionError();
  }

  override clearAgentToolRuns(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override startAgentToolRun(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override cancelAgentToolRun(..._args: unknown[]): Promise<void> {
    return Promise.reject(runtimeAdmissionError());
  }

  override inspectAgentToolRun(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override getAgentToolChunks(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  override tailAgentToolRun(..._args: unknown[]): Promise<never> {
    return Promise.reject(runtimeAdmissionError());
  }

  async acceptRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    const request = acceptRunAdmissionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUN_ADMISSION;
    }

    const { permit, prompt } = request.data;

    if (
      !this.#objectMatches(permit.ownerKey, permit.agentId) ||
      (await digestRunPrompt(prompt)) !== permit.promptDigest
    ) {
      return INVALID_RUN_ADMISSION;
    }

    let record: AdmittedRunRecord | undefined;

    try {
      record = await this.#readRunRecord(permit.runId);
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    if (record === undefined) {
      let verification: unknown;

      try {
        verification = await this.env.OWNER_CONTROL_PLANE.getByName(
          permit.ownerKey,
        ).verifyRunAdmission(permit);
      } catch {
        return INVALID_RUN_ADMISSION;
      }

      const verified = verifyRunAdmissionResultSchema.safeParse(verification);

      if (
        !verified.success ||
        !verified.data.ok ||
        verified.data.runId !== permit.runId ||
        !this.#configurationMatchesPermit(verified.data.configuration, permit) ||
        !this.#reservationMatchesPrompt(
          permit.budgetReservation,
          verified.data.configuration,
          prompt.length,
        )
      ) {
        return INVALID_RUN_ADMISSION;
      }

      const acceptedAt = Date.now();

      record = admittedRunRecordSchema.parse({
        budgetReservation: permit.budgetReservation,
        cleanupAt: acceptedAt + permit.budgetReservation.retentionSeconds * 1_000,
        clientId: permit.clientId,
        configuration: verified.data.configuration,
        createdAt: acceptedAt,
        deadlineAt: acceptedAt + permit.budgetReservation.maxDurationSeconds * 1_000,
        idempotencyKey: permit.idempotencyKey,
        promptCharacters: prompt.length,
        promptDigest: permit.promptDigest,
      });

      await this.ctx.storage.put(runRecordKey(permit.runId), record);
      await this.#scheduleRunLifecycle(permit.runId, record);
    } else if (!this.#recordMatchesPermit(record, permit)) {
      return INVALID_RUN_ADMISSION;
    }

    let confirmation: unknown;

    try {
      confirmation = await this.env.OWNER_CONTROL_PLANE.getByName(
        permit.ownerKey,
      ).confirmRunAdmission(permit);
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    const confirmed = confirmRunAdmissionResultSchema.safeParse(confirmation);

    if (!confirmed.success || !confirmed.data.ok || confirmed.data.runId !== permit.runId) {
      return INVALID_RUN_ADMISSION;
    }

    return this.#submitAdmittedRun(permit.runId, prompt, record);
  }

  async resumeRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    const request = resumeRunAdmissionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUN_ADMISSION;
    }

    const { capability, prompt } = request.data;
    let record: AdmittedRunRecord;

    try {
      const stored = await this.#readRunRecord(capability.runId);

      if (
        stored === undefined ||
        !this.#objectMatches(stored.configuration.ownerKey, stored.configuration.agentId) ||
        Date.parse(capability.expiresAt) <= Date.now() ||
        (await digestRunPrompt(prompt)) !== stored.promptDigest ||
        !this.#recordMatchesCapability(stored, capability, prompt.length)
      ) {
        return INVALID_RUN_ADMISSION;
      }

      record = stored;
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    let verification: unknown;

    try {
      verification = await this.env.OWNER_CONTROL_PLANE.getByName(
        record.configuration.ownerKey,
      ).redeemRunReceiverCapability(capability);
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    const verified = redeemRunReceiverCapabilityResultSchema.safeParse(verification);

    if (!verified.success || !verified.data.ok || verified.data.runId !== capability.runId) {
      return INVALID_RUN_ADMISSION;
    }

    return this.#submitAdmittedRun(capability.runId, prompt, record);
  }

  async inspectAdmittedRun(input: unknown): Promise<InspectAdmittedRunResult> {
    const request = inspectAdmittedRunInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_RUN_ADMISSION;
    }

    const { capability } = request.data;
    let record: AdmittedRunRecord | undefined;

    try {
      record = await this.#readRunRecord(capability.runId);
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    if (
      record === undefined ||
      Date.parse(capability.expiresAt) <= Date.now() ||
      !this.#objectMatches(record.configuration.ownerKey, record.configuration.agentId) ||
      !this.#recordMatchesCapability(record, capability, record.promptCharacters)
    ) {
      return INVALID_RUN_ADMISSION;
    }

    let verification: unknown;

    try {
      verification = await this.env.OWNER_CONTROL_PLANE.getByName(
        record.configuration.ownerKey,
      ).redeemRunReceiverCapability(capability);
    } catch {
      return INVALID_RUN_ADMISSION;
    }

    const verified = redeemRunReceiverCapabilityResultSchema.safeParse(verification);

    if (!verified.success || !verified.data.ok || verified.data.runId !== capability.runId) {
      return INVALID_RUN_ADMISSION;
    }

    const [submission, trace] = await Promise.all([
      super.inspectSubmission(capability.runId),
      this.#readRunTrace(capability.runId),
    ]);

    if (submission === null) {
      return inspectAdmittedRunResultSchema.parse({
        ok: true,
        run: {
          agentId: record.configuration.agentId,
          agentRevision: record.configuration.revision,
          createdAt: new Date(record.createdAt).toISOString(),
          runId: capability.runId,
          status: Date.now() >= record.deadlineAt ? "failed" : "queued",
        },
        trace,
      });
    }

    const output =
      submission.status === "completed" ? this.#readRunOutput(capability.runId) : undefined;
    const outputPending = output?.state === "pending";

    return inspectAdmittedRunResultSchema.parse({
      ok: true,
      run: {
        agentId: record.configuration.agentId,
        agentRevision: record.configuration.revision,
        completedAt: outputPending ? undefined : isoTimestamp(submission.completedAt),
        createdAt: new Date(submission.createdAt).toISOString(),
        ...(output?.state !== "available"
          ? {}
          : {
              output: output.text,
              outputTruncated: output.truncated,
            }),
        runId: capability.runId,
        startedAt: isoTimestamp(submission.startedAt),
        status: outputPending ? "running" : publicRunStatus(submission.status),
      },
      trace,
    });
  }

  async cancelAdmittedRun(input: unknown) {
    const request = cancelAdmittedRunInputSchema.safeParse(input);

    if (!request.success || !(await this.#redeemReceiverCapability(request.data.capability))) {
      return INVALID_RUN_ADMISSION;
    }

    const runId = request.data.capability.runId;
    const submission = await super.inspectSubmission(runId);
    const approvalRecords = await this.ctx.storage.list({
      prefix: toolApprovalPrefix(runId),
    });
    const waitingForToolApproval = submission?.status === "completed" && approvalRecords.size > 0;

    if (
      submission === null ||
      (["aborted", "completed", "error", "skipped"].includes(submission.status) &&
        !waitingForToolApproval)
    ) {
      return cancelAdmittedRunResultSchema.parse({
        cancelled: false,
        ok: true,
      });
    }

    if (!waitingForToolApproval) {
      await this.cancelAdmittedSubmission(runId, "Cancelled by the Crewhelm owner.");
    }

    await Promise.all([...approvalRecords.keys()].map((key) => this.ctx.storage.delete(key)));

    return cancelAdmittedRunResultSchema.parse({
      cancelled: true,
      ok: true,
    });
  }

  async listAdmittedRunToolApprovals(input: unknown) {
    const request = listAdmittedRunToolApprovalsInputSchema.safeParse(input);

    if (!request.success || !(await this.#redeemReceiverCapability(request.data.capability))) {
      return INVALID_RUN_ADMISSION;
    }

    const pending = await super.pendingApprovals();
    const approvals: PendingToolApproval[] = [];

    for (const approval of pending) {
      if (approval.source !== "action") {
        continue;
      }

      const toolCallId = await canonicalToolCallId(
        request.data.capability.runId,
        approval.descriptor.toolCallId,
      );
      const stored = pendingToolApprovalRecordSchema.safeParse(
        await this.ctx.storage.get(toolApprovalKey(request.data.capability.runId, toolCallId)),
      );

      if (!stored.success || Date.parse(stored.data.expiresAt) <= Date.now()) {
        continue;
      }

      const { runId: storedRunId, ...publicApproval } = stored.data;

      if (storedRunId !== request.data.capability.runId) {
        continue;
      }

      approvals.push(
        pendingToolApprovalSchema.parse({
          ...publicApproval,
          executionId: approval.executionId,
        }),
      );
    }

    return listAdmittedRunToolApprovalsResultSchema.parse({ approvals, ok: true });
  }

  async decideAdmittedRunToolApproval(input: unknown) {
    const request = decideAdmittedRunToolApprovalInputSchema.safeParse(input);

    if (!request.success || !(await this.#redeemReceiverCapability(request.data.capability))) {
      return INVALID_RUN_ADMISSION;
    }

    const capability = request.data.capability;
    const pending = await super.pendingApprovals(capability.executionId);
    const approval = pending.find(
      (candidate) =>
        candidate.source === "action" && candidate.executionId === capability.executionId,
    );

    if (approval === undefined) {
      return decideAdmittedRunToolApprovalResultSchema.parse({
        decided: false,
        ok: true,
      });
    }

    const toolCallId = await canonicalToolCallId(capability.runId, approval.descriptor.toolCallId);
    const record = await this.#readRunRecord(capability.runId);

    if (record === undefined || Date.now() >= record.deadlineAt) {
      return INVALID_RUN_ADMISSION;
    }

    this.#approvalTurnMetadata = {
      budgetReservation: record.budgetReservation,
      configuration: record.configuration,
      promptCharacters: record.promptCharacters,
      promptDigest: record.promptDigest,
      runId: capability.runId,
    };
    this.#permittedApprovalContinuationRunId = capability.runId;
    let decided = false;

    try {
      if (capability.action === "approve_tool") {
        await super.approveExecution(capability.executionId);
      } else {
        await super.rejectExecution(capability.executionId, "Rejected by the Crewhelm owner.");
      }
      decided = true;
    } finally {
      this.#approvalTurnMetadata = undefined;

      if (!decided) {
        this.#permittedApprovalContinuationRunId = undefined;
      }
    }

    await this.ctx.storage.delete(toolApprovalKey(capability.runId, toolCallId));

    return decideAdmittedRunToolApprovalResultSchema.parse({
      decided: true,
      ok: true,
    });
  }

  async expireAdmittedRun(input: unknown): Promise<void> {
    const request = scheduledRunInputSchema.safeParse(input);

    if (!request.success) {
      return;
    }

    const record = await this.#readRunRecord(request.data.runId);

    if (record === undefined || Date.now() < record.deadlineAt) {
      return;
    }

    const submission = await super.inspectSubmission(request.data.runId);

    if (
      submission === null ||
      ["aborted", "completed", "error", "skipped"].includes(submission.status)
    ) {
      return;
    }

    await this.cancelAdmittedSubmission(request.data.runId, "Crewhelm run deadline exceeded.");
  }

  async syncAgentInbox(input: unknown): Promise<void> {
    const request = scheduledInboxProjectionInputSchema.safeParse(input);

    if (!request.success) {
      return;
    }

    const runId = request.data.outbox.projection.reference.runId;
    const key = inboxProjectionKey(runId);
    const stored = agentInboxProjectionOutboxSchema.safeParse(await this.ctx.storage.get(key));
    const outbox = stored.success ? stored.data : request.data.outbox;

    if (!stored.success && Date.now() >= outbox.cleanupAt) {
      return;
    }

    if (!stored.success) {
      await this.ctx.storage.put(key, outbox);
    }

    if (Date.now() < outbox.retryAt) {
      await this.#scheduleInboxProjection(outbox, outbox.retryAt);
      return;
    }

    await this.#deliverInboxProjection(runId, request.data.outbox.attempts);
  }

  async cleanupAdmittedRun(input: unknown): Promise<void> {
    const request = scheduledRunInputSchema.safeParse(input);

    if (!request.success) {
      return;
    }

    const record = await this.#readRunRecord(request.data.runId);

    if (record === undefined || Date.now() < record.cleanupAt) {
      return;
    }

    const submission = await super.inspectSubmission(request.data.runId);

    if (
      submission !== null &&
      !["aborted", "completed", "error", "skipped"].includes(submission.status)
    ) {
      await this.cancelAdmittedSubmission(request.data.runId, "Crewhelm run retention expired.");
    }

    const branches = await Session.create(this).getBranches(runUserMessageId(request.data.runId));

    await Session.create(this).deleteMessages([
      runUserMessageId(request.data.runId),
      ...branches.map((message) => message.id),
    ]);

    if (submission !== null) {
      await super.deleteSubmission(request.data.runId);
    }

    const approvalRecords = await this.ctx.storage.list({
      prefix: toolApprovalPrefix(request.data.runId),
    });
    await Promise.all([...approvalRecords.keys()].map((key) => this.ctx.storage.delete(key)));
    await this.ctx.storage.delete(inboxProjectionKey(request.data.runId));
    await this.ctx.storage.delete(runTraceKey(request.data.runId));
    await this.ctx.storage.delete(runRecordKey(request.data.runId));
  }

  protected async cancelAdmittedSubmission(runId: string, reason: string): Promise<void> {
    this.#permittedAbortRequestId = runId;

    try {
      await super.cancelSubmission(runId, reason);
    } finally {
      this.#permittedAbortRequestId = undefined;
    }
  }

  override getAIBinding(): ReturnType<Think["getAIBinding"]> {
    this.#activeRuntimeConfig();
    const gatewayId = this.env.AI_GATEWAY_ID;

    if (gatewayId === undefined) {
      return super.getAIBinding();
    }

    if (this.#gatewayAiBinding !== undefined) {
      return this.#gatewayAiBinding;
    }

    const binding = super.getAIBinding();
    const run = binding.run.bind(binding) as (
      model: string,
      input: Record<string, unknown>,
      options?: {
        extraHeaders?: Record<string, unknown>;
        gateway?: {
          collectLog?: boolean;
          id: string;
          metadata?: Record<string, string | number | boolean | null>;
        };
      },
    ) => Promise<unknown>;

    this.#gatewayAiBinding = new Proxy(binding, {
      get: (target, property) => {
        if (property !== "run") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }

        return async (
          model: string,
          input: Record<string, unknown>,
          options: {
            extraHeaders?: Record<string, unknown>;
            gateway?: {
              collectLog?: boolean;
              id: string;
              metadata?: Record<string, string | number | boolean | null>;
            };
          } = {},
        ) => {
          const reference = await this.#activeRunReference();

          if (reference === undefined) {
            throw runtimeAdmissionError();
          }

          const previousGatewayLogId = binding.aiGatewayLogId;

          try {
            return await run(model, input, {
              ...options,
              extraHeaders: {
                ...options.extraHeaders,
                "cf-aig-collect-log-payload": "false",
              },
              gateway: {
                collectLog: true,
                id: gatewayId,
                metadata: {
                  ...options.gateway?.metadata,
                  crewhelm_agent: reference.agentId,
                  crewhelm_run: reference.runId,
                },
              },
            });
          } finally {
            const gatewayLogId = binding.aiGatewayLogId;

            if (gatewayLogId !== null && gatewayLogId !== previousGatewayLogId) {
              this.ctx.waitUntil(
                this.env.OWNER_CONTROL_PLANE.getByName(reference.ownerKey).recordAiGatewayCall({
                  gatewayLogId,
                  reference,
                }),
              );
            }
          }
        };
      },
    });

    return this.#gatewayAiBinding;
  }

  override resolveModel(model?: ThinkModel): ReturnType<Think["resolveModel"]> {
    const configuration = this.#activeRuntimeConfig();
    const selectedModel = model ?? this.getModel();

    if (typeof selectedModel === "string" && selectedModel !== configuration.model) {
      throw runtimeAdmissionError();
    }

    return super.resolveModel(selectedModel);
  }

  override getModel(): ThinkModel {
    return this.#activeRuntimeConfig().model;
  }

  override getSystemPrompt(): string {
    return this.#activeRuntimeConfig().instructions;
  }

  override getTools(): ToolSet {
    return {};
  }

  override getActions(): Record<string, Action> {
    const adapters = this.#activeToolAdapters();

    return Object.fromEntries(
      adapters.map((adapter) => [
        adapter.name,
        defineAction({
          approval: requiresToolApproval(adapter.grant),
          approvalRisk: adapter.grant.effect === "destructive" ? "high" : "medium",
          approvalSummary: adapter.approvalSummary,
          description: adapter.description,
          execute: (input, context) => this.#executeTool(adapter, input, context),
          inputSchema: adapter.inputSchema,
          kind: requiresToolApproval(adapter.grant) ? "durable-pause" : "server",
          name: adapter.name,
          permissions: [adapter.grant.grantId],
          timeoutMs: adapter.grant.limits.maxDurationMs,
        }),
      ]),
    );
  }

  override beforeTurn(context?: TurnContext): TurnConfig {
    const configuration = this.#activeRuntimeConfig();
    const metadata = this.#activeTurnMetadata();
    const promptMessage = context?.messages.at(-1);
    const approvalContinuation =
      context?.continuation === true && this.#permittedApprovalContinuationRunId === metadata.runId;

    if (
      context === undefined ||
      (!approvalContinuation && (context.continuation || promptMessage?.role !== "user"))
    ) {
      throw new Error("CrewAgent admitted model input is missing or invalid.");
    }

    const messages = approvalContinuation
      ? context.messages.filter((message) => message.role !== "system")
      : promptMessage === undefined
        ? []
        : [promptMessage];

    if (approvalContinuation) {
      this.#permittedApprovalContinuationRunId = undefined;
    }

    return {
      activeTools: approvalContinuation
        ? []
        : this.#activeToolAdapters().map((adapter) => adapter.name),
      instructions: configuration.instructions,
      maxOutputTokens: metadata.budgetReservation.maxOutputTokens,
      maxRetries: 0,
      maxSteps: approvalContinuation ? 1 : metadata.budgetReservation.maxTurns,
      messages,
      sendReasoning: false,
    };
  }

  override async authorizeTurn(_context?: TurnContext): Promise<ActionAuthorizationDecision> {
    try {
      const reference = await this.#activeRunReference();

      if (reference !== undefined) {
        return {
          allowed: true,
          grantedPermissions: reference.budgetReservation.toolGrants.map((grant) => grant.grantId),
        };
      }
    } catch {
      // Return the same generic boundary error for missing, malformed, or unavailable run state.
    }

    throw new Error("CrewAgent active run admission is missing or invalid.");
  }

  override async beforeStep(_context: PrepareStepContext): Promise<StepConfig | void> {
    const reference = await this.#activeRunReference();

    if (reference === undefined) {
      throw new Error("CrewAgent active run admission is no longer valid.");
    }

    let verification: unknown;

    try {
      verification = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).verifyActiveRunAdmission({
        ...reference,
      });
    } catch {
      throw new Error("CrewAgent active run admission could not be verified.");
    }

    const verified = verifyActiveRunAdmissionResultSchema.safeParse(verification);

    if (!verified.success || !verified.data.ok || verified.data.runId !== reference.runId) {
      throw new Error("CrewAgent active run admission is no longer valid.");
    }
  }

  override async onChatResponse(result: ChatResponseResult): Promise<void> {
    const metadata = admittedTurnMetadataSchema.safeParse(this.activeTurnMetadata);
    const runId = metadata.success ? metadata.data.crewhelmRun.runId : result.requestId;
    const record = await this.#readRunRecord(runId);

    if (record === undefined || result.requestId !== runId) {
      return;
    }

    const approvalRecords = await this.ctx.storage.list({
      prefix: toolApprovalPrefix(runId),
    });
    const approvalCount = approvalRecords.size;
    const status = result.status === "aborted" ? "cancelled" : result.status;
    const kind =
      approvalCount > 0
        ? "action_required"
        : status === "completed" || status === "cancelled"
          ? "outcome"
          : "exception";

    await this.#publishInboxProjection(
      record,
      recordAgentInboxRunInputSchema.parse({
        event: {
          approvalCount: kind === "action_required" ? approvalCount : 0,
          kind,
          occurredAt: new Date().toISOString(),
          resultPreview: kind === "outcome" ? resultPreview(result.message) : null,
          runStatus:
            kind === "action_required"
              ? "running"
              : status === "completed"
                ? "completed"
                : status === "cancelled"
                  ? "cancelled"
                  : "failed",
        },
        reference: {
          agentId: record.configuration.agentId,
          agentRevision: record.configuration.revision,
          idempotencyKey: record.idempotencyKey,
          ownerKey: record.configuration.ownerKey,
          promptDigest: record.promptDigest,
          runId,
        },
      }),
    );
  }

  override authorizeAction(
    context?: ActionAuthorizationContext,
  ): ActionAuthorizationDecision | Promise<ActionAuthorizationDecision> {
    if (context === undefined) {
      return false;
    }

    return this.#authorizeToolAction(context);
  }

  async #authorizeToolAction(
    context: ActionAuthorizationContext,
  ): Promise<ActionAuthorizationDecision> {
    const startedAt = performance.now();
    const adapter = this.#activeToolAdapters().find(
      (candidate) => candidate.name === context.action,
    );
    const reference = await this.#activeRunReference();
    const toolCallId =
      reference === undefined
        ? undefined
        : await canonicalToolCallId(reference.runId, context.toolCallId);

    if (
      reference === undefined ||
      toolCallId === undefined ||
      adapter === undefined ||
      context.requiredPermissions.length !== 1 ||
      context.requiredPermissions[0] !== adapter.grant.grantId
    ) {
      if (reference !== undefined && toolCallId !== undefined) {
        await this.#recordToolAuthorization({
          ...(adapter === undefined ? {} : { adapter }),
          checkpoint: "action_authorization",
          outcome: "blocked",
          reason: adapter === undefined ? "action_unavailable" : "action_invalid",
          runId: reference.runId,
          startedAt,
          toolCallId,
        });
      }
      return false;
    }

    if (adapter.grant.effect === "read") {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "allowed",
        runId: reference.runId,
        startedAt,
        toolCallId,
      });
      return true;
    }

    const action = await this.#classifyTool(adapter, context.toolCallId, context.input);

    if (action === undefined) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "blocked",
        reason: "action_invalid",
        runId: reference.runId,
        startedAt,
        toolCallId,
      });
      return false;
    }

    let result: unknown;

    try {
      result = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).evaluateToolExecution({ ...reference, action });
    } catch {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "blocked",
        reason: "policy_unavailable",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return false;
    }

    const evaluation = evaluateToolExecutionResultSchema.safeParse(result);

    if (!evaluation.success) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "blocked",
        reason: "policy_response_invalid",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return false;
    }

    if (!evaluation.data.ok) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "blocked",
        reason: evaluation.data.error.reason,
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return false;
    }

    if (evaluation.data.decision.decision === "deny") {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "blocked",
        reason: evaluation.data.decision.reason,
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return false;
    }

    if (evaluation.data.decision.decision === "requires_approval") {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "approval_required",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      const requestedAt = Date.now();
      const approvalKey = toolApprovalKey(reference.runId, action.toolCallId);
      const existing = pendingToolApprovalRecordSchema.safeParse(
        await this.ctx.storage.get(approvalKey),
      );

      if (
        existing.success &&
        existing.data.runId === reference.runId &&
        existing.data.actionDigest === evaluation.data.decision.actionDigest &&
        Date.parse(existing.data.expiresAt) > requestedAt
      ) {
        return false;
      }

      await this.ctx.storage.put(
        approvalKey,
        pendingToolApprovalRecordSchema.parse({
          action: context.action,
          actionDigest: evaluation.data.decision.actionDigest,
          effect: evaluation.data.decision.effect,
          expiresAt: new Date(requestedAt + TOOL_APPROVAL_LIFETIME_MS).toISOString(),
          grantId: adapter.grant.grantId,
          requestedAt: new Date(requestedAt).toISOString(),
          risk: evaluation.data.decision.effect === "destructive" ? "high" : "medium",
          runId: reference.runId,
          summary: adapter.approvalSummary,
          toolCallId: action.toolCallId,
        }),
      );
      const record = await this.#readRunRecord(reference.runId);

      if (record !== undefined) {
        this.ctx.waitUntil(
          this.#publishInboxProjection(
            record,
            recordAgentInboxRunInputSchema.parse({
              event: {
                approvalCount: 1,
                kind: "action_required",
                occurredAt: new Date(requestedAt).toISOString(),
                resultPreview: null,
                runStatus: "running",
              },
              reference: {
                agentId: reference.agentId,
                agentRevision: reference.agentRevision,
                idempotencyKey: reference.idempotencyKey,
                ownerKey: reference.ownerKey,
                promptDigest: reference.promptDigest,
                runId: reference.runId,
              },
            }),
          ),
        );
      }
    }

    if (evaluation.data.decision.decision === "allow") {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "action_authorization",
        outcome: "allowed",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
    }

    return true;
  }

  override async beforeToolCall(context: ToolCallContext): Promise<ToolCallDecision> {
    const startedAt = performance.now();
    const adapter = this.#activeToolAdapters().find(
      (candidate) => candidate.name === context.toolName,
    );
    const reference = await this.#activeRunReference();
    const toolCallId =
      reference === undefined
        ? undefined
        : await canonicalToolCallId(reference.runId, context.toolCallId);

    if (adapter === undefined || reference === undefined || toolCallId === undefined) {
      if (reference !== undefined && toolCallId !== undefined) {
        await this.#recordToolAuthorization({
          ...(adapter === undefined ? {} : { adapter }),
          checkpoint: "pre_execution",
          outcome: "blocked",
          reason: adapter === undefined ? "action_unavailable" : "run_unavailable",
          runId: reference.runId,
          startedAt,
          toolCallId,
        });
      }
      return { action: "block", reason: "Tool execution denied." };
    }

    const action = await this.#classifyTool(adapter, context.toolCallId, context.input);

    if (action === undefined) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: "action_invalid",
        runId: reference.runId,
        startedAt,
        toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    let evaluationResult: unknown;

    try {
      evaluationResult = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).evaluateToolExecution({ ...reference, action });
    } catch {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: "policy_unavailable",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    const evaluation = evaluateToolExecutionResultSchema.safeParse(evaluationResult);
    const expectedDecision = requiresToolApproval(adapter.grant) ? "requires_approval" : "allow";

    if (!evaluation.success) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: "policy_response_invalid",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    if (!evaluation.data.ok) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: evaluation.data.error.reason,
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    if (evaluation.data.decision.decision === "deny") {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: evaluation.data.decision.reason,
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    if (evaluation.data.decision.decision !== expectedDecision) {
      await this.#recordToolAuthorization({
        adapter,
        checkpoint: "pre_execution",
        outcome: "blocked",
        reason: "policy_decision_mismatch",
        runId: reference.runId,
        startedAt,
        toolCallId: action.toolCallId,
      });
      return { action: "block", reason: "Tool execution denied." };
    }

    await this.#recordToolAuthorization({
      adapter,
      checkpoint: "pre_execution",
      outcome: evaluation.data.decision.decision === "allow" ? "allowed" : "approval_required",
      runId: reference.runId,
      startedAt,
      toolCallId: action.toolCallId,
    });

    return { action: "allow" };
  }

  async #submitAdmittedRun(
    runId: string,
    prompt: string,
    record: AdmittedRunRecord,
  ): Promise<AcceptRunAdmissionResult> {
    if (Date.now() >= record.deadlineAt) {
      return INVALID_RUN_ADMISSION;
    }

    await this.#scheduleRunLifecycle(runId, record);

    let submission: SubmitMessagesResult;
    const startedAt = performance.now();

    try {
      const turnMetadata = admittedTurnMetadataSchema.parse({
        crewhelmRun: {
          budgetReservation: record.budgetReservation,
          configuration: record.configuration,
          promptCharacters: record.promptCharacters,
          promptDigest: record.promptDigest,
          runId,
        },
      });
      const message: UIMessage = {
        id: runUserMessageId(runId),
        metadata: { turnMetadata },
        parts: [{ text: prompt, type: "text" }],
        role: "user",
      };

      await Session.create(this).appendMessage(message, null);
      submission = await super.submitMessages([message], {
        idempotencyKey: runId,
        metadata: { crewhelmRunId: runId },
        submissionId: runId,
      });
    } catch {
      recordExecutionEvent({
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        outcome: "rejected",
        phase: "run.submission",
        runId,
      });
      return INVALID_RUN_ADMISSION;
    }

    recordExecutionEvent({
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome: submission.accepted ? "accepted" : "rejected",
      phase: "run.submission",
      runId,
    });

    return acceptRunAdmissionResultSchema.parse({
      accepted: submission.accepted,
      agentId: record.configuration.agentId,
      agentRevision: record.configuration.revision,
      ok: true,
      runId,
    });
  }

  protected createToolAdapter(
    grant: ComposioToolCapabilityGrant,
  ): CrewAgentToolAdapter | undefined {
    if (grant.capabilityId !== "composio.tool.execute") {
      return undefined;
    }

    const schemaRuntime = createComposioRuntime({ apiKey: this.env.COMPOSIO_API_KEY });
    let inputSchema: z.ZodType<Record<string, unknown>>;

    try {
      inputSchema = schemaRuntime.createInputSchema(grant.tool.inputParametersJson);
    } catch {
      return undefined;
    }

    const suffix = grant.grantId.slice(-8);
    const normalizedSlug = grant.toolSlug.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_");
    const name = `composio_${normalizedSlug.slice(0, 46)}_${suffix}`;

    return {
      approvalSummary: grant.tool.name,
      description: grant.tool.description ?? grant.tool.name,
      grant,
      inputSchema,
      name,
      classify: async (input, context) => {
        return {
          agentId: grant.agentId,
          agentRevision: grant.agentRevision,
          capabilityId: grant.capabilityId,
          connectionId: grant.connectionId,
          effect: grant.effect,
          estimatedCostMicrousd: grant.limits.maxCostMicrousdPerCall,
          grantId: grant.grantId,
          inputDigest: await digestToolInput(input),
          integrationSlug: grant.integrationSlug,
          ownerKey: grant.ownerKey,
          runId: context.runId,
          targetDigests: grant.targetDigests,
          toolCallId: context.toolCallId,
          toolkitVersion: grant.toolkitVersion,
          toolSlug: grant.toolSlug,
        };
      },
      execute: async (input, context) => {
        const runtime = createComposioRuntime({
          apiKey: this.env.COMPOSIO_API_KEY,
          onResponse: (event) =>
            recordExecutionProviderResponse({
              ...event,
              runId: context.permit.action.runId,
              toolCallId: context.permit.action.toolCallId,
            }),
        });
        const resolved = resolveToolExecutionConnectionResultSchema.safeParse(
          await this.env.OWNER_CONTROL_PLANE.getByName(
            context.permit.action.ownerKey,
          ).resolveToolExecutionConnection(context.permit),
        );

        if (!resolved.success || !resolved.data.ok) {
          throw new Error("Composio tool execution denied.");
        }

        const providerConnectionId = resolved.data.providerConnectionId;
        const startedAt = performance.now();

        try {
          const verified = await runtime.verifyConnection(providerConnectionId, context.signal);

          if (!verified.ok || verified.toolkitSlug !== grant.integrationSlug) {
            throw new Error("Composio tool execution denied.");
          }

          const output = await runtime.execute({
            arguments: input,
            maximumOutputBytes: context.permit.constraints.maxOutputBytes,
            providerConnectionId,
            signal: context.signal,
            timeoutMs: context.permit.constraints.maxDurationMs,
            toolkitVersion: grant.toolkitVersion,
            toolSlug: grant.toolSlug,
            userId: grant.ownerKey,
          });

          recordExecutionEvent({
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            outcome: "completed",
            phase: "tool.provider",
            runId: context.permit.action.runId,
            toolCallId: context.permit.action.toolCallId,
          });
          return output;
        } catch (error) {
          recordExecutionEvent({
            durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            outcome: "failed",
            phase: "tool.provider",
            runId: context.permit.action.runId,
            toolCallId: context.permit.action.toolCallId,
          });
          throw error;
        }
      },
    };
  }

  #activeToolAdapters(): CrewAgentToolAdapter[] {
    const metadata = this.#activeTurnMetadata();
    const available: CrewAgentToolAdapter[] = [];

    for (const grant of metadata.budgetReservation.toolGrants) {
      const adapter = this.createToolAdapter(grant);

      if (adapter === undefined) {
        throw new Error("CrewAgent admitted tool capability is unavailable.");
      }

      available.push(adapter);
    }

    const names = new Set<string>();

    for (const [index, adapter] of available.entries()) {
      const grant = metadata.budgetReservation.toolGrants[index];

      if (
        grant === undefined ||
        adapter.grant.grantId !== grant.grantId ||
        JSON.stringify(adapter.grant) !== JSON.stringify(grant) ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(adapter.name) ||
        names.has(adapter.name)
      ) {
        throw new Error("CrewAgent admitted tool registry is invalid.");
      }

      names.add(adapter.name);
    }

    return available;
  }

  async #classifyTool(
    adapter: CrewAgentToolAdapter,
    frameworkToolCallId: string,
    input: unknown,
  ): Promise<ClassifiedComposioToolAction | undefined> {
    const validatedInput = adapter.inputSchema.safeParse(input);

    if (!validatedInput.success) {
      return undefined;
    }

    const metadata = this.#activeTurnMetadata();
    const parsed = classifiedComposioToolActionSchema.safeParse(
      await adapter.classify(validatedInput.data, {
        runId: metadata.runId,
        toolCallId: await canonicalToolCallId(metadata.runId, frameworkToolCallId),
      }),
    );

    if (
      !parsed.success ||
      parsed.data.ownerKey !== metadata.configuration.ownerKey ||
      parsed.data.agentId !== metadata.configuration.agentId ||
      parsed.data.agentRevision !== metadata.configuration.revision ||
      parsed.data.runId !== metadata.runId ||
      parsed.data.grantId !== adapter.grant.grantId ||
      parsed.data.capabilityId !== adapter.grant.capabilityId ||
      parsed.data.connectionId !== adapter.grant.connectionId ||
      parsed.data.effect !== adapter.grant.effect ||
      parsed.data.integrationSlug !== adapter.grant.integrationSlug ||
      parsed.data.toolSlug !== adapter.grant.toolSlug ||
      parsed.data.toolkitVersion !== adapter.grant.toolkitVersion
    ) {
      return undefined;
    }

    return parsed.data;
  }

  async #executeTool(
    adapter: CrewAgentToolAdapter,
    input: Record<string, unknown>,
    context: ActionContext,
  ): Promise<unknown> {
    const action = await this.#classifyTool(adapter, context.toolCallId, input);

    if (action === undefined) {
      throw new Error("Tool execution denied.");
    }

    const reference = await this.#activeRunReference();

    if (reference === undefined) {
      throw new Error("Tool execution denied.");
    }

    let result: unknown;

    try {
      result = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).reserveToolExecution({ ...reference, action });
    } catch {
      throw new Error("Tool execution denied.");
    }

    const reservation = reserveToolExecutionResultSchema.safeParse(result);

    if (!reservation.success || !reservation.data.ok || reservation.data.state !== "allowed") {
      throw new Error("Tool execution denied.");
    }

    const permit = reservation.data.permit;

    if (
      permit.action.grantId !== adapter.grant.grantId ||
      JSON.stringify(permit.action) !== JSON.stringify(action) ||
      !isToolExecutionPermitFresh(permit)
    ) {
      throw new Error("Tool execution denied.");
    }

    let output: unknown;
    let outputBytes = 0;
    let status: "completed" | "failed" | "unknown" = "unknown";

    try {
      output = await adapter.execute(input, { permit, signal: context.signal });
      const serialized = JSON.stringify(output);

      if (serialized === undefined) {
        throw new Error("Tool result is not serializable.");
      }

      outputBytes = new TextEncoder().encode(serialized).byteLength;

      if (outputBytes > permit.constraints.maxOutputBytes) {
        status = "unknown";
        throw new Error("Tool result exceeded its output limit.");
      }

      status = "completed";
    } catch {
      output = undefined;
    }

    let completion: unknown;

    try {
      completion = await this.env.OWNER_CONTROL_PLANE.getByName(
        permit.action.ownerKey,
      ).completeToolExecution({
        outcome: { outputBytes, status },
        permit,
      });
    } catch {
      throw new Error("Tool execution outcome could not be recorded.");
    }

    const completed = completeToolExecutionResultSchema.safeParse(completion);

    if (!completed.success || !completed.data.ok || !completed.data.completed) {
      throw new Error("Tool execution outcome could not be recorded.");
    }

    if (status !== "completed") {
      throw new Error("Tool execution failed.");
    }

    return output;
  }

  async #activeRunReference() {
    const metadata = this.#activeTurnMetadata();
    const record = await this.#readRunRecord(metadata.runId);

    if (
      record === undefined ||
      Date.now() >= record.deadlineAt ||
      record.promptCharacters !== metadata.promptCharacters ||
      record.promptDigest !== metadata.promptDigest ||
      JSON.stringify(record.budgetReservation) !== JSON.stringify(metadata.budgetReservation) ||
      JSON.stringify(record.configuration) !== JSON.stringify(metadata.configuration) ||
      !this.#objectMatches(record.configuration.ownerKey, record.configuration.agentId)
    ) {
      return undefined;
    }

    return {
      agentId: record.configuration.agentId,
      agentRevision: record.configuration.revision,
      budgetReservation: record.budgetReservation,
      clientId: record.clientId,
      idempotencyKey: record.idempotencyKey,
      ownerKey: record.configuration.ownerKey,
      promptDigest: record.promptDigest,
      runId: metadata.runId,
    };
  }

  async #publishInboxProjection(
    record: AdmittedRunRecord,
    projection: RecordAgentInboxRunInput,
  ): Promise<void> {
    const currentTime = Date.now();
    const outbox = agentInboxProjectionOutboxSchema.parse({
      attempts: 0,
      cleanupAt: record.cleanupAt,
      projection,
      retryAt: currentTime,
    });

    const recovery = await this.#scheduleInboxProjection(
      outbox,
      currentTime + INBOX_PROJECTION_SAFETY_WAKEUP_MS,
    );
    await this.ctx.storage.put(inboxProjectionKey(projection.reference.runId), outbox);
    const delivered = await this.#deliverInboxProjection(projection.reference.runId, 0);

    if (delivered) {
      await super.cancelSchedule(recovery.id);
    }
  }

  async #deliverInboxProjection(runId: string, scheduledAttempts: number): Promise<boolean> {
    const key = inboxProjectionKey(runId);
    const stored = agentInboxProjectionOutboxSchema.safeParse(await this.ctx.storage.get(key));

    if (!stored.success) {
      return false;
    }

    const currentTime = Date.now();

    if (currentTime >= stored.data.cleanupAt) {
      await this.#deleteInboxProjectionIfCurrent(key, stored.data);
      return true;
    }

    try {
      const result = recordAgentInboxRunResultSchema.safeParse(
        await this.env.OWNER_CONTROL_PLANE.getByName(
          stored.data.projection.reference.ownerKey,
        ).recordAgentInboxRun(stored.data.projection),
      );

      if (result.success) {
        await this.#deleteInboxProjectionIfCurrent(key, stored.data);
        return true;
      }
    } catch {
      // The durable outbox retries transient owner-control-plane delivery failures.
    }

    const attempts = Math.min(100, Math.max(stored.data.attempts, scheduledAttempts) + 1);
    const delay = Math.min(
      INBOX_PROJECTION_MAXIMUM_RETRY_MS,
      INBOX_PROJECTION_MINIMUM_RETRY_MS * 2 ** Math.min(6, attempts - 1),
    );
    const retryAt = currentTime + delay;

    if (retryAt >= stored.data.cleanupAt) {
      return false;
    }

    const replacement = agentInboxProjectionOutboxSchema.parse({
      ...stored.data,
      attempts,
      retryAt,
    });

    await this.#scheduleInboxProjection(replacement, retryAt);
    await this.#replaceInboxProjectionIfCurrent(key, stored.data, replacement);
    return false;
  }

  async #scheduleInboxProjection(
    outbox: AgentInboxProjectionOutbox,
    retryAt: number,
  ): Promise<{ id: string }> {
    const wakeupAt = Math.ceil(retryAt / 1_000) * 1_000;

    return super.schedule(
      new Date(wakeupAt),
      "syncAgentInbox",
      {
        outbox,
        wakeupAt,
      },
      { idempotent: true },
    );
  }

  async #deleteInboxProjectionIfCurrent(
    key: string,
    expected: AgentInboxProjectionOutbox,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = agentInboxProjectionOutboxSchema.safeParse(await transaction.get(key));

      if (current.success && JSON.stringify(current.data) === JSON.stringify(expected)) {
        await transaction.delete(key);
      }
    });
  }

  async #replaceInboxProjectionIfCurrent(
    key: string,
    expected: AgentInboxProjectionOutbox,
    replacement: AgentInboxProjectionOutbox,
  ): Promise<boolean> {
    let replaced = false;

    await this.ctx.storage.transaction(async (transaction) => {
      const current = agentInboxProjectionOutboxSchema.safeParse(await transaction.get(key));

      if (current.success && JSON.stringify(current.data) === JSON.stringify(expected)) {
        await transaction.put(key, replacement);
        replaced = true;
      }
    });

    return replaced;
  }

  async #readRunRecord(runId: string): Promise<AdmittedRunRecord | undefined> {
    const stored = await this.ctx.storage.get(runRecordKey(runId));

    if (stored === undefined) {
      return undefined;
    }

    return admittedRunRecordSchema.parse(stored);
  }

  async #readRunTrace(runId: string): Promise<ToolAuthorizationTimelineEvent[]> {
    const stored = await this.ctx.storage.get(runTraceKey(runId));

    if (stored === undefined) {
      return [];
    }

    const trace = z.array(toolAuthorizationTimelineEventSchema).safeParse(stored);
    return trace.success ? trace.data : [];
  }

  async #recordToolAuthorization(input: {
    adapter?: CrewAgentToolAdapter;
    checkpoint: "action_authorization" | "pre_execution";
    outcome: "allowed" | "approval_required" | "blocked";
    reason?: ToolAuthorizationFailureReason;
    runId: string;
    startedAt: number;
    toolCallId: string;
  }): Promise<void> {
    const occurredAt = new Date().toISOString();

    recordExecutionEvent({
      ...(input.adapter === undefined
        ? {}
        : {
            agentId: input.adapter.grant.agentId,
            agentRevision: input.adapter.grant.agentRevision,
            authorization: input.adapter.grant.authorization,
            connectionId: input.adapter.grant.connectionId,
            effect: input.adapter.grant.effect,
            grantId: input.adapter.grant.grantId,
            integrationSlug: input.adapter.grant.integrationSlug,
            toolSlug: input.adapter.grant.toolSlug,
          }),
      checkpoint: input.checkpoint,
      durationMs: Math.max(0, Math.round(performance.now() - input.startedAt)),
      outcome: input.outcome,
      phase: "tool.authorization",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      runId: input.runId,
      toolCallId: input.toolCallId,
    });

    if (input.checkpoint !== "pre_execution") {
      return;
    }

    const event = toolAuthorizationTimelineEventSchema.parse({
      event:
        input.outcome === "allowed"
          ? "tool.authorization_allowed"
          : input.outcome === "approval_required"
            ? "tool.authorization_approval_required"
            : "tool.authorization_blocked",
      occurredAt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      toolCallId: input.toolCallId,
    });

    try {
      await this.ctx.storage.transaction(async (transaction) => {
        const stored = await transaction.get(runTraceKey(input.runId));
        const parsed =
          stored === undefined
            ? { data: [] as ToolAuthorizationTimelineEvent[], success: true as const }
            : z.array(toolAuthorizationTimelineEventSchema).safeParse(stored);

        if (!parsed.success) {
          return;
        }

        const duplicate = parsed.data.some(
          (candidate) =>
            candidate.event === event.event &&
            candidate.toolCallId === event.toolCallId &&
            ("reason" in candidate ? candidate.reason : undefined) ===
              ("reason" in event ? event.reason : undefined),
        );

        if (duplicate) {
          return;
        }

        await transaction.put(runTraceKey(input.runId), [
          ...parsed.data.slice(-(MAXIMUM_RUN_TIMELINE_EVENTS - 1)),
          event,
        ]);
      });
    } catch {
      // Diagnostic trace persistence must not alter execution.
    }
  }

  async #redeemReceiverCapability(capability: RunReceiverCapability): Promise<boolean> {
    let record: AdmittedRunRecord | undefined;

    try {
      record = await this.#readRunRecord(capability.runId);
    } catch {
      return false;
    }

    if (
      record === undefined ||
      Date.parse(capability.expiresAt) <= Date.now() ||
      !this.#objectMatches(record.configuration.ownerKey, record.configuration.agentId) ||
      !this.#recordMatchesCapability(record, capability, record.promptCharacters)
    ) {
      return false;
    }

    let verification: unknown;

    try {
      verification = await this.env.OWNER_CONTROL_PLANE.getByName(
        record.configuration.ownerKey,
      ).redeemRunReceiverCapability(capability);
    } catch {
      return false;
    }

    const verified = redeemRunReceiverCapabilityResultSchema.safeParse(verification);
    return verified.success && verified.data.ok && verified.data.runId === capability.runId;
  }

  async #scheduleRunLifecycle(runId: string, record: AdmittedRunRecord): Promise<void> {
    await super.schedule(
      new Date(record.deadlineAt),
      "expireAdmittedRun",
      { runId },
      {
        idempotent: true,
      },
    );
    await super.schedule(
      new Date(record.cleanupAt),
      "cleanupAdmittedRun",
      { runId },
      {
        idempotent: true,
      },
    );
  }

  #readRunOutput(
    runId: string,
  ): { state: "available"; text: string; truncated: boolean } | { state: "pending" } | undefined {
    const terminalMessage = super.sql<{
      id: string;
      pending: number;
      role: "assistant" | "system";
    }>`
      WITH RECURSIVE run_messages(id, depth) AS (
        SELECT id, 0
        FROM assistant_messages
        WHERE session_id = ''
          AND id = ${runUserMessageId(runId)}
        UNION ALL
        SELECT child.id, parent.depth + 1
        FROM assistant_messages AS child
        INNER JOIN run_messages AS parent ON child.parent_id = parent.id
        WHERE child.session_id = ''
      )
      SELECT
        message.id,
        message.role,
        EXISTS (
          SELECT 1
          FROM json_each(message.content, '$.parts') AS candidate
          WHERE json_extract(candidate.value, '$.approvalDescriptor.kind') = 'durable-pause'
        ) AS pending
      FROM assistant_messages AS message
      INNER JOIN run_messages AS branch ON branch.id = message.id
      WHERE message.session_id = ''
        AND (
          (
            message.role = 'assistant'
            AND (
              EXISTS (
                SELECT 1
                FROM json_each(message.content, '$.parts') AS candidate
                WHERE json_extract(candidate.value, '$.type') = 'text'
                  AND typeof(json_extract(candidate.value, '$.text')) = 'text'
              )
              OR EXISTS (
                SELECT 1
                FROM json_each(message.content, '$.parts') AS candidate
                WHERE json_extract(candidate.value, '$.approvalDescriptor.kind') = 'durable-pause'
              )
            )
          )
          OR (
            message.role = 'system'
            AND EXISTS (
              SELECT 1
              FROM json_each(message.content, '$.parts') AS candidate
              WHERE json_extract(candidate.value, '$.type') = 'text'
                AND typeof(json_extract(candidate.value, '$.text')) = 'text'
                AND json_extract(candidate.value, '$.text') LIKE ${`${EXECUTION_OUTCOME_PREFIX}%`}
                AND instr(
                  json_extract(candidate.value, '$.text'),
                  ${EXECUTION_OUTCOME_MARKER}
                ) > 0
            )
          )
        )
      ORDER BY branch.depth DESC, message.created_at DESC, message.id DESC
      LIMIT 1
    `[0];

    if (terminalMessage === undefined) {
      return undefined;
    }

    if (terminalMessage.pending === 1) {
      return { state: "pending" };
    }

    const text: string[] = [];
    let remaining = MAXIMUM_RUN_OUTPUT_CHARACTERS;
    let truncated = false;

    for (let offset = 0; offset < MAXIMUM_RUN_OUTPUT_PARTS; offset += 1) {
      const row = super.sql<{ originalCharacters: number; text: string }>`
        WITH terminal_parts AS (
          SELECT
            CASE
              WHEN message.role = 'system'
              THEN substr(
                json_extract(part.value, '$.text'),
                instr(
                  json_extract(part.value, '$.text'),
                  ${EXECUTION_OUTCOME_MARKER}
                ) + ${EXECUTION_OUTCOME_MARKER.length}
              )
              ELSE json_extract(part.value, '$.text')
            END AS text,
            CAST(part.key AS INTEGER) AS part_index
          FROM assistant_messages AS message
          CROSS JOIN json_each(message.content, '$.parts') AS part
          WHERE message.id = ${terminalMessage.id}
            AND message.session_id = ''
            AND json_extract(part.value, '$.type') = 'text'
            AND typeof(json_extract(part.value, '$.text')) = 'text'
            AND (
              message.role = 'assistant'
              OR (
                json_extract(part.value, '$.text') LIKE ${`${EXECUTION_OUTCOME_PREFIX}%`}
                AND instr(
                  json_extract(part.value, '$.text'),
                  ${EXECUTION_OUTCOME_MARKER}
                ) > 0
              )
            )
        )
        SELECT
          length(text) AS originalCharacters,
          substr(text, 1, ${remaining + 1}) AS text
        FROM terminal_parts
        ORDER BY part_index ASC
        LIMIT 1 OFFSET ${offset}
      `[0];

      if (row === undefined) {
        return text.length === 0
          ? undefined
          : {
              state: "available",
              text: text.join(""),
              truncated,
            };
      }

      if (text.length > 0 && remaining > 0) {
        text.push("\n");
        remaining -= 1;
      }

      if (row.text.length > remaining) {
        text.push(row.text.slice(0, remaining));
        truncated = true;
        remaining = 0;
      } else {
        text.push(row.text);
        remaining -= row.text.length;
        truncated ||= row.originalCharacters > row.text.length;
      }

      if (remaining === 0) {
        return { state: "available", text: text.join(""), truncated: true };
      }
    }

    const additionalPart = super.sql<{ present: number }>`
      SELECT 1 AS present
      FROM assistant_messages AS message, json_each(message.content, '$.parts') AS part
      WHERE message.session_id = ''
        AND message.id = ${terminalMessage.id}
        AND json_extract(part.value, '$.type') = 'text'
        AND typeof(json_extract(part.value, '$.text')) = 'text'
        AND (
          message.role = 'assistant'
          OR (
            json_extract(part.value, '$.text') LIKE ${`${EXECUTION_OUTCOME_PREFIX}%`}
            AND instr(
              json_extract(part.value, '$.text'),
              ${EXECUTION_OUTCOME_MARKER}
            ) > 0
          )
        )
      LIMIT 1 OFFSET ${MAXIMUM_RUN_OUTPUT_PARTS}
    `[0];

    return text.length === 0
      ? undefined
      : {
          state: "available",
          text: text.join(""),
          truncated: truncated || additionalPart !== undefined,
        };
  }

  #activeRuntimeConfig(): CrewAgentRuntimeConfig {
    const configuration = this.#activeTurnMetadata().configuration;

    if (!this.#objectMatches(configuration.ownerKey, configuration.agentId)) {
      throw new Error("CrewAgent runtime configuration does not match this object.");
    }

    return configuration;
  }

  #activeTurnMetadata(): AdmittedTurnMetadata {
    if (this.#approvalTurnMetadata !== undefined) {
      return this.#approvalTurnMetadata;
    }

    const metadata = admittedTurnMetadataSchema.safeParse(this.activeTurnMetadata);

    if (!metadata.success) {
      throw new Error("CrewAgent runtime configuration is missing or invalid.");
    }

    return metadata.data.crewhelmRun;
  }

  #configurationMatchesPermit(
    configuration: CrewAgentRuntimeConfig,
    permit: RunAdmissionPermit,
  ): boolean {
    return (
      configuration.ownerKey === permit.ownerKey &&
      configuration.agentId === permit.agentId &&
      configuration.revision === permit.agentRevision &&
      this.#reservationMatchesConfiguration(permit.budgetReservation, configuration)
    );
  }

  #objectMatches(ownerKey: string, agentId: string): boolean {
    return this.ctx.id.name === crewAgentObjectName({ agentId, ownerKey });
  }

  #recordMatchesPermit(record: AdmittedRunRecord, permit: RunAdmissionPermit): boolean {
    return (
      record.promptDigest === permit.promptDigest &&
      record.clientId === permit.clientId &&
      record.idempotencyKey === permit.idempotencyKey &&
      JSON.stringify(record.budgetReservation) === JSON.stringify(permit.budgetReservation) &&
      this.#reservationMatchesPrompt(
        record.budgetReservation,
        record.configuration,
        record.promptCharacters,
      ) &&
      this.#configurationMatchesPermit(record.configuration, permit)
    );
  }

  #recordMatchesCapability(
    record: AdmittedRunRecord,
    capability: RunReceiverCapability,
    promptCharacters: number,
  ): boolean {
    return (
      record.configuration.ownerKey === capability.ownerKey &&
      record.configuration.agentId === capability.agentId &&
      record.configuration.revision === capability.agentRevision &&
      (capability.action === "inspect" || record.clientId === capability.clientId) &&
      record.idempotencyKey === capability.idempotencyKey &&
      record.promptCharacters === promptCharacters &&
      record.promptDigest === capability.promptDigest &&
      JSON.stringify(record.budgetReservation) === JSON.stringify(capability.budgetReservation) &&
      this.#reservationMatchesPrompt(
        record.budgetReservation,
        record.configuration,
        promptCharacters,
      )
    );
  }

  #reservationMatchesConfiguration(
    reservation: RunBudgetReservation,
    configuration: CrewAgentRuntimeConfig,
  ): boolean {
    return (
      reservation.maxDurationSeconds <= configuration.executionLimits.maxDurationSeconds &&
      reservation.model === configuration.model &&
      reservation.maxOutputTokens <= configuration.executionLimits.maxModelTokens &&
      reservation.maxToolCalls <= configuration.executionLimits.maxToolCalls &&
      reservation.maxTurns <= configuration.executionLimits.maxTurns
    );
  }

  #reservationMatchesPrompt(
    reservation: RunBudgetReservation,
    configuration: CrewAgentRuntimeConfig,
    promptCharacters: number,
  ): boolean {
    return reservation.maxInputCharacters === configuration.instructions.length + promptCharacters;
  }
}

for (const method of BLOCKED_CREW_AGENT_AUTHORITY_METHODS) {
  if (!Object.hasOwn(CrewAgent.prototype, method)) {
    Object.defineProperty(CrewAgent.prototype, method, {
      configurable: false,
      value: function blockedCrewAgentAuthority(): never {
        throw runtimeAdmissionError();
      },
      writable: true,
    });
  }
}
