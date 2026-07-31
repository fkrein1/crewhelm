import { describe, expect, it } from "vitest";

import {
  MAXIMUM_AGENT_WORKFLOW_PLAN_CHARACTERS,
  agentWorkflowIdSchema,
  inspectAgentWorkflowInputSchema,
  startAgentWorkflowInputSchema,
} from "./agent-workflows.js";

const agentId = "agent_00000000-0000-4000-8000-000000000001";

describe("Agent workflow contracts", () => {
  it("requires a bounded multi-Run plan", () => {
    expect(
      startAgentWorkflowInputSchema.safeParse({
        agentId,
        expectedRevision: 3,
        idempotencyKey: "workflow-1",
        objective: "Research the release and prepare a concise recommendation.",
        stages: [
          { name: "Research", prompt: "Collect the relevant facts and sources." },
          {
            name: "Synthesize",
            prompt: "Use the collected context to produce the recommendation.",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      startAgentWorkflowInputSchema.safeParse({
        agentId,
        expectedRevision: 3,
        idempotencyKey: "workflow-1",
        objective: "One run is not a workflow.",
        stages: [{ name: "Only", prompt: "Do everything." }],
      }).success,
    ).toBe(false);
  });

  it("rejects an aggregate plan that exceeds the MCP payload budget", () => {
    const oversized = "x".repeat(Math.floor(MAXIMUM_AGENT_WORKFLOW_PLAN_CHARACTERS / 5) + 1_000);

    expect(
      startAgentWorkflowInputSchema.safeParse({
        agentId,
        expectedRevision: 1,
        idempotencyKey: "workflow-large",
        objective: "Bound this plan.",
        stages: [
          { name: "One", prompt: oversized },
          { name: "Two", prompt: oversized },
          { name: "Three", prompt: oversized },
          { name: "Four", prompt: oversized },
          { name: "Five", prompt: oversized },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps inspection compact unless prompts are explicitly requested", () => {
    const workflowId = "workflow_00000000-0000-4000-8000-000000000001";

    expect(agentWorkflowIdSchema.safeParse(workflowId).success).toBe(true);
    expect(inspectAgentWorkflowInputSchema.parse({ workflowId })).toEqual({
      includePrompts: false,
      workflowId,
    });
  });
});
