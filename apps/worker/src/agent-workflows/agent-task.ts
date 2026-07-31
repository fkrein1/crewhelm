import {
  agentTaskWorkflowParamsSchema,
  agentWorkflowRunEventSchema,
  completeAgentWorkflowStageResultSchema,
  dispatchAgentWorkflowStageResultSchema,
  type AgentTaskWorkflowParams,
} from "@crewhelm/contracts";
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";

import type { CrewAgent } from "../agent/session-directory.js";

export const AGENT_TASK_WORKFLOW_BINDING = "AGENT_TASK_WORKFLOW" as const;
export const AGENT_TASK_WORKFLOW_AGENT_BINDING = "CREW_AGENT" as const;
export function agentWorkflowStageEventType(stageIndex: number): string {
  return `crewhelm.agent-workflow.stage-terminal.${stageIndex}`;
}

export class AgentTaskWorkflow extends AgentWorkflow<CrewAgent, AgentTaskWorkflowParams> {
  override async run(
    event: AgentWorkflowEvent<AgentTaskWorkflowParams>,
    step: AgentWorkflowStep,
  ): Promise<{ status: "cancelled" | "completed" | "failed"; workflowId: string }> {
    const params = agentTaskWorkflowParamsSchema.parse(event.payload);
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

            if (
              !result.ok &&
              ["workflow_busy", "workflow_unavailable"].includes(result.error.code)
            ) {
              throw new Error(
                `Crewhelm workflow stage ${stageIndex + 1} admission is unavailable.`,
              );
            }
            return result;
          },
        ),
      );

      if (!dispatched.ok) {
        throw new Error(`Crewhelm workflow stage ${stageIndex + 1} was not admitted.`);
      }

      const terminal = agentWorkflowRunEventSchema.parse(
        (
          await step.waitForEvent(`wait-stage-${stageIndex}`, {
            timeout: "2 hours",
            type: agentWorkflowStageEventType(stageIndex),
          })
        ).payload,
      );

      if (
        terminal.workflowId !== params.workflowId ||
        terminal.stageIndex !== stageIndex ||
        terminal.runId !== dispatched.runId
      ) {
        throw new Error("Crewhelm workflow received a mismatched stage event.");
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

            if (
              !result.ok &&
              ["workflow_busy", "workflow_unavailable"].includes(result.error.code)
            ) {
              throw new Error(
                `Crewhelm workflow stage ${stageIndex + 1} completion is unavailable.`,
              );
            }
            return result;
          },
        ),
      );

      if (!completed.ok) {
        throw new Error(`Crewhelm workflow stage ${stageIndex + 1} could not be finalized.`);
      }

      if (completed.workflowStatus === "failed") {
        await step.reportError(`Crewhelm workflow stage ${stageIndex + 1} failed.`);
        throw new Error(`Crewhelm workflow stage ${stageIndex + 1} failed.`);
      }

      if (completed.workflowStatus === "cancelled") {
        const result = { status: "cancelled" as const, workflowId: params.workflowId };
        await step.reportComplete(result);
        return result;
      }
    }

    const result = { status: "completed" as const, workflowId: params.workflowId };
    await step.reportComplete(result);
    return result;
  }
}
