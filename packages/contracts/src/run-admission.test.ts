import { describe, expect, it } from "vitest";

import { MAXIMUM_RUN_TIMELINE_EVENTS, startRunInputSchema } from "./run-admission.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";
const branchId = "branch_00000000-0000-4000-8000-000000000001";
const sessionId = "session_00000000-0000-4000-8000-000000000001";

describe("run timeline budget", () => {
  it("retains the legal worst-case run envelope", () => {
    const runStateEvents = 4;
    const inferenceEvents = 100;
    const toolCalls = 100;
    const eventsPerToolCall = 9;

    expect(MAXIMUM_RUN_TIMELINE_EVENTS).toBeGreaterThanOrEqual(
      runStateEvents + inferenceEvents + toolCalls * eventsPerToolCall,
    );
  });

  it("accepts one conversation handle without mixing legacy continuation authority", () => {
    const base = {
      agentId,
      expectedRevision: 1,
      idempotencyKey: "conversation-turn-1",
      prompt: "Continue our conversation.",
    };

    expect(
      startRunInputSchema.safeParse({
        ...base,
        conversation: { expectedRevision: 2, id: sessionId },
      }).success,
    ).toBe(true);
    expect(
      startRunInputSchema.safeParse({
        ...base,
        continuation: { branchId, expectedBranchRevision: 2, sessionId },
        conversation: { expectedRevision: 2, id: sessionId },
      }).success,
    ).toBe(false);
  });
});
