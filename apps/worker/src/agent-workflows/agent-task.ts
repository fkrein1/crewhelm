import {
  agentTaskWorkflowParamsSchema,
  agentWorkflowRunEventSchema,
  completeAgentWorkflowStageResultSchema,
  dispatchAgentWorkflowStageResultSchema,
  type AgentTaskWorkflowParams,
  type DispatchAgentWorkflowStageResult,
} from "@crewhelm/contracts";
import { NonRetryableError } from "cloudflare:workflows";
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";

import type { CrewAgent } from "../agent/session-directory.js";

export const AGENT_TASK_WORKFLOW_BINDING = "AGENT_TASK_WORKFLOW" as const;
export const AGENT_TASK_WORKFLOW_AGENT_BINDING = "CREW_AGENT" as const;
export function agentWorkflowStageEventType(stageIndex: number): string {
  return `crewhelm.agent-workflow.stage-terminal.${stageIndex}`;
}

type StageFailureCode = Extract<DispatchAgentWorkflowStageResult, { ok: false }>["error"]["code"];

function unsupportedStageFailure(code: never): never {
  throw new NonRetryableError(
    `Crewhelm workflow returned an unsupported failure (${String(code)}).`,
  );
}

function stageFailureDisposition(code: StageFailureCode): "fail" | "retry" {
  switch (code) {
    case "workflow_busy":
    case "workflow_unavailable":
      return "retry";
    case "admission_limit_exceeded":
    case "agent_not_found":
    case "agent_unavailable":
    case "brief_context_too_large":
    case "brief_unavailable":
    case "budget_exhausted":
    case "capability_unavailable":
    case "idempotency_conflict":
    case "incompatible_schema":
    case "insufficient_scope":
    case "invalid_authority":
    case "invalid_request":
    case "model_unavailable":
    case "owner_mismatch":
    case "revision_conflict":
    case "workflow_deleted":
    case "workflow_not_found":
      return "fail";
  }

  return unsupportedStageFailure(code);
}

export class AgentTaskWorkflow extends AgentWorkflow<CrewAgent, AgentTaskWorkflowParams> {
  override async run(
    event: AgentWorkflowEvent<AgentTaskWorkflowParams>,
    step: AgentWorkflowStep,
  ): Promise<{ status: "cancelled" | "completed" | "failed"; workflowId: string }> {
    const parsedParams = agentTaskWorkflowParamsSchema.safeParse(event.payload);

    if (!parsedParams.success) {
      throw new NonRetryableError("Crewhelm workflow parameters are invalid.");
    }

    const params = parsedParams.data;
    const controlPlane = this.env.OWNER_CONTROL_PLANE.getByName(params.ownerKey);

    for (let stageIndex = 0; stageIndex < params.stageCount; stageIndex += 1) {
      const dispatched = dispatchAgentWorkflowStageResultSchema.parse(
        await step.do(
          `dispatch-stage-${stageIndex}`,
          { retries: { delay: "1 second", limit: 5 }, timeout: "30 seconds" },
          async () => {
            const result = dispatchAgentWorkflowStageResultSchema.parse(
              await controlPlane.dispatchAgentWorkflowStage({
                agentId: params.agentId,
                stageIndex,
                workflowId: params.workflowId,
              }),
            );

            if (!result.ok && stageFailureDisposition(result.error.code) === "retry") {
              throw new Error(
                `Crewhelm workflow stage ${stageIndex + 1} admission is unavailable.`,
              );
            }
            return result;
          },
        ),
      );

      if (!dispatched.ok) {
        throw new NonRetryableError(
          `Crewhelm workflow stage ${stageIndex + 1} was not admitted (${dispatched.error.code}).`,
        );
      }

      const parsedTerminal = agentWorkflowRunEventSchema.safeParse(
        (
          await step.waitForEvent(`wait-stage-${stageIndex}`, {
            timeout: "2 hours",
            type: agentWorkflowStageEventType(stageIndex),
          })
        ).payload,
      );

      if (!parsedTerminal.success) {
        throw new NonRetryableError("Crewhelm workflow received an invalid stage event.");
      }

      const terminal = parsedTerminal.data;

      if (
        terminal.workflowId !== params.workflowId ||
        terminal.stageIndex !== stageIndex ||
        terminal.runId !== dispatched.runId
      ) {
        throw new NonRetryableError("Crewhelm workflow received a mismatched stage event.");
      }

      const completed = completeAgentWorkflowStageResultSchema.parse(
        await step.do(
          `complete-stage-${stageIndex}`,
          { retries: { delay: "1 second", limit: 5 }, timeout: "30 seconds" },
          async () => {
            const result = completeAgentWorkflowStageResultSchema.parse(
              await controlPlane.completeAgentWorkflowStage({
                agentId: params.agentId,
                runId: terminal.runId,
                stageIndex,
                workflowId: params.workflowId,
              }),
            );

            if (!result.ok && stageFailureDisposition(result.error.code) === "retry") {
              throw new Error(
                `Crewhelm workflow stage ${stageIndex + 1} completion is unavailable.`,
              );
            }
            return result;
          },
        ),
      );

      if (!completed.ok) {
        throw new NonRetryableError(
          `Crewhelm workflow stage ${stageIndex + 1} could not be finalized (${completed.error.code}).`,
        );
      }

      switch (completed.workflowStatus) {
        case "cancelled": {
          const result = { status: "cancelled" as const, workflowId: params.workflowId };
          await step.reportComplete(result);
          return result;
        }
        case "completed":
          if (stageIndex !== params.stageCount - 1) {
            throw new NonRetryableError("Crewhelm workflow completed before its final stage.");
          }
          break;
        case "failed":
          await step.reportError(`Crewhelm workflow stage ${stageIndex + 1} failed.`);
          throw new NonRetryableError(`Crewhelm workflow stage ${stageIndex + 1} failed.`);
        case "running":
          if (stageIndex === params.stageCount - 1) {
            throw new NonRetryableError("Crewhelm workflow final stage did not complete.");
          }
          break;
        case "cancelling":
        case "queued":
        case "waiting":
          throw new NonRetryableError(
            `Crewhelm workflow stage ${stageIndex + 1} returned an invalid workflow state (${completed.workflowStatus}).`,
          );
      }
    }

    const result = { status: "completed" as const, workflowId: params.workflowId };
    await step.reportComplete(result);
    return result;
  }
}
