import { describe, expect, it } from "vitest";

import {
  browseAgentSessionsInputSchema,
  continuationFromRunSession,
  manageAgentSessionsInputSchema,
  sessionContinuationSchema,
} from "./agent-sessions.js";

const sessionId = "session_00000000-0000-4000-8000-000000000001";
const branchId = "branch_00000000-0000-4000-8000-000000000001";

describe("Agent session contracts", () => {
  it("requires exact branch coordinates for continuation", () => {
    expect(
      sessionContinuationSchema.safeParse({
        branchId,
        expectedBranchRevision: 3,
        sessionId,
      }).success,
    ).toBe(true);
    expect(
      sessionContinuationSchema.safeParse({ expectedBranchRevision: 3, sessionId }).success,
    ).toBe(false);
    expect(
      sessionContinuationSchema.safeParse({ branchId, expectedRevision: 3, sessionId }).success,
    ).toBe(false);
  });

  it("projects run coordinates into a copy-ready continuation", () => {
    expect(continuationFromRunSession({ branchId, branchRevision: 3, sessionId })).toEqual({
      branchId,
      expectedBranchRevision: 3,
      sessionId,
    });
    expect(continuationFromRunSession(undefined)).toBeUndefined();
  });

  it("keeps read actions compact and deletion fields exact", () => {
    expect(
      manageAgentSessionsInputSchema.safeParse({
        action: "list",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        limit: 10,
      }).success,
    ).toBe(true);
    expect(
      manageAgentSessionsInputSchema.safeParse({
        action: "delete",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedBranchRevision: 3,
        idempotencyKey: "delete-session-1",
        sessionId,
      }).success,
    ).toBe(true);
    expect(
      manageAgentSessionsInputSchema.safeParse({
        action: "inspect",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      browseAgentSessionsInputSchema.safeParse({
        action: "inspect",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        sessionId,
      }).success,
    ).toBe(true);
    expect(
      manageAgentSessionsInputSchema.safeParse({
        action: "list",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        idempotencyKey: "irrelevant-delete-field",
      }).success,
    ).toBe(false);
  });
});
