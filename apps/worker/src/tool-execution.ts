import {
  TOOL_EXECUTION_PERMIT_LIFETIME_MS,
  completeToolExecutionInputSchema,
  completeToolExecutionResultSchema,
  composioToolCapabilityGrantSchema,
  evaluateToolExecutionInputSchema,
  evaluateToolExecutionResultSchema,
  reserveToolExecutionInputSchema,
  reserveToolExecutionResultSchema,
  runAdmissionNonceSchema,
  toolExecutionPermitSchema,
  type CompleteToolExecutionResult,
  type EvaluateToolExecutionResult,
  type ReserveToolExecutionResult,
} from "@crewhelm/contracts";
import { evaluateApprovedComposioToolAction, evaluateComposioToolAction } from "@crewhelm/core";
import { and, count, eq, gt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agents,
  auditEvents,
  capabilityGrants,
  connections,
  runAdmissions,
  toolApprovals,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "./control-plane-schema.js";

const INVALID_TOOL_EXECUTION = {
  error: {
    code: "invalid_execution",
    message: "Tool execution denied.",
  },
  ok: false,
} as const;

type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ControlPlaneTransaction = Parameters<Parameters<ControlPlaneDatabase["transaction"]>[0]>[0];
type ToolExecutionDatabase = ControlPlaneDatabase | ControlPlaneTransaction;
type ToolExecutionRequest = ReturnType<typeof evaluateToolExecutionInputSchema.parse>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestBase64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

function createNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
}

export class ToolExecutions {
  readonly #database: ControlPlaneDatabase;
  readonly #objectName: string | undefined;

  constructor(objectName: string | undefined, database: ControlPlaneDatabase) {
    this.#database = database;
    this.#objectName = objectName;
  }

  async evaluate(input: unknown): Promise<EvaluateToolExecutionResult> {
    const request = evaluateToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_TOOL_EXECUTION;
    }

    const gateInput = this.#gateInput(this.#database, request.data, Date.now());

    if (gateInput === undefined) {
      return INVALID_TOOL_EXECUTION;
    }

