import * as z from "zod";
import { describe, expect, it } from "vitest";

import {
  MAXIMUM_RUN_TIMELINE_EVENTS,
  createRunAdmissionInputSchema,
  inspectRunInputSchema,
  startRunInputSchema,
} from "./run-admission.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";
const branchId = "branch_00000000-0000-4000-8000-000000000001";
const sessionId = "session_00000000-0000-4000-8000-000000000001";

describe("run timeline budget", () => {
  it("emits the nonnegative timeline cursor bound", () => {
    expect(z.toJSONSchema(inspectRunInputSchema).properties?.timelineCursor).toMatchObject({
      minimum: 0,
    });
  });

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

  it("requires durable event provenance for an automatic Event Trigger Run", () => {
    const input = {
      agentId,
      expectedRevision: 1,
      idempotencyKey: "event-eventTrigger-run",
      promptCharacters: 1,
      promptDigest: "a".repeat(64),
      scheduleRevision: null,
      trigger: "event_trigger",
      eventTrigger: {
        eventId: "event_1",
        id: "event_trigger_00000000-0000-4000-8000-000000000001",
        revision: 1,
      },
    } as const;

    expect(createRunAdmissionInputSchema.safeParse(input).success).toBe(true);
    expect(
      createRunAdmissionInputSchema.safeParse({
        ...input,
        eventTrigger: undefined,
      }).success,
    ).toBe(false);
    expect(
      createRunAdmissionInputSchema.safeParse({
        ...input,
        scheduleRevision: 1,
        trigger: "schedule",
        eventTrigger: undefined,
      }).success,
    ).toBe(true);
  });
});
