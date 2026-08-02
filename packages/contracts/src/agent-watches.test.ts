import { describe, expect, it } from "vitest";

import { agentWatchesInputSchema, agentWatchesToolInputSchema } from "./agent-watches.js";

describe("Agent Watch contracts", () => {
  it("keeps the model-visible scheduled check compact and human-scaled", () => {
    expect(
      agentWatchesToolInputSchema.parse({
        action: "create",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedAgentRevision: 1,
        idempotencyKey: "watch-create",
        watch: {
          everyMinutes: 10,
          instruction: "Check the inbox and report work that needs attention.",
          name: "Inbox attention",
        },
      }),
    ).toMatchObject({ action: "create", watch: { everyMinutes: 10 } });
  });

  it("accepts understandable connected-event filters without arbitrary nested payloads", () => {
    const input = {
      action: "create",
      agentId: "agent_00000000-0000-4000-8000-000000000001",
      expectedAgentRevision: 1,
      idempotencyKey: "watch-event-create",
      watch: {
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

    expect(agentWatchesToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      agentWatchesToolInputSchema.safeParse({
        ...input,
        watch: { ...input.watch, filters: { repository: { owner: "crewhelm" } } },
      }).success,
    ).toBe(false);
  });

  it("rejects fields that belong to another lifecycle action", () => {
    expect(
      agentWatchesToolInputSchema.safeParse({
        action: "sources",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(
      agentWatchesToolInputSchema.safeParse({
        action: "pause",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("requires an exact frozen source descriptor inside the control plane", () => {
    expect(
      agentWatchesInputSchema.safeParse({
        action: "create",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedAgentRevision: 1,
        idempotencyKey: "watch-create",
        watch: {
          instruction: "Check the inbox.",
          name: "Inbox attention",
          source: {
            kind: "scheduled_check",
            trigger: { intervalSeconds: 600, type: "interval" },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      agentWatchesInputSchema.safeParse({
        action: "create",
        agentId: "agent_00000000-0000-4000-8000-000000000001",
        expectedAgentRevision: 1,
        idempotencyKey: "watch-create",
        watch: {
          everyMinutes: 10,
          instruction: "Check the inbox.",
          name: "Inbox attention",
        },
      }).success,
    ).toBe(false);
  });
});
