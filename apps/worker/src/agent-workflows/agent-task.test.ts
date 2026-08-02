import { describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";

import { AgentTaskWorkflow, agentWorkflowStageEventType } from "./agent-task.js";

const workflowId = "workflow_00000000-0000-4000-8000-000000000001";
const agentId = "agent_00000000-0000-4000-8000-000000000001";
const ownerKey = `owner_${"a".repeat(43)}`;

function event() {
  return {
    payload: { agentId, ownerKey, stageCount: 2, workflowId },
    timestamp: new Date("2026-07-31T12:00:00.000Z"),
    type: "workflow",
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function runWithDispatchFailure(code: "invalid_request" | "workflow_unavailable") {
  const controlPlane = {
    dispatchAgentWorkflowStage: async () => ({
      error: { code, message: "Agent workflow request denied." },
      ok: false,
    }),
  };
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<unknown>) => callback(),
  };
  const runtime = {
    env: { OWNER_CONTROL_PLANE: { getByName: () => controlPlane } },
  };

  return Reflect.apply(Reflect.get(AgentTaskWorkflow.prototype, "run"), runtime, [event(), step]);
}

describe("AgentTaskWorkflow", () => {
  it("marks deterministic stage denials as non-retryable", async () => {
    const error = await rejectionOf(runWithDispatchFailure("invalid_request"));

    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: "Crewhelm workflow stage 1 was not admitted (invalid_request).",
    });
  });

  it("leaves transient stage unavailability retryable by the Workflow host", async () => {
    const error = await rejectionOf(runWithDispatchFailure("workflow_unavailable"));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(NonRetryableError);
    expect(error).toMatchObject({
      message: "Crewhelm workflow stage 1 admission is unavailable.",
    });
  });

  it("durably dispatches and completes stages in exact order", async () => {
    const runs = [
      "run_00000000-0000-4000-8000-000000000001",
      "run_00000000-0000-4000-8000-000000000002",
    ];
    const calls: string[] = [];
    const completeAgentWorkflowStage = vi.fn<
      (input: { stageIndex: number }) => Promise<{
        ok: true;
        status: "completed";
        workflowStatus: "completed" | "running";
      }>
    >(async (input) => ({
      ok: true as const,
      status: "completed" as const,
      workflowStatus: input.stageIndex === 1 ? ("completed" as const) : ("running" as const),
    }));
    const dispatchAgentWorkflowStage = vi.fn<
      (input: { stageIndex: number }) => Promise<{
        ok: true;
        runId: string | undefined;
        session: { branchId: string; branchRevision: number; sessionId: string };
        status: "running";
      }>
    >(async (input) => ({
      ok: true as const,
      runId: runs[input.stageIndex],
      session: {
        branchId: "branch_00000000-0000-4000-8000-000000000001",
        branchRevision: input.stageIndex + 1,
        sessionId: "session_00000000-0000-4000-8000-000000000001",
      },
      status: "running" as const,
    }));
    const reportComplete = vi.fn<(result?: unknown) => Promise<void>>(async () => undefined);
    const reportError = vi.fn<(error: Error | string) => Promise<void>>(async () => undefined);
    const controlPlane = {
      completeAgentWorkflowStage,
      dispatchAgentWorkflowStage,
    };
    const step = {
      do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
        calls.push(name);
        return callback();
      },
      reportComplete,
      reportError,
      waitForEvent: async (name: string, options: { type: string }) => {
        calls.push(name);
        const stageIndex = Number(name.slice(-1));
        expect(options.type).toBe(agentWorkflowStageEventType(stageIndex));
        return {
          payload: {
            runId: runs[stageIndex],
            stageIndex,
            status: "completed",
            workflowId,
          },
          timestamp: new Date(),
          type: options.type,
        };
      },
    };
    const runtime = {
      env: { OWNER_CONTROL_PLANE: { getByName: () => controlPlane } },
    };

    await expect(
      Reflect.apply(Reflect.get(AgentTaskWorkflow.prototype, "run"), runtime, [event(), step]),
    ).resolves.toEqual({ status: "completed", workflowId });
    expect(calls).toEqual([
      "dispatch-stage-0",
      "wait-stage-0",
      "complete-stage-0",
      "dispatch-stage-1",
      "wait-stage-1",
      "complete-stage-1",
    ]);
    expect(dispatchAgentWorkflowStage).toHaveBeenNthCalledWith(2, {
      agentId,
      stageIndex: 1,
      workflowId,
    });
    expect(reportComplete).toHaveBeenCalledWith({ status: "completed", workflowId });
    expect(reportError).not.toHaveBeenCalled();
  });
});
