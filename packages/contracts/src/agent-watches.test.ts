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
