import {
  acceptRunAdmissionResultSchema,
  crewAgentObjectName,
  decideRunToolApprovalInputSchema,
  decideRunToolApprovalResultSchema,
  inspectAdmittedRunResultSchema,
  inspectRunInputSchema,
  inspectRunResultSchema,
  listAdmittedRunToolApprovalsResultSchema,
  listRunToolApprovalsInputSchema,
  listRunToolApprovalsResultSchema,
  startRunInputSchema,
  startRunResultSchema,
  type DecideRunToolApprovalResult,
  type InspectRunResult,
  type ListRunToolApprovalsResult,
  type OwnerAuthority,
  type RedeemRunReceiverCapabilityResult,
  type StartRunResult,
} from "@crewhelm/contracts";
import { eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { digestRunPrompt } from "../../agent/admitted-runs/protocol.js";
import type { CrewAgent } from "../../agent/durable-object.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import { auditEvents, toolApprovals, type ControlPlaneDatabaseSchema } from "../schema.js";
import type { RunAdmissions } from "../runs/module.js";
import { RunReceiverCapabilities } from "./protocol.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type StartRunFailure = Extract<StartRunResult, { ok: false }>;
type InspectRunFailure = Extract<InspectRunResult, { ok: false }>;
type ListApprovalsFailure = Extract<ListRunToolApprovalsResult, { ok: false }>;
type DecideApprovalFailure = Extract<DecideRunToolApprovalResult, { ok: false }>;
type StoredRunAdmission = NonNullable<ReturnType<RunAdmissions["read"]>>;
type CrewAgentStub = ReturnType<DurableObjectNamespace<CrewAgent>["getByName"]>;

export function deniedStartRun(code: StartRunFailure["error"]["code"]): StartRunFailure {
  return {
    error: { code, message: "Run request denied." },
    ok: false,
  };
}

export function deniedInspectRun(code: InspectRunFailure["error"]["code"]): InspectRunFailure {
  return {
    error: { code, message: "Run request denied." },
    ok: false,
  };
}

export function deniedListRunToolApprovals(
  code: ListApprovalsFailure["error"]["code"],
): ListApprovalsFailure {
  return {
    error: { code, message: "Tool approval request denied." },
    ok: false,
  };
}

export function deniedDecideRunToolApproval(
  code: DecideApprovalFailure["error"]["code"],
): DecideApprovalFailure {
  return {
    error: { code, message: "Tool approval request denied." },
    ok: false,
  };
}

export class AgentChannel {
  readonly #admissions: RunAdmissions;
  readonly #capabilities: RunReceiverCapabilities;
  readonly #crewAgents: DurableObjectNamespace<CrewAgent>;
  readonly #database: Database;

  constructor(
    objectName: string | undefined,
    database: Database,
    crewAgents: DurableObjectNamespace<CrewAgent>,
    admissions: RunAdmissions,
  ) {
    this.#admissions = admissions;
    this.#capabilities = new RunReceiverCapabilities(objectName, admissions);
    this.#crewAgents = crewAgents;
    this.#database = database;
  }

  redeem(input: unknown): RedeemRunReceiverCapabilityResult {
    return this.#capabilities.redeem(input);
  }

  #agent(authority: OwnerAuthority, admission: StoredRunAdmission) {
    return this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId: admission.agentId,
        ownerKey: authority.ownerKey,
      }),
    );
  }

  async #inspectAdmittedRun(
    authority: OwnerAuthority,
    admission: StoredRunAdmission,
    agent: CrewAgentStub,
  ) {
    try {
      const capability = this.#capabilities.issue(authority, admission, "inspect");

      if (capability === undefined) {
        return undefined;
      }

      const result = inspectAdmittedRunResultSchema.safeParse(
        await agent.inspectAdmittedRun({ capability }),
      );

      return result.success &&
        result.data.ok &&
        result.data.run.runId === admission.runId &&
        result.data.run.agentId === admission.agentId &&
        result.data.run.agentRevision === admission.agentRevision
        ? result.data
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #pendingApprovals(
    authority: OwnerAuthority,
    admission: StoredRunAdmission,
    agent?: CrewAgentStub,
  ) {
    const capability = this.#capabilities.issue(authority, admission, "list_approvals");

    if (capability === undefined) {
      return { state: "unavailable" } as const;
    }

    try {
      const result = listAdmittedRunToolApprovalsResultSchema.safeParse(
        await (agent ?? this.#agent(authority, admission)).listAdmittedRunToolApprovals({
          capability,
        }),
      );

      return result.success && result.data.ok
        ? { approvals: result.data.approvals, state: "available" as const }
        : { state: "invalid" as const };
    } catch {
      return { state: "unavailable" } as const;
    }
  }

  async start(authority: OwnerAuthority, input: unknown): Promise<StartRunResult> {
    const request = startRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedStartRun("invalid_request");
    }

    const admission = await this.#admissions.create(authority, {
      agentId: request.data.agentId,
      expectedRevision: request.data.expectedRevision,
      idempotencyKey: request.data.idempotencyKey,
      promptCharacters: request.data.prompt.length,
      promptDigest: await digestRunPrompt(request.data.prompt),
    });

    if (!admission.ok) {
      return deniedStartRun(admission.error.code);
    }

    const runId = admission.state === "issued" ? admission.permit.runId : admission.admission.runId;
    const storedAdmission = this.#admissions.read(runId);

    if (storedAdmission === undefined) {
      return deniedStartRun("run_unavailable");
    }

    const { agentId, agentRevision } = storedAdmission;
    const agent = this.#agent(authority, storedAdmission);

    if (admission.state === "expired") {
      return startRunResultSchema.parse({
        created: false,
        ok: true,
        run: {
          agentId,
          agentRevision,
          createdAt: new Date(storedAdmission.createdAt).toISOString(),
          runId,
          status: "failed",
        },
      });
    }

    let accepted: unknown;

    try {
      if (admission.state === "issued") {
        accepted = await agent.acceptRunAdmission({
          permit: admission.permit,
          prompt: request.data.prompt,
        });
      } else {
        const capability = this.#capabilities.issue(authority, storedAdmission, "resume");

        if (capability === undefined) {
          return deniedStartRun("run_unavailable");
        }

        accepted = await agent.resumeRunAdmission({
          capability,
          prompt: request.data.prompt,
        });
      }
    } catch {
      return deniedStartRun("run_unavailable");
    }

    const acceptance = acceptRunAdmissionResultSchema.safeParse(accepted);

    if (
      !acceptance.success ||
      !acceptance.data.ok ||
      acceptance.data.runId !== runId ||
      acceptance.data.agentId !== agentId ||
      acceptance.data.agentRevision !== agentRevision
    ) {
      return deniedStartRun("run_unavailable");
    }

    const inspected = await this.#inspectAdmittedRun(authority, storedAdmission, agent);

    if (inspected === undefined) {
      return deniedStartRun("run_unavailable");
    }

    return startRunResultSchema.parse({
      created: admission.state === "issued" && admission.created,
      ok: true,
      run: {
        ...inspected.run,
        createdAt: new Date(storedAdmission.createdAt).toISOString(),
      },
    });
  }

  async inspect(authority: OwnerAuthority, input: unknown): Promise<InspectRunResult> {
    const request = inspectRunInputSchema.safeParse(input);

    if (!request.success) {
      return deniedInspectRun("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedInspectRun("run_not_found");
    }

    if (admission.status !== "redeemed") {
      return inspectRunResultSchema.parse({
        ok: true,
        run: {
          agentId: admission.agentId,
          agentRevision: admission.agentRevision,
          createdAt: new Date(admission.createdAt).toISOString(),
          runId: admission.runId,
          status: admission.status === "expired" ? "failed" : "queued",
        },
      });
    }

    const agent = this.#agent(authority, admission);
    const inspected = await this.#inspectAdmittedRun(authority, admission, agent);

    if (inspected === undefined) {
      return deniedInspectRun("run_unavailable");
    }

    return inspectRunResultSchema.parse({
      ok: true,
      run: {
        ...inspected.run,
        createdAt: new Date(admission.createdAt).toISOString(),
      },
    });
  }

  async listApprovals(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ListRunToolApprovalsResult> {
    const request = listRunToolApprovalsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedListRunToolApprovals("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedListRunToolApprovals("run_not_found");
    }

    if (admission.status !== "redeemed") {
      return listRunToolApprovalsResultSchema.parse({ approvals: [], ok: true });
    }

    const listed = await this.#pendingApprovals(authority, admission);

    if (listed.state !== "available") {
      return deniedListRunToolApprovals("run_unavailable");
    }

    return listRunToolApprovalsResultSchema.parse({
      approvals: listed.approvals,
      ok: true,
    });
  }

  async decideApproval(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<DecideRunToolApprovalResult> {
    const request = decideRunToolApprovalInputSchema.safeParse(input);

    if (!request.success) {
      return deniedDecideRunToolApproval("invalid_request");
    }

    const admission = this.#admissions.read(request.data.runId);

    if (admission === undefined) {
      return deniedDecideRunToolApproval("run_not_found");
    }

    if (admission.status !== "redeemed") {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const agent = this.#agent(authority, admission);
    const pending = await this.#pendingApprovals(authority, admission, agent);

    if (pending.state === "unavailable") {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const approval =
      pending.state === "available"
        ? pending.approvals.find((candidate) => candidate.executionId === request.data.executionId)
        : undefined;

    if (approval === undefined || Date.parse(approval.expiresAt) <= Date.now()) {
      return deniedDecideRunToolApproval("approval_not_found");
    }

    const currentTime = Date.now();
    const storedDecision = request.data.decision === "approve" ? "approved" : "rejected";
    const existing = this.#database
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.executionId, approval.executionId))
      .get();

    if (
      existing !== undefined &&
      (existing.runId !== request.data.runId ||
        existing.toolCallId !== approval.toolCallId ||
        existing.actionDigest !== approval.actionDigest ||
        existing.decision !== storedDecision)
    ) {
      return deniedDecideRunToolApproval("approval_not_found");
    }

    let decisionRecorded = false;

    if (existing === undefined) {
      this.#database
        .insert(toolApprovals)
        .values({
          actionDigest: approval.actionDigest,
          clientId: authority.clientId,
          decidedAt: currentTime,
          decision: storedDecision,
          executionId: approval.executionId,
          expiresAt: Date.parse(approval.expiresAt),
          requestedAt: Date.parse(approval.requestedAt),
          runId: request.data.runId,
          toolCallId: approval.toolCallId,
        })
        .run();
      this.#database
        .insert(auditEvents)
        .values({
          action: `tool.approval_${storedDecision}`,
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: approval.toolCallId,
        })
        .run();
      decisionRecorded = true;
    }

    if (decisionRecorded) {
      recordExecutionEvent({
        outcome: storedDecision,
        phase: "tool.approval",
        runId: request.data.runId,
        toolCallId: approval.toolCallId,
      });
    }

    const decisionCapability = this.#capabilities.issue(
      authority,
      admission,
      request.data.decision === "approve" ? "approve_tool" : "reject_tool",
      approval.executionId,
    );

    if (decisionCapability === undefined) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    let decided: unknown;

    try {
      decided = await agent.decideAdmittedRunToolApproval({
        capability: decisionCapability,
      });
    } catch {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const result = decideRunToolApprovalResultSchema.safeParse({
      ...(typeof decided === "object" && decided !== null ? decided : {}),
      decision: request.data.decision,
    });

    if (!result.success || !result.data.ok) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    return result.data;
  }
}
