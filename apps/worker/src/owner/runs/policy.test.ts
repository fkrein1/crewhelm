import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
  REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID,
  type ComposioToolGateInput,
  type ExternalToolGateInput,
} from "@crewhelm/contracts";
import { evaluateApprovedComposioToolAction, evaluateComposioToolAction } from "./policy.js";

const ownerKey = `owner_${"A".repeat(43)}`;
const agentId = "agent_11111111-1111-4111-8111-111111111111";
const connectionId = "connection_22222222-2222-4222-8222-222222222222";
const grantId = "grant_33333333-3333-4333-8333-333333333333";
const runId = "run_44444444-4444-4444-8444-444444444444";
const toolCallId = "tool_call_55555555-5555-4555-8555-555555555555";
const inputDigest = "a".repeat(64);
const readActionDigest = "e161e682d7ec465e3d837addbd2e3fa3f05b4ce1e21c1e5221e039223214c99d";
const approvalActionDigests = {
  destructive: "1f6a71fadc6693518cf286669b40c66cea3ad8189d117992823280175033702d",
  write: "9435ea6e78e7d73833b386ef51fb864a5cf4502bad887ff927bdd08ff40c68d3",
} as const;
const targetDigest = "b".repeat(64);
const otherTargetDigest = "c".repeat(64);
const trustedCurrentTime = "2026-07-27T18:20:00.000Z";

