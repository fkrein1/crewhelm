import type { ControlPlaneStatus } from "@crewhelm/contracts";
import { describe, expect, it } from "vitest";

import { MCP_SERVER_INSTRUCTIONS, statusGuidance } from "./guidance.js";

function fleetStatus(input?: {
  activeAgents?: number;
  activeRuns?: number;
  activeWorkflows?: number;
  needsAction?: number;
  totalAgents?: number;
  unresolvedEffects?: number;
}): ControlPlaneStatus {
  return {
    capacity: {
      maxAgents: 100,
      maxConcurrentRuns: 25,
      maxConnections: 100,
      retention: {
        inboxSeconds: 2_592_000,
        runSeconds: 2_592_000,
      },
    },
    configurationRevision: 1,
    schemaVersion: 1,
    status: "ready",
    usage: {
      agents: {
        active: input?.activeAgents ?? 0,
        total: input?.totalAgents ?? 0,
      },
      connections: { active: 0, pending: 0, total: 0 },
      diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
      inbox: {
        actionRequired: input?.needsAction ?? 0,
        attention: {
          needsAction: input?.needsAction ?? 0,
          oldestNeedsActionAt: null,
          warnings: 0,
        },
        deferred: 0,
        exceptions: 0,
        outcomes: 0,
        total: input?.needsAction ?? 0,
      },
      recovery: { unresolvedEffects: input?.unresolvedEffects ?? 0 },
      runs: { active: input?.activeRuns ?? 0 },
      skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
      workflows: { active: input?.activeWorkflows ?? 0, total: input?.activeWorkflows ?? 0 },
    },
  };
}

describe("MCP first-use guidance", () => {
  it("keeps initialization guidance compact and centered on bounded discovery", () => {
    expect(new TextEncoder().encode(MCP_SERVER_INSTRUCTIONS).byteLength).toBeLessThanOrEqual(1_536);
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Start with crewhelm_status");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Choose one intent operation");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Pass returned Crewhelm references unchanged");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("Attach returned Briefs");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("start_workflow");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("owner-scoped drafts");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("owner verifies it with the provider");
  });

  it("asks for owner intent instead of inventing an Agent on an empty fleet", () => {
    expect(statusGuidance(fleetStatus())).toEqual([
      {
        kind: "user_decision",
        reason: "empty_fleet",
        tool: "crewhelm_change_agents",
      },
    ]);
  });

  it("prioritizes recovery and attention before bounded Agent selection", () => {
    expect(
      statusGuidance(
        fleetStatus({
          activeAgents: 2,
          activeRuns: 2,
          needsAction: 3,
          totalAgents: 2,
          unresolvedEffects: 1,
        }),
      ),
    ).toEqual([
      {
        arguments: { operation: { kind: "unresolved_effects", limit: 10 } },
        kind: "read",
        reason: "unresolved_effects",
        tool: "crewhelm_inspect_recovery",
      },
      {
        arguments: { operation: { kind: "list_inbox", limit: 10, needsAction: true } },
        kind: "read",
        reason: "inbox_attention",
        tool: "crewhelm_inspect_work",
      },
      {
        arguments: { operation: { kind: "list_runs", limit: 10, status: "active" } },
        kind: "read",
        reason: "active_runs",
        tool: "crewhelm_inspect_work",
      },
    ]);
  });

  it("prioritizes bounded discovery of active work before starting more", () => {
    expect(
      statusGuidance(
        fleetStatus({ activeAgents: 1, activeRuns: 2, activeWorkflows: 1, totalAgents: 1 }),
      ),
    ).toEqual([
      {
        arguments: { operation: { kind: "list_workflows", limit: 10, status: "active" } },
        kind: "read",
        reason: "active_workflows",
        tool: "crewhelm_inspect_work",
      },
      {
        arguments: { operation: { kind: "list_runs", limit: 10, status: "active" } },
        kind: "read",
        reason: "active_runs",
        tool: "crewhelm_inspect_work",
      },
      {
        arguments: { operation: { kind: "list", limit: 10, status: "active" } },
        kind: "read",
        reason: "choose_agent",
        tool: "crewhelm_inspect_agents",
      },
    ]);
  });

  it("does not claim a disabled fleet is runnable", () => {
    expect(statusGuidance(fleetStatus({ totalAgents: 2 }))).toEqual([
      {
        arguments: { operation: { kind: "list", limit: 10 } },
        kind: "read",
        reason: "review_disabled_agents",
        tool: "crewhelm_inspect_agents",
      },
    ]);
  });
});
