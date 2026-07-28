import {
  acceptRunAdmissionInputSchema,
  acceptRunAdmissionResultSchema,
  confirmRunAdmissionResultSchema,
  crewAgentObjectName,
  inspectAdmittedRunInputSchema,
  inspectAdmittedRunResultSchema,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  redeemRunReceiverCapabilityResultSchema,
  RUN_ADMISSION_RETENTION_MS,
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
  TOOL_APPROVAL_LIFETIME_MS,
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
import type * as z from "zod";

import { recordExecutionEvent } from "../../observability/execution.js";
import { digestRunPrompt } from "./protocol.js";
import {
  admittedRunRecordSchema,
  admittedTurnMetadataSchema,
  pendingToolApprovalRecordSchema,
  scheduledRunInputSchema,
  type AdmittedRunRecord,
  type AdmittedTurnMetadata,
} from "./schema.js";

const RUNTIME_ADMISSION_UNAVAILABLE = "CrewAgent runtime admission is not available.";
const RUN_RECORD_PREFIX = "crewhelm:run:";
const TOOL_APPROVAL_PREFIX = "crewhelm:tool-approval:";
const MAXIMUM_RUN_OUTPUT_PARTS = 256;
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
        await this.#scheduleRunLifecycle(runId, record.data);
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
        cleanupAt: acceptedAt + RUN_ADMISSION_RETENTION_MS,
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

    const submission = await super.inspectSubmission(capability.runId);

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
      });
    }

    const output =
      submission.status === "completed" ? this.#readRunOutput(capability.runId) : undefined;

    return inspectAdmittedRunResultSchema.parse({
      ok: true,
      run: {
        agentId: record.configuration.agentId,
        agentRevision: record.configuration.revision,
        completedAt: isoTimestamp(submission.completedAt),
        createdAt: new Date(submission.createdAt).toISOString(),
        ...(output === undefined
          ? {}
          : {
              output: output.text,
              outputTruncated: output.truncated,
            }),
        runId: capability.runId,
        startedAt: isoTimestamp(submission.startedAt),
        status: publicRunStatus(submission.status),
      },
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
    return super.getAIBinding();
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
          approval: adapter.grant.effect !== "read",
          approvalRisk: adapter.grant.effect === "destructive" ? "high" : "medium",
          approvalSummary: adapter.description,
          description: adapter.description,
          execute: (input, context) => this.#executeTool(adapter, input, context),
          inputSchema: adapter.inputSchema,
          kind: adapter.grant.effect === "read" ? "server" : "durable-pause",
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
    const adapter = this.#activeToolAdapters().find(
      (candidate) => candidate.name === context.action,
    );

    if (
      adapter === undefined ||
      context.requiredPermissions.length !== 1 ||
      context.requiredPermissions[0] !== adapter.grant.grantId
    ) {
      return false;
    }

    if (adapter.grant.effect === "read") {
      return true;
    }

    const action = await this.#classifyTool(adapter, context.toolCallId, context.input);
    const reference = await this.#activeRunReference();

    if (action === undefined || reference === undefined) {
      return false;
    }

    let result: unknown;

    try {
      result = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).evaluateToolExecution({ ...reference, action });
    } catch {
      return false;
    }

    const evaluation = evaluateToolExecutionResultSchema.safeParse(result);

    if (
      !evaluation.success ||
      !evaluation.data.ok ||
      evaluation.data.decision.decision === "deny"
    ) {
      return false;
    }

    if (evaluation.data.decision.decision === "requires_approval") {
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
          requestedAt: new Date(requestedAt).toISOString(),
          risk: evaluation.data.decision.effect === "destructive" ? "high" : "medium",
          runId: reference.runId,
          summary: adapter.description,
          toolCallId: action.toolCallId,
        }),
      );
    }

    return true;
  }

  override async beforeToolCall(context: ToolCallContext): Promise<ToolCallDecision> {
    const adapter = this.#activeToolAdapters().find(
      (candidate) => candidate.name === context.toolName,
    );
    const action =
      adapter === undefined
        ? undefined
        : await this.#classifyTool(adapter, context.toolCallId, context.input);
    const reference = await this.#activeRunReference();

    if (adapter === undefined || action === undefined || reference === undefined) {
      return { action: "block", reason: "Tool execution denied." };
    }

    let evaluationResult: unknown;

    try {
      evaluationResult = await this.env.OWNER_CONTROL_PLANE.getByName(
        reference.ownerKey,
      ).evaluateToolExecution({ ...reference, action });
    } catch {
      return { action: "block", reason: "Tool execution denied." };
    }

    const evaluation = evaluateToolExecutionResultSchema.safeParse(evaluationResult);
    const expectedDecision = adapter.grant.effect === "read" ? "allow" : "requires_approval";

    if (
      !evaluation.success ||
      !evaluation.data.ok ||
      evaluation.data.decision.decision !== expectedDecision
    ) {
      return { action: "block", reason: "Tool execution denied." };
    }

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

    const runtime = createComposioRuntime({ apiKey: this.env.COMPOSIO_API_KEY });
    let inputSchema: z.ZodType<Record<string, unknown>>;

    try {
      inputSchema = runtime.createInputSchema(grant.tool.inputParametersJson);
    } catch {
      return undefined;
    }

    const suffix = grant.grantId.slice(-8);
    const normalizedSlug = grant.toolSlug.toLowerCase().replaceAll(/[^a-z0-9_]/g, "_");
    const name = `composio_${normalizedSlug.slice(0, 46)}_${suffix}`;

    return {
      description: grant.tool.description ?? grant.tool.name,
      grant,
      inputSchema,
      name,
      classify: async (input, context) => {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(JSON.stringify(input)),
        );
        const inputDigest = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");

        return {
          agentId: grant.agentId,
          agentRevision: grant.agentRevision,
          capabilityId: grant.capabilityId,
          connectionId: grant.connectionId,
          effect: grant.effect,
          estimatedCostMicrousd: grant.limits.maxCostMicrousdPerCall,
          grantId: grant.grantId,
          inputDigest,
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

  async #readRunRecord(runId: string): Promise<AdmittedRunRecord | undefined> {
    const stored = await this.ctx.storage.get(runRecordKey(runId));

    if (stored === undefined) {
      return undefined;
    }

    return admittedRunRecordSchema.parse(stored);
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

  #readRunOutput(runId: string): { text: string; truncated: boolean } | undefined {
    const text: string[] = [];
    let remaining = MAXIMUM_RUN_OUTPUT_CHARACTERS;
    let truncated = false;

    for (let offset = 0; offset < MAXIMUM_RUN_OUTPUT_PARTS; offset += 1) {
      const row = super.sql<{ originalCharacters: number; text: string }>`
        WITH RECURSIVE run_messages(id) AS (
          SELECT id
          FROM assistant_messages
          WHERE session_id = ''
            AND id = ${runUserMessageId(runId)}
          UNION ALL
          SELECT child.id
          FROM assistant_messages AS child
          INNER JOIN run_messages AS parent ON child.parent_id = parent.id
          WHERE child.session_id = ''
        )
        SELECT
          length(json_extract(part.value, '$.text')) AS originalCharacters,
          substr(json_extract(part.value, '$.text'), 1, ${remaining + 1}) AS text
        FROM assistant_messages AS message, json_each(message.content, '$.parts') AS part
        WHERE message.session_id = ''
          AND message.id IN (SELECT id FROM run_messages)
          AND message.role = 'assistant'
          AND json_extract(part.value, '$.type') = 'text'
          AND typeof(json_extract(part.value, '$.text')) = 'text'
        ORDER BY message.created_at ASC, CAST(part.key AS INTEGER) ASC
        LIMIT 1 OFFSET ${offset}
      `[0];

      if (row === undefined) {
        return text.length === 0
          ? undefined
          : {
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
        return { text: text.join(""), truncated: true };
      }
    }

    const additionalPart = super.sql<{ present: number }>`
      WITH RECURSIVE run_messages(id) AS (
        SELECT id
        FROM assistant_messages
        WHERE session_id = ''
          AND id = ${runUserMessageId(runId)}
        UNION ALL
        SELECT child.id
        FROM assistant_messages AS child
        INNER JOIN run_messages AS parent ON child.parent_id = parent.id
        WHERE child.session_id = ''
      )
      SELECT 1 AS present
      FROM assistant_messages AS message, json_each(message.content, '$.parts') AS part
      WHERE message.session_id = ''
        AND message.id IN (SELECT id FROM run_messages)
        AND message.role = 'assistant'
        AND json_extract(part.value, '$.type') = 'text'
        AND typeof(json_extract(part.value, '$.text')) = 'text'
      LIMIT 1 OFFSET ${MAXIMUM_RUN_OUTPUT_PARTS}
    `[0];

    return text.length === 0
      ? undefined
      : {
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
