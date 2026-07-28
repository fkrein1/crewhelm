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

import type { CrewAgent } from "../../agent/durable-object.js";
import { auditEvents, toolApprovals, type ControlPlaneDatabaseSchema } from "../schema.js";
import { digestRunPrompt, type RunAdmissions } from "../runs/module.js";
import { RunReceiverCapabilities } from "./protocol.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type StartRunFailure = Extract<StartRunResult, { ok: false }>;
type InspectRunFailure = Extract<InspectRunResult, { ok: false }>;
type ListApprovalsFailure = Extract<ListRunToolApprovalsResult, { ok: false }>;
type DecideApprovalFailure = Extract<DecideRunToolApprovalResult, { ok: false }>;

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
    const agent = this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId,
        ownerKey: authority.ownerKey,
      }),
    );

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

    let inspected: unknown;

    try {
      const capability = this.#capabilities.issue(authority, storedAdmission, "inspect");

      if (capability === undefined) {
        return deniedStartRun("run_unavailable");
      }

      inspected = await agent.inspectAdmittedRun({ capability });
    } catch {
      return deniedStartRun("run_unavailable");
    }

    const result = inspectAdmittedRunResultSchema.safeParse(inspected);

    if (
      !result.success ||
      !result.data.ok ||
      result.data.run.runId !== runId ||
      result.data.run.agentId !== agentId ||
      result.data.run.agentRevision !== agentRevision
    ) {
      return deniedStartRun("run_unavailable");
    }

    return startRunResultSchema.parse({
      created: admission.state === "issued" && admission.created,
      ok: true,
      run: {
        ...result.data.run,
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

    const agent = this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId: admission.agentId,
        ownerKey: authority.ownerKey,
      }),
    );
    let inspected: unknown;

    try {
      const capability = this.#capabilities.issue(authority, admission, "inspect");

      if (capability === undefined) {
        return deniedInspectRun("run_unavailable");
      }

      inspected = await agent.inspectAdmittedRun({ capability });
    } catch {
      return deniedInspectRun("run_unavailable");
    }

    const result = inspectAdmittedRunResultSchema.safeParse(inspected);

    if (
      !result.success ||
      !result.data.ok ||
      result.data.run.runId !== admission.runId ||
      result.data.run.agentId !== admission.agentId ||
      result.data.run.agentRevision !== admission.agentRevision
    ) {
      return deniedInspectRun("run_unavailable");
    }

    return inspectRunResultSchema.parse({
      ok: true,
      run: {
        ...result.data.run,
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

    const capability = this.#capabilities.issue(authority, admission, "list_approvals");

    if (capability === undefined) {
      return deniedListRunToolApprovals("run_unavailable");
    }

    let result: unknown;

    try {
      result = await this.#crewAgents
        .getByName(
          crewAgentObjectName({
            agentId: admission.agentId,
            ownerKey: authority.ownerKey,
          }),
        )
        .listAdmittedRunToolApprovals({ capability });
    } catch {
      return deniedListRunToolApprovals("run_unavailable");
    }

    const listed = listAdmittedRunToolApprovalsResultSchema.safeParse(result);

    if (!listed.success || !listed.data.ok) {
      return deniedListRunToolApprovals("run_unavailable");
    }

    return listRunToolApprovalsResultSchema.parse({
      approvals: listed.data.approvals,
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

    const agent = this.#crewAgents.getByName(
      crewAgentObjectName({
        agentId: admission.agentId,
        ownerKey: authority.ownerKey,
      }),
    );
    const listCapability = this.#capabilities.issue(authority, admission, "list_approvals");

    if (listCapability === undefined) {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    let listed: unknown;

    try {
      listed = await agent.listAdmittedRunToolApprovals({ capability: listCapability });
    } catch {
      return deniedDecideRunToolApproval("run_unavailable");
    }

    const pending = listAdmittedRunToolApprovalsResultSchema.safeParse(listed);
    const approval =
      pending.success && pending.data.ok
        ? pending.data.approvals.find(
            (candidate) => candidate.executionId === request.data.executionId,
          )
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
