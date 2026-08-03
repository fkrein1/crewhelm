import { describe, expect, it } from "vitest";

import { facadeRehearsalToolCall } from "../../src/rehearsal/mcp.js";

describe("rehearsal MCP facade calls", () => {
  it("moves replay and composed Agent coordinates behind intent operations", () => {
    expect(
      facadeRehearsalToolCall("crewhelm_start_run", {
        agentId: "agent_fixture",
        continuation: null,
        expectedRevision: 7,
        idempotencyKey: "fixture-run",
        prompt: "Do one bounded task.",
      }),
    ).toEqual({
      arguments: {
        operation: {
          agent: { id: "agent_fixture", revision: 7 },
          kind: "run",
          message: "Do one bounded task.",
          requestKey: "fixture-run",
        },
      },
      name: "crewhelm_change_work",
    });
  });

  it("passes schedule and provider identities as copy-ready objects", () => {
    expect(
      facadeRehearsalToolCall("crewhelm_configure_agent_schedule", {
        agentId: "agent_fixture",
        expectedAgentRevision: 4,
        expectedScheduleRevision: 3,
        idempotencyKey: "fixture-schedule",
        schedule: { name: "Daily review" },
        scheduleId: "schedule_fixture",
      }),
    ).toMatchObject({
      arguments: {
        operation: {
          definition: { name: "Daily review" },
          kind: "update_schedule",
          schedule: {
            agentId: "agent_fixture",
            agentRevision: 4,
            id: "schedule_fixture",
            revision: 3,
          },
        },
      },
      name: "crewhelm_change_automations",
    });

    expect(
      facadeRehearsalToolCall("crewhelm_configure_agent_connection", {
        agentId: "agent_fixture",
        connectionId: "connection_fixture",
        expectedRevision: 4,
        tools: [],
      }),
    ).toMatchObject({
      arguments: {
        operation: {
          agent: { id: "agent_fixture", revision: 4 },
          connection: { connectionId: "connection_fixture" },
          kind: "grant_provider_actions",
        },
      },
      name: "crewhelm_change_connections",
    });
  });

  it("turns target and recovery commands into explicit operations", () => {
    expect(
      facadeRehearsalToolCall("crewhelm_get_config", {
        target: { id: "tools.web-search", kind: "agent-capability" },
      }),
    ).toEqual({
      arguments: {
        operation: { id: "tools.web-search", kind: "inspect_capabilities" },
      },
      name: "crewhelm_inspect_context",
    });

    expect(
      facadeRehearsalToolCall("crewhelm_revoke_authority", {
        grantId: "grant_fixture",
        target: "capability",
      }),
    ).toEqual({
      arguments: {
        operation: { grant: { grantId: "grant_fixture" }, kind: "revoke_capability" },
      },
      name: "crewhelm_recover",
    });
  });
});