function exactInput(): ComposioToolGateInput {
  return {
    action: {
      agentId,
      agentRevision: 7,
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "read",
      estimatedCostMicrousd: 2_000,
      grantId,
      inputDigest,
      integrationSlug: "project_toolkit",
      ownerKey,
      runId,
      targetDigests: [targetDigest],
      toolCallId,
      toolkitVersion: "20260727_00",
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    },
    grant: {
      agentId,
      agentRevision: 7,
      authorization: "approval_required",
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "read",
      expiresAt: "2026-07-27T18:30:00.000Z",
      grantId,
      integrationSlug: "project_toolkit",
      limits: {
        maxCallsPerRun: 4,
        maxConcurrency: 2,
        maxCostMicrousdPerCall: 5_000,
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      ownerKey,
      targetDigests: [targetDigest, otherTargetDigest],
      tool: {
        description: "Read one item.",
        inputParametersJson: '{"itemId":{"required":true,"type":"string"}}',
        name: "Read item",
        outputParametersJson: '{"itemId":{"type":"string"}}',
        tags: ["readOnlyHint"],
      },
      toolkitVersion: "20260727_00",
      toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
    },
    policy: {
      activeGrantCalls: 0,
      agentId,
      agentStatus: "active",
      capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      connectionStatus: "active",
      currentAgentRevision: 7,
      durationLimitMs: 45_000,
      evaluatedAt: "2026-07-27T18:20:00.000Z",
      fleetCallsPerDayUsed: 20,
      fleetCallsPerThirtyDaysUsed: 200,
      grantCallsUsed: 0,
      grantId,
      grantStatus: "active",
      killSwitchActive: false,
      limits: {
        callsPerDay: 300,
        callsPerThirtyDays: 8_000,
        duplicateToolCallLimit: 2,
        maxCallsPerToolPerRun: 2,
        maxConcurrencyPerGrant: 1,
      },
      ownerKey,
      remainingCostMicrousd: 3_000,
      remainingDurationMs: 12_000,
      remainingOutputBytes: 32_000,
      remainingToolCalls: 2,
      runId,
      sameToolInputCallsUsed: 0,
      toolCallsUsed: 2,
    },
  };
}

function remoteMcpInput(): ExternalToolGateInput {
  const input = exactInput();
  return {
    action: {
      agentId,
      agentRevision: 7,
      capabilityId: REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      effect: "write",
      estimatedCostMicrousd: 0,
      grantId,
      inputDigest,
      ownerKey,
      runId,
      snapshotDigest: "d".repeat(64),
      targetDigests: [targetDigest],
      toolCallId,
      toolName: "projects.read",
    },
    grant: {
      agentId,
      agentRevision: 7,
      authorization: "approval_required",
      capabilityId: REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID,
      connectionId,
      description: "Read one project.",
      effect: "write",
      expiresAt: "2026-07-27T18:30:00.000Z",
      grantId,
      inputSchemaJson: '{"type":"object"}',
      limits: { ...input.grant.limits, maxCostMicrousdPerCall: 0 },
      ownerKey,
      snapshotDigest: "d".repeat(64),
      targetDigests: [targetDigest],
      toolName: "projects.read",
    },
    policy: {
      ...input.policy,
      capabilityId: REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID,
      remainingCostMicrousd: 0,
    },
  };
}

describe("ToolGate Composio policy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(trustedCurrentTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows one exact classified read action with the tightest current limits", async () => {
    expect(await evaluateComposioToolAction(exactInput())).toEqual({
      action: {
        agentId,
        agentRevision: 7,
        capabilityId: COMPOSIO_TOOL_EXECUTE_CAPABILITY_ID,
        connectionId,
        effect: "read",
        estimatedCostMicrousd: 2_000,
        grantId,
        inputDigest,
        integrationSlug: "project_toolkit",
        ownerKey,
        runId,
        targetDigests: [targetDigest],
        toolCallId,
        toolkitVersion: "20260727_00",
        toolSlug: "PROJECT_TOOLKIT_READ_ITEM",
      },
      actionDigest: readActionDigest,
      constraints: {
        decisionExpiresAt: "2026-07-27T18:20:30.000Z",
        maxCostMicrousd: 2_000,
        maxDurationMs: 12_000,
        maxOutputBytes: 32_000,
      },
      decision: "allow",
    });
  });

  it("never widens grant limits and shortens the decision to the grant expiry", async () => {
    const input = exactInput();
    input.grant.expiresAt = "2026-07-27T18:20:05.000Z";
    input.policy.remainingDurationMs = 30_000;
    input.policy.remainingOutputBytes = 100_000;
    const decision = await evaluateComposioToolAction(input);

    expect(decision).toMatchObject({
      constraints: {
        decisionExpiresAt: "2026-07-27T18:20:05.000Z",
        maxDurationMs: 20_000,
        maxOutputBytes: 64_000,
      },
      decision: "allow",
    });
  });

  it("derives the action digest from canonical classified input", async () => {
    const original = await evaluateComposioToolAction(exactInput());
    const changedInput = exactInput();
    changedInput.action.inputDigest = "d".repeat(64);
    const changed = await evaluateComposioToolAction(changedInput);

    expect(original.decision).toBe("allow");
    expect(changed.decision).toBe("allow");

    if (original.decision !== "allow" || changed.decision !== "allow") {
      throw new TypeError("Expected allowed test actions.");
    }

    expect(original.actionDigest).not.toBe(changed.actionDigest);
  });

  it.each([
    ["firecrawl", "FIRECRAWL_SEARCH", "20260701_00"],
    ["project_toolkit", "PROJECT_TOOLKIT_ACTION", "20260727_02"],
  ])(
    "keeps every valid exact catalog tool eligible without an integration allowlist: %s",
    async (integrationSlug, toolSlug, toolkitVersion) => {
      const input = exactInput();
      input.action.integrationSlug = integrationSlug;
      input.action.toolSlug = toolSlug;
      input.action.toolkitVersion = toolkitVersion;
      input.grant.integrationSlug = integrationSlug;
      input.grant.toolSlug = toolSlug;
      input.grant.toolkitVersion = toolkitVersion;

      expect((await evaluateComposioToolAction(input)).decision).toBe("allow");
    },
  );

  it.each([
    ["owner", { ownerKey: `owner_${"B".repeat(43)}` }],
    ["agent", { agentId: "agent_66666666-6666-4666-8666-666666666666" }],
    ["revision", { agentRevision: 8 }],
    ["grant", { grantId: "grant_77777777-7777-4777-8777-777777777777" }],
    ["connection", { connectionId: "connection_88888888-8888-4888-8888-888888888888" }],
    ["integration", { integrationSlug: "other_toolkit" }],
    ["tool", { toolSlug: "PROJECT_TOOLKIT_OTHER_ACTION" }],
    ["version", { toolkitVersion: "20260726_00" }],
    ["effect", { effect: "write" }],
    ["target", { targetDigests: ["d".repeat(64)] }],
  ])("denies a %s binding mismatch", async (_label, actionChange) => {
    const input = exactInput();
    Object.assign(input.action, actionChange);

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason: "grant_mismatch",
    });
  });

  it.each([
    ["owner", { ownerKey: `owner_${"B".repeat(43)}` }],
    ["agent", { agentId: "agent_66666666-6666-4666-8666-666666666666" }],
    ["revision", { currentAgentRevision: 8 }],
    ["grant", { grantId: "grant_77777777-7777-4777-8777-777777777777" }],
    ["connection", { connectionId: "connection_88888888-8888-4888-8888-888888888888" }],
    ["run", { runId: "run_99999999-9999-4999-8999-999999999999" }],
  ])("denies a cross-object %s policy snapshot", async (_label, policyChange) => {
    const input = exactInput();
    Object.assign(input.policy, policyChange);

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason: "policy_mismatch",
    });
  });

  it.each([
    ["kill switch", { killSwitchActive: true }, "policy_inactive"],
    ["disabled agent", { agentStatus: "disabled" }, "policy_inactive"],
    ["revoked agent", { agentStatus: "revoked" }, "policy_inactive"],
    ["revoked grant", { grantStatus: "revoked" }, "policy_inactive"],
    ["revoked connection", { connectionStatus: "revoked" }, "policy_inactive"],
    ["unavailable connection", { connectionStatus: "unavailable" }, "policy_inactive"],
  ])("denies an inactive current policy: %s", async (_label, policyChange, reason) => {
    const input = exactInput();
    Object.assign(input.policy, policyChange);

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason,
    });
  });

  it("denies an expired grant", async () => {
    const input = exactInput();
    input.policy.evaluatedAt = "2026-07-27T18:19:56.000Z";
    input.grant.expiresAt = "2026-07-27T18:19:59.999Z";

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason: "grant_expired",
    });
  });

  it.each([
    ["stale", "2026-07-27T18:19:54.999Z"],
    ["future-dated", "2026-07-27T18:20:00.001Z"],
  ])("denies a %s policy snapshot against trusted current time", async (_label, evaluatedAt) => {
    const input = exactInput();
    input.policy.evaluatedAt = evaluatedAt;

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason: "policy_stale",
    });
  });

  it.each([
    [
      "run calls",
      { remainingToolCalls: 0 },
      { dimension: "run_tool_calls", kind: "budget", limit: 2, used: 2 },
    ],
    [
      "grant calls",
      { grantCallsUsed: 4 },
      { dimension: "grant_tool_calls", kind: "budget", limit: 2, used: 4 },
    ],
    [
      "duration",
      { remainingDurationMs: 0 },
      { dimension: "run_duration_ms", kind: "budget", limit: 45_000, used: 45_000 },
    ],
    [
      "output",
      { remainingOutputBytes: 0 },
      { dimension: "tool_output_bytes", kind: "budget", limit: 64_000, used: 64_000 },
    ],
    [
      "cost",
      { remainingCostMicrousd: 1_999 },
      {
        dimension: "tool_cost_microusd",
        kind: "budget",
        limit: 1_999,
        requested: 2_000,
        used: 0,
      },
    ],
  ] as const)("denies an exhausted %s budget", async (_label, policyChange, details) => {
    const input = exactInput();
    Object.assign(input.policy, policyChange);

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      details,
      reason: "budget_exhausted",
    });
  });

  it("denies exhausted grant concurrency", async () => {
    const input = exactInput();
    input.policy.activeGrantCalls = 1;

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      details: { active: 1, kind: "concurrency", limit: 1 },
      reason: "concurrency_exhausted",
    });
  });

  it("denies repeated identical tool input as a likely loop", async () => {
    const input = exactInput();
    input.policy.sameToolInputCallsUsed = input.policy.limits.duplicateToolCallLimit;

    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      details: { calls: 2, kind: "duplicate_calls", limit: 2 },
      reason: "loop_detected",
    });
  });

  it.each([
    [
      "daily",
      { fleetCallsPerDayUsed: 300 },
      { dimension: "fleet_calls_per_day", kind: "rate", limit: 300, used: 300 },
    ],
    [
      "thirty-day",
      { fleetCallsPerThirtyDaysUsed: 8_000 },
      { dimension: "fleet_calls_per_thirty_days", kind: "rate", limit: 8_000, used: 8_000 },
    ],
  ] as const)(
    "denies an exhausted fleet %s integration-call limit",
    async (_label, policyChange, details) => {
      const input = exactInput();
      Object.assign(input.policy, policyChange);

      expect(await evaluateComposioToolAction(input)).toEqual({
        decision: "deny",
        details,
        reason: "rate_exhausted",
      });
    },
  );

  it("denies an unknown or over-grant action cost", async () => {
    const unknownCost = exactInput();
    unknownCost.action.estimatedCostMicrousd = null;
    const overGrantCost = exactInput();
    overGrantCost.action.estimatedCostMicrousd = 5_001;

    expect(await evaluateComposioToolAction(unknownCost)).toEqual({
      decision: "deny",
      reason: "unknown_cost",
    });
    expect(await evaluateComposioToolAction(overGrantCost)).toEqual({
      decision: "deny",
      details: {
        dimension: "tool_cost_microusd",
        kind: "budget",
        limit: 3_000,
        requested: 5_001,
        used: 0,
      },
      reason: "budget_exhausted",
    });

    unknownCost.action.effect = "write";
    unknownCost.grant.effect = "write";
    expect(await evaluateComposioToolAction(unknownCost)).toEqual({
      decision: "deny",
      reason: "unknown_cost",
    });
  });

  it.each(["write", "destructive"] as const)(
    "requires distinct owner approval for a classified %s effect",
    async (effect) => {
      const input = exactInput();
      input.action.effect = effect;
      input.grant.effect = effect;

      expect(await evaluateComposioToolAction(input)).toEqual({
        actionDigest: approvalActionDigests[effect],
        decision: "requires_approval",
        effect,
        grantId,
      });
    },
  );

  it("allows a routine write under exact standing authority but still escalates destruction", async () => {
    const standingWrite = exactInput();
    standingWrite.action.effect = "write";
    standingWrite.grant.effect = "write";
    standingWrite.grant.authorization = "standing";

    await expect(evaluateComposioToolAction(standingWrite)).resolves.toMatchObject({
      action: { effect: "write" },
      decision: "allow",
    });

    const destructive = exactInput();
    destructive.action.effect = "destructive";
    destructive.grant.effect = "destructive";
    destructive.grant.authorization = "standing";

    await expect(evaluateComposioToolAction(destructive)).resolves.toMatchObject({
      decision: "requires_approval",
      effect: "destructive",
    });
  });

  it("allows an exact sensitive action only with matching owner approval evidence", async () => {
    const input = exactInput();
    input.action.effect = "write";
    input.grant.effect = "write";

    expect(
      await evaluateApprovedComposioToolAction(input, approvalActionDigests.write),
    ).toMatchObject({
      action: { effect: "write" },
      actionDigest: approvalActionDigests.write,
      decision: "allow",
    });
    expect(await evaluateApprovedComposioToolAction(input, "d".repeat(64))).toEqual({
      actionDigest: approvalActionDigests.write,
      decision: "requires_approval",
      effect: "write",
      grantId,
    });
  });

  it.each([
    null,
    {},
    { ...exactInput(), unexpected: true },
    {
      ...exactInput(),
      action: { ...exactInput().action, arguments: { secret: "must-not-enter-tool-gate" } },
    },
    {
      ...exactInput(),
      action: { ...exactInput().action, targetDigests: [targetDigest, targetDigest] },
    },
    {
      ...exactInput(),
      grant: { ...exactInput().grant, toolkitVersion: "latest" },
    },
  ])("fails malformed or authority-ambiguous input closed", async (input) => {
    expect(await evaluateComposioToolAction(input)).toEqual({
      decision: "deny",
      reason: "invalid_request",
    });
  });

  it("applies the same approval gate to one exact frozen remote MCP tool", async () => {
    const input = remoteMcpInput();
    const decision = await evaluateComposioToolAction(input);

    expect(decision).toMatchObject({
      decision: "requires_approval",
      effect: "write",
      grantId,
    });
    if (decision.decision !== "requires_approval") {
      throw new Error("Expected remote MCP approval requirement.");
    }
    await expect(
      evaluateApprovedComposioToolAction(input, decision.actionDigest),
    ).resolves.toMatchObject({
      action: {
        capabilityId: REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID,
        snapshotDigest: "d".repeat(64),
        toolName: "projects.read",
      },
      decision: "allow",
    });
  });

  it("denies a stale remote MCP catalog binding", async () => {
    const input = remoteMcpInput();
    if (input.grant.capabilityId !== REMOTE_MCP_TOOL_EXECUTE_CAPABILITY_ID) {
      throw new Error("Expected remote MCP grant.");
    }
    input.grant.snapshotDigest = "e".repeat(64);

    await expect(evaluateComposioToolAction(input)).resolves.toEqual({
      decision: "deny",
      reason: "grant_mismatch",
    });
  });
});
