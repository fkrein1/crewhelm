import { describe, expect, it } from "vitest";

import {
  MAXIMUM_AGENT_WORKFLOW_PLAN_CHARACTERS,
  MAXIMUM_AGENT_WORKFLOW_STAGE_DELAY_SECONDS,
  MAXIMUM_AGENT_WORKFLOW_TOTAL_DELAY_SECONDS,
  DEFAULT_AGENT_WORKFLOW_STAGE_MAX_WAIT_SECONDS,
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

  it("freezes an elapsed waiting window without requiring retry choreography", () => {
    const parsed = startAgentWorkflowInputSchema.parse({
      agentId,
      expectedRevision: 3,
      idempotencyKey: "workflow-deferral",
      objective: "Wait until the external estimate is ready.",
      stages: [
        {
          deferral: {},
          name: "Wait for estimate",
          prompt: "Check the estimate and checkpoint wait or done.",
        },
        { name: "Send proposal", prompt: "Send the completed proposal." },
      ],
    });
    expect(parsed.stages[0]?.deferral?.maxWaitSeconds).toBe(
      DEFAULT_AGENT_WORKFLOW_STAGE_MAX_WAIT_SECONDS,
    );
    expect(
      startAgentWorkflowInputSchema.safeParse({
        ...parsed,
        stages: [
          {
            ...parsed.stages[0],
            deferral: { maxWaitSeconds: MAXIMUM_AGENT_WORKFLOW_STAGE_DELAY_SECONDS + 1 },
          },
          parsed.stages[1],
        ],
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

  it("defaults stage delays to zero and bounds individual and aggregate waiting", () => {
    const parsed = startAgentWorkflowInputSchema.parse({
      agentId,
      expectedRevision: 3,
      idempotencyKey: "workflow-delay",
      objective: "Wait durably before finalizing.",
      stages: [
        { name: "Start", prompt: "Start the asynchronous work." },
        {
          delayBeforeSeconds: 300,
          name: "Finish",
          prompt: "Finish after the provider has had time to complete.",
        },
      ],
    });
    expect(parsed.stages.map((stage) => stage.delayBeforeSeconds)).toEqual([0, 300]);

    expect(
      startAgentWorkflowInputSchema.safeParse({
        ...parsed,
        stages: [
          ...parsed.stages,
          {
            delayBeforeSeconds: MAXIMUM_AGENT_WORKFLOW_STAGE_DELAY_SECONDS + 1,
            name: "Too late",
            prompt: "This delay is not bounded.",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      startAgentWorkflowInputSchema.safeParse({
        ...parsed,
        stages: Array.from({ length: 5 }, (_, index) => ({
          delayBeforeSeconds: Math.floor(MAXIMUM_AGENT_WORKFLOW_TOTAL_DELAY_SECONDS / 4),
          name: `Stage ${index}`,
          prompt: "Wait within the per-stage limit but exceed the aggregate limit.",
        })),
      }).success,
    ).toBe(false);
  });

  it("keeps inspection compact unless prompts are explicitly requested", () => {
    const workflowId = "workflow_00000000-0000-4000-8000-000000000001";

    expect(agentWorkflowIdSchema.safeParse(workflowId).success).toBe(true);
    expect(inspectAgentWorkflowInputSchema.parse({ workflowId })).toEqual({
      includeDeliverable: false,
      includePrompts: false,
      workflowId,
    });
  });
});