    return evaluateToolExecutionResultSchema.parse({
      decision: await evaluateComposioToolAction(gateInput),
      ok: true,
    });
  }

  async reserve(input: unknown): Promise<ReserveToolExecutionResult> {
    const request = reserveToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_TOOL_EXECUTION;
    }

    const evaluatedAt = Date.now();
    const existingExecution = this.#database
      .select()
      .from(toolExecutions)
      .where(eq(toolExecutions.toolCallId, request.data.action.toolCallId))
      .get();

    if (existingExecution !== undefined) {
      return INVALID_TOOL_EXECUTION;
    }

    const gateInput = this.#gateInput(this.#database, request.data, evaluatedAt);

    if (gateInput === undefined) {
      return INVALID_TOOL_EXECUTION;
    }

    const approval = this.#database
      .select({
        actionDigest: toolApprovals.actionDigest,
        decision: toolApprovals.decision,
        expiresAt: toolApprovals.expiresAt,
      })
      .from(toolApprovals)
      .where(eq(toolApprovals.toolCallId, request.data.action.toolCallId))
      .get();
    const approvedDigest =
      approval?.decision === "approved" && approval.expiresAt > evaluatedAt
        ? approval.actionDigest
        : undefined;
    const decision =
      approvedDigest === undefined
        ? await evaluateComposioToolAction(gateInput)
        : await evaluateApprovedComposioToolAction(gateInput, approvedDigest);

    if (decision.decision === "deny") {
      return INVALID_TOOL_EXECUTION;
    }

    if (decision.decision === "requires_approval") {
      return reserveToolExecutionResultSchema.parse({
        actionDigest: decision.actionDigest,
        effect: decision.effect,
        ok: true,
        state: "requires_approval",
      });
    }

    const nonce = createNonce();
    const nonceDigest = await digestBase64Url(nonce);
    const result = this.#database.transaction((transaction) => {
      const currentGateInput = this.#gateInput(transaction, request.data, evaluatedAt);

      if (
        currentGateInput === undefined ||
        JSON.stringify(currentGateInput) !== JSON.stringify(gateInput)
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      const executionDeadline =
        evaluatedAt + Math.min(decision.constraints.maxDurationMs, 5 * 60 * 1_000);

      if (
        transaction
          .select({ toolCallId: toolExecutions.toolCallId })
          .from(toolExecutions)
          .where(eq(toolExecutions.toolCallId, request.data.action.toolCallId))
          .get() !== undefined
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      const expectedConsumed =
        request.data.budgetReservation.maxToolCalls - gateInput.policy.remainingToolCalls;
      const claimed = transaction
        .update(runAdmissions)
        .set({
          toolCallsConsumed: expectedConsumed + 1,
        })
        .where(
          and(
            eq(runAdmissions.runId, request.data.runId),
            eq(runAdmissions.toolCallsConsumed, expectedConsumed),
          ),
        )
        .returning({ runId: runAdmissions.runId })
        .all();

      if (claimed.length !== 1) {
        return INVALID_TOOL_EXECUTION;
      }

      transaction
        .insert(toolExecutions)
        .values({
          actionDigest: decision.actionDigest,
          costMicrousd: request.data.action.estimatedCostMicrousd ?? 0,
          expiresAt: executionDeadline,
          grantId: request.data.action.grantId,
          nonceDigest,
          runId: request.data.runId,
          startedAt: evaluatedAt,
          status: "reserved",
          toolCallId: request.data.action.toolCallId,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "tool.execution_reserved",
          clientId: request.data.clientId,
          occurredAt: evaluatedAt,
          subjectId: request.data.action.toolCallId,
        })
        .run();

      return reserveToolExecutionResultSchema.parse({
        ok: true,
        permit: toolExecutionPermitSchema.parse({
          action: request.data.action,
          actionDigest: decision.actionDigest,
          audience: "composio_adapter",
          constraints: {
            ...decision.constraints,
            decisionExpiresAt: new Date(
              Math.min(
                Date.parse(decision.constraints.decisionExpiresAt),
                evaluatedAt + TOOL_EXECUTION_PERMIT_LIFETIME_MS,
              ),
            ).toISOString(),
          },
          nonce,
        }),
        state: "allowed",
      });
    });

    return result;
  }

  async complete(input: unknown): Promise<CompleteToolExecutionResult> {
    const request = completeToolExecutionInputSchema.safeParse(input);

    if (!request.success) {
      return INVALID_TOOL_EXECUTION;
    }

    const nonceDigest = await digestBase64Url(request.data.permit.nonce);
    const currentTime = Date.now();

    return this.#database.transaction((transaction) => {
      const row = transaction
        .select()
        .from(toolExecutions)
        .where(eq(toolExecutions.toolCallId, request.data.permit.action.toolCallId))
        .get();

      if (
        row === undefined ||
        row.nonceDigest !== nonceDigest ||
        row.runId !== request.data.permit.action.runId ||
        row.grantId !== request.data.permit.action.grantId ||
        row.actionDigest !== request.data.permit.actionDigest
      ) {
        return INVALID_TOOL_EXECUTION;
      }

      if (row.status !== "reserved") {
        return completeToolExecutionResultSchema.parse({
          completed: false,
          ok: true,
        });
      }

      const status =
        currentTime > row.expiresAt ||
        request.data.outcome.outputBytes > request.data.permit.constraints.maxOutputBytes
          ? "unknown"
          : request.data.outcome.status;

      transaction
        .update(toolExecutions)
        .set({
          completedAt: currentTime,
          outputBytes: Math.min(
            request.data.outcome.outputBytes,
            request.data.permit.constraints.maxOutputBytes,
          ),
          status,
        })
        .where(
          and(eq(toolExecutions.toolCallId, row.toolCallId), eq(toolExecutions.status, "reserved")),
        )
        .run();
      const admission = transaction
        .select({ clientId: runAdmissions.clientId })
        .from(runAdmissions)
        .where(eq(runAdmissions.runId, row.runId))
        .get();

      if (admission === undefined) {
        return INVALID_TOOL_EXECUTION;
      }

      transaction
        .insert(auditEvents)
        .values({
          action: `tool.execution_${status}`,
          clientId: admission.clientId,
          occurredAt: currentTime,
          subjectId: row.toolCallId,
        })
        .run();

      return completeToolExecutionResultSchema.parse({
        completed: true,
        ok: true,
      });
    });
  }

  #gateInput(database: ToolExecutionDatabase, request: ToolExecutionRequest, evaluatedAt: number) {
    if (request.ownerKey !== this.#objectName) {
      return undefined;
    }

    const admission = database
      .select()
      .from(runAdmissions)
      .where(eq(runAdmissions.runId, request.runId))
      .get();

    if (
      admission === undefined ||
      admission.status !== "redeemed" ||
      admission.cleanupAt <= evaluatedAt ||
      admission.agentId !== request.agentId ||
      admission.agentRevision !== request.agentRevision ||
      admission.clientId !== request.clientId ||
      admission.idempotencyKey !== request.idempotencyKey ||
      admission.promptDigest !== request.promptDigest ||
      JSON.stringify(admission.budgetReservation) !== JSON.stringify(request.budgetReservation) ||
      request.action.ownerKey !== request.ownerKey ||
      request.action.agentId !== request.agentId ||
      request.action.agentRevision !== request.agentRevision ||
      request.action.runId !== request.runId
    ) {
      return undefined;
    }

    const grantRow = database
      .select({
        agentId: capabilityGrants.agentId,
        agentRevision: capabilityGrants.agentRevision,
        connectionId: capabilityGrants.connectionId,
        connectionStatus: connections.status,
        grant: capabilityGrants.grant,
        grantStatus: capabilityGrants.status,
      })
      .from(capabilityGrants)
      .innerJoin(connections, eq(connections.connectionId, capabilityGrants.connectionId))
      .where(eq(capabilityGrants.grantId, request.action.grantId))
      .get();
    const grant = composioToolCapabilityGrantSchema.safeParse(grantRow?.grant);
    const reservedGrant = request.budgetReservation.toolGrants.find(
      (candidate) => candidate.grantId === request.action.grantId,
    );

    if (
      grantRow === undefined ||
      !grant.success ||
      reservedGrant === undefined ||
      grantRow.agentId !== request.agentId ||
      grantRow.agentRevision !== request.agentRevision ||
      grantRow.connectionId !== grant.data.connectionId ||
      JSON.stringify(grant.data) !== JSON.stringify(reservedGrant)
    ) {
      return undefined;
    }

    const currentAgent = database
      .select({ currentRevision: agents.currentRevision })
      .from(agents)
      .where(eq(agents.agentId, request.agentId))
      .get();
    const grantCallsUsed =
      database
        .select({ value: count() })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.runId, request.runId),
            eq(toolExecutions.grantId, request.action.grantId),
          ),
        )
        .get()?.value ?? 0;
    const activeGrantCalls =
      database
        .select({ value: count() })
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.grantId, request.action.grantId),
            eq(toolExecutions.status, "reserved"),
            gt(toolExecutions.expiresAt, evaluatedAt),
          ),
        )
        .get()?.value ?? 0;
    const deadlineAt = admission.createdAt + request.budgetReservation.maxDurationSeconds * 1_000;

    return {
      action: request.action,
      grant: grant.data,
      policy: {
        activeGrantCalls,
        agentId: request.agentId,
        agentStatus:
          currentAgent?.currentRevision === request.agentRevision
            ? ("active" as const)
            : ("revoked" as const),
        capabilityId: request.action.capabilityId,
        connectionId: request.action.connectionId,
        connectionStatus:
          grantRow?.connectionStatus === "active"
            ? ("active" as const)
            : grantRow?.connectionStatus === "revoked"
              ? ("revoked" as const)
              : ("unavailable" as const),
        currentAgentRevision: currentAgent?.currentRevision ?? request.agentRevision,
        evaluatedAt: new Date(evaluatedAt).toISOString(),
        grantCallsUsed,
        grantId: request.action.grantId,
        grantStatus: grantRow?.grantStatus ?? "revoked",
        killSwitchActive: false,
        ownerKey: request.ownerKey,
        remainingCostMicrousd: grant.data.limits.maxCostMicrousdPerCall,
        remainingDurationMs: Math.max(0, deadlineAt - evaluatedAt),
        remainingOutputBytes: grant.data.limits.maxOutputBytes,
        remainingToolCalls: Math.max(
          0,
          request.budgetReservation.maxToolCalls - admission.toolCallsConsumed,
        ),
        runId: request.runId,
      },
    };
  }
}
