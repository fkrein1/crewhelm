import { describe, expect, it } from "vitest";

import {
  agentEventTriggersInputSchema,
  agentEventTriggersToolInputSchema,
} from "./agent-event-triggers.js";

describe("Agent Event Trigger contracts", () => {
  it("requires an exact Connection when discovering event sources", () => {
    expect(
      agentEventTriggersToolInputSchema.parse({
        action: "sources",
        connectionId: "connection_00000000-0000-4000-8000-000000000001",
      }),
    ).toEqual({
      action: "sources",
      connectionId: "connection_00000000-0000-4000-8000-000000000001",
    });
  });

  it("accepts understandable connected-event filters without arbitrary nested payloads", () => {
    const input = {
      action: "create",
      agentId: "agent_00000000-0000-4000-8000-000000000001",
      expectedAgentRevision: 1,
      idempotencyKey: "eventTrigger-event-create",
      eventTrigger: {
        connectionId: "connection_00000000-0000-4000-8000-000000000001",
        delivery: "realtime",
        eventSlug: "GITHUB_ISSUE_CREATED",
        eventVersion: "20260802_00",
        filters: { includeDrafts: false, repository: "crewhelm" },
        integrationSlug: "github",
        instruction: "Triage the new issue and recommend the next owner action.",
        name: "New GitHub issues",
      },
    } as const;

    expect(agentEventTriggersToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      agentEventTriggersToolInputSchema.safeParse({
        ...input,
        eventTrigger: { ...input.eventTrigger, filters: { repository: { owner: "crewhelm" } } },
      }).success,
    ).toBe(false);
  });

  it("rejects fields that belong to another lifecycle action", () => {
    expect(
      agentEventTriggersToolInputSchema.safeParse({
        action: "sources",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      agentEventTriggersToolInputSchema.safeParse({
        action: "pause",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("requires an exact frozen source descriptor inside the control plane", () => {
    expect(
      agentEventTriggersInputSchema.safeParse({
        action: "create",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedAgentRevision: 1,
        idempotencyKey: "eventTrigger-create",
        eventTrigger: {
          instruction: "Triage the new issue.",
          name: "New GitHub issues",
          source: {
            configuration: { repository: "crewhelm" },
            connectionId: "connection_00000000-0000-4000-8000-000000000001",
            delivery: "realtime",
            integrationSlug: "github",
            kind: "connection_event",
            sourceSlug: "GITHUB_ISSUE_CREATED",
            sourceVersion: "20260802_00",
          },
        },
      }).success,
    ).toBe(true);
    expect(
      agentEventTriggersInputSchema.safeParse({
        action: "create",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedAgentRevision: 1,
        idempotencyKey: "eventTrigger-create",
        eventTrigger: {
          everyMinutes: 10,
          instruction: "Check the inbox.",
          name: "Inbox attention",
        },
      }).success,
    ).toBe(false);
  });
});
