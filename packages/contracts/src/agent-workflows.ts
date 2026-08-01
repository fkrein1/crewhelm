import * as z from "zod";

import { runIdSchema, sha256DigestSchema } from "./capabilities.js";
import {
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  runPromptSchema,
  runStatusSchema,
} from "./run-admission.js";
import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
  ownerKeySchema,
} from "./control-plane.js";
import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";
import { runSessionSchema } from "./agent-sessions.js";
import { admittedBriefReferenceSchema, artifactIdSchema, briefReferencesSchema } from "./briefs.js";

export const MAXIMUM_AGENT_WORKFLOW_STAGES = 8;
export const MAXIMUM_AGENT_WORKFLOW_OBJECTIVE_CHARACTERS = 4 * 1_024;
export const MAXIMUM_AGENT_WORKFLOW_STAGE_NAME_CHARACTERS = 80;
export const MAXIMUM_AGENT_WORKFLOW_STAGE_PROMPT_CHARACTERS = 11 * 1_024;
export const MAXIMUM_AGENT_WORKFLOW_PLAN_CHARACTERS = 48 * 1_024;
export const MAXIMUM_AGENT_WORKFLOWS_PER_OWNER = 1_000;
export const MAXIMUM_ACTIVE_AGENT_WORKFLOWS_PER_OWNER = 32;
export const MAXIMUM_WORKFLOW_DELIVERABLE_BYTES = MAXIMUM_RUN_OUTPUT_CHARACTERS * 3;

export const agentWorkflowIdSchema = z
  .string()
  .regex(
    /^workflow_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm workflow ID.",
  );

export const agentWorkflowStatusSchema = z.enum([
  "queued",
  "running",
  "waiting",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
]);

export const agentWorkflowStageStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

export const agentWorkflowStagePlanSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGE_NAME_CHARACTERS)
    .describe("Short progress label for one ordered stage."),
  prompt: z
    .string()
    .min(1)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGE_PROMPT_CHARACTERS)
    .describe(
      "One bounded Run instruction. Crewhelm admits it with the shared objective and exact durable Session produced by the prior stage.",
    ),
});

export const agentWorkflowFailureSchema = z.strictObject({
  code: z.enum([
    "agent_unavailable",
    "budget_exhausted",
    "brief_unavailable",
    "capability_unavailable",
    "coordinator_failed",
    "model_unavailable",
    "revision_conflict",
    "run_failed",
    "workflow_unavailable",
  ]),
  nextAction: z.enum(["inspect_run", "inspect_workflow", "review_agent"]),
  runId: runIdSchema.nullable(),
  stageIndex: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGES - 1),
});

export const agentWorkflowAggregateBudgetSchema = z.strictObject({
  maxDurationSeconds: z.number().int().min(2).max(28_800).safe(),
  maxModelTokens: z.number().int().min(2).max(8_000_000).safe(),
  maxToolCalls: z.number().int().min(0).max(800).safe(),
  maxTurns: z.number().int().min(2).max(800).safe(),
});

export const agentWorkflowStageSummarySchema = z.strictObject({
  completedAt: z.iso.datetime().nullable(),
  index: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGES - 1),
  name: z.string().min(1).max(MAXIMUM_AGENT_WORKFLOW_STAGE_NAME_CHARACTERS),
  prompt: runPromptSchema.optional(),
  runId: runIdSchema.nullable(),
  startedAt: z.iso.datetime().nullable(),
  status: agentWorkflowStageStatusSchema,
});

export const agentWorkflowSummarySchema = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  briefs: z.array(admittedBriefReferenceSchema).max(8).default([]),
  budget: agentWorkflowAggregateBudgetSchema,
  completedAt: z.iso.datetime().nullable(),
  completedStages: z.number().int().nonnegative().max(MAXIMUM_AGENT_WORKFLOW_STAGES),
  createdAt: z.iso.datetime(),
  currentRunId: runIdSchema.nullable(),
  currentStage: agentWorkflowStageSummarySchema.omit({ prompt: true }).nullable(),
  failure: agentWorkflowFailureSchema.nullable(),
  revision: z.number().int().positive().safe(),
  stageCount: z.number().int().min(2).max(MAXIMUM_AGENT_WORKFLOW_STAGES),
  status: agentWorkflowStatusSchema,
  updatedAt: z.iso.datetime(),
  workflowId: agentWorkflowIdSchema,
});

export const workflowDeliverableSchema = z.strictObject({
  artifactId: artifactIdSchema,
  createdAt: z.iso.datetime(),
  digest: sha256DigestSchema,
  mediaType: z.literal("text/markdown"),
  runId: runIdSchema,
  truncated: z.boolean(),
  sizeBytes: z.number().int().nonnegative().max(MAXIMUM_WORKFLOW_DELIVERABLE_BYTES),
  stageIndex: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGES - 1),
});

export const agentWorkflowSchema = agentWorkflowSummarySchema.extend({
  deliverable: workflowDeliverableSchema.nullable(),
  deliverableContent: z.string().max(MAXIMUM_RUN_OUTPUT_CHARACTERS).optional(),
  objective: z.string().min(1).max(MAXIMUM_AGENT_WORKFLOW_OBJECTIVE_CHARACTERS),
  session: runSessionSchema.nullable(),
  stages: z.array(agentWorkflowStageSummarySchema).min(2).max(MAXIMUM_AGENT_WORKFLOW_STAGES),
});

export const startAgentWorkflowInputSchema = z
  .strictObject({
    agentId: agentIdSchema.describe("Exact Agent that will execute every stage."),
    briefs: briefReferencesSchema
      .describe("Exact immutable Brief revisions shared by every Workflow stage.")
      .optional(),
    expectedRevision: agentRevisionNumberSchema.describe(
      "Current Agent revision. The whole workflow remains frozen to it.",
    ),
    idempotencyKey: agentMutationIdempotencyKeySchema.describe(
      "Stable key for safely replaying this exact start request.",
    ),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(MAXIMUM_AGENT_WORKFLOW_OBJECTIVE_CHARACTERS)
      .describe("The durable outcome shared by all ordered stages."),
    stages: z
      .array(agentWorkflowStagePlanSchema)
      .min(2)
      .max(MAXIMUM_AGENT_WORKFLOW_STAGES)
      .describe("Two to eight bounded Runs, executed sequentially in one durable Session."),
  })
  .superRefine((input, context) => {
    const planCharacters =
      input.objective.length +
      input.stages.reduce((total, stage) => total + stage.name.length + stage.prompt.length, 0);

    if (planCharacters > MAXIMUM_AGENT_WORKFLOW_PLAN_CHARACTERS) {
      context.addIssue({
        code: "custom",
        message: "Workflow objective and stages exceed the bounded plan size.",
        path: ["stages"],
      });
    }
  });

export const listAgentWorkflowsInputSchema = z.strictObject({
  agentId: agentIdSchema.optional().describe("Return workflows for one exact Agent."),
  cursor: agentWorkflowIdSchema.optional(),
  limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(10),
  status: z
    .union([agentWorkflowStatusSchema, z.literal("active")])
    .optional()
    .describe('Return one projected state, or use "active" for queued through cancelling.'),
});

export const inspectAgentWorkflowInputSchema = z.strictObject({
  includeDeliverable: z
    .boolean()
    .default(false)
    .describe("Include the final report content. Omit for compact inspection."),
  includePrompts: z
    .boolean()
    .default(false)
    .describe("Include the frozen stage prompts. Omit for a compact inspection."),
  workflowId: agentWorkflowIdSchema.describe("Exact workflowId returned by start or list."),
});

export const cancelAgentWorkflowInputSchema = z.strictObject({
  expectedRevision: z
    .number()
    .int()
    .positive()
    .safe()
    .describe("Current Workflow revision from start, list, or inspect."),
  workflowId: agentWorkflowIdSchema.describe("Exact Workflow to stop."),
});

export const deleteAgentWorkflowInputSchema = z.strictObject({
  expectedRevision: z
    .number()
    .int()
    .positive()
    .safe()
    .describe("Current terminal Workflow revision from inspect."),
  idempotencyKey: agentMutationIdempotencyKeySchema.describe(
    "Stable key for safely replaying this exact deletion.",
  ),
  workflowId: agentWorkflowIdSchema.describe(
    "Terminal Workflow whose plan, correlated Session, and retained execution data should be removed.",
  ),
});

export const manageAgentWorkflowsInputSchema = z
  .strictObject({
    action: z
      .enum(["cancel", "delete", "inspect", "list", "start"])
      .describe(
        "Choose one action and send only its fields: cancel(workflowId, expectedRevision); delete(workflowId, expectedRevision, idempotencyKey); inspect(workflowId, includePrompts?, includeDeliverable?); list(agentId?, cursor?, limit?, status?); start(agentId, expectedRevision, idempotencyKey, objective, stages, briefs?).",
      ),
    agentId: agentIdSchema
      .optional()
      .describe("Required for start; optional as an exact list filter."),
    cursor: agentWorkflowIdSchema.optional().describe("For list, continue after this workflowId."),
    expectedRevision: z
      .number()
      .int()
      .positive()
      .safe()
      .optional()
      .describe("Required: Agent revision for start; Workflow revision for cancel or delete."),
    idempotencyKey: agentMutationIdempotencyKeySchema
      .optional()
      .describe("Required for start and delete; reuse only for the exact same request."),
    includePrompts: z
      .boolean()
      .optional()
      .describe("For inspect only. Defaults false to avoid fetching frozen prompts."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAXIMUM_FLEET_LIST_ITEMS)
      .optional()
      .describe("For list, bounded page size; defaults to 10."),
    briefs: briefReferencesSchema
      .optional()
      .describe("For start, exact immutable Brief revisions shared by every stage."),
    includeDeliverable: z
      .boolean()
      .optional()
      .describe("For inspect only. Defaults false to avoid fetching report content."),
    objective: z
      .string()
      .trim()
      .min(1)
      .max(MAXIMUM_AGENT_WORKFLOW_OBJECTIVE_CHARACTERS)
      .optional()
      .describe("Required for start: the durable outcome shared by every stage."),
    stages: z
      .array(agentWorkflowStagePlanSchema)
      .min(2)
      .max(MAXIMUM_AGENT_WORKFLOW_STAGES)
      .optional()
      .describe("Required for start: two to eight ordered bounded Runs."),
    status: z
      .union([agentWorkflowStatusSchema, z.literal("active")])
      .optional()
      .describe('For list, return one state or use "active" for unfinished workflows.'),
    workflowId: agentWorkflowIdSchema
      .optional()
      .describe("Required for inspect, cancel, and delete; use the exact returned workflowId."),
  })
  .superRefine((input, context) => {
    const { action, ...payload } = input;
    const schema = {
      cancel: cancelAgentWorkflowInputSchema,
      delete: deleteAgentWorkflowInputSchema,
      inspect: inspectAgentWorkflowInputSchema,
      list: listAgentWorkflowsInputSchema,
      start: startAgentWorkflowInputSchema,
    }[action];

    if (!schema.safeParse(payload).success) {
      context.addIssue({
        code: "custom",
        message: `Fields do not match the ${action} workflow action. Follow the field descriptions for that action.`,
      });
    }
  });

const agentWorkflowReadErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "workflow_not_found",
    "workflow_unavailable",
  ]),
  message: z.literal("Agent workflow request denied."),
});

const agentWorkflowMutationErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_unavailable",
    "admission_limit_exceeded",
    "budget_exhausted",
    "brief_context_too_large",
    "brief_unavailable",
    "capability_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "model_unavailable",
    "owner_mismatch",
    "revision_conflict",
    "workflow_busy",
    "workflow_deleted",
    "workflow_not_found",
    "workflow_unavailable",
  ]),
  message: z.literal("Agent workflow request denied."),
});

export const startAgentWorkflowResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    created: z.boolean(),
    ok: z.literal(true),
    workflow: agentWorkflowSummarySchema,
  }),
  z.strictObject({ error: agentWorkflowMutationErrorSchema, ok: z.literal(false) }),
]);

export const listAgentWorkflowsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    nextCursor: agentWorkflowIdSchema.nullable(),
    ok: z.literal(true),
    workflows: z.array(agentWorkflowSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
  }),
  z.strictObject({ error: agentWorkflowReadErrorSchema, ok: z.literal(false) }),
]);

export const inspectAgentWorkflowResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), workflow: agentWorkflowSchema }),
  z.strictObject({ error: agentWorkflowReadErrorSchema, ok: z.literal(false) }),
]);

export const cancelAgentWorkflowResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    cancelled: z.boolean(),
    ok: z.literal(true),
    workflow: agentWorkflowSummarySchema,
  }),
  z.strictObject({ error: agentWorkflowMutationErrorSchema, ok: z.literal(false) }),
]);

export const deleteAgentWorkflowResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    deleted: z.literal(true),
    ok: z.literal(true),
    workflowId: agentWorkflowIdSchema,
  }),
  z.strictObject({ error: agentWorkflowMutationErrorSchema, ok: z.literal(false) }),
]);

export const manageAgentWorkflowsResultSchema = z.union([
  startAgentWorkflowResultSchema,
  listAgentWorkflowsResultSchema,
  inspectAgentWorkflowResultSchema,
  cancelAgentWorkflowResultSchema,
  deleteAgentWorkflowResultSchema,
]);

export const agentTaskWorkflowParamsSchema = z.strictObject({
  agentId: agentIdSchema,
  ownerKey: ownerKeySchema,
  stageCount: z.number().int().min(2).max(MAXIMUM_AGENT_WORKFLOW_STAGES),
  workflowId: agentWorkflowIdSchema,
});

export const dispatchAgentWorkflowStageInputSchema = z.strictObject({
  agentId: agentIdSchema,
  stageIndex: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGES - 1),
  workflowId: agentWorkflowIdSchema,
});

export const dispatchAgentWorkflowStageResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    runId: runIdSchema,
    session: runSessionSchema,
    status: runStatusSchema,
  }),
  z.strictObject({ error: agentWorkflowMutationErrorSchema, ok: z.literal(false) }),
]);

export const completeAgentWorkflowStageInputSchema = dispatchAgentWorkflowStageInputSchema.extend({
  runId: runIdSchema,
});

export const completeAgentWorkflowStageResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    status: z.enum(["completed", "failed", "cancelled"]),
    workflowStatus: agentWorkflowStatusSchema,
  }),
  z.strictObject({ error: agentWorkflowMutationErrorSchema, ok: z.literal(false) }),
]);

export const agentWorkflowRunEventSchema = z.strictObject({
  runId: runIdSchema,
  stageIndex: z
    .number()
    .int()
    .min(0)
    .max(MAXIMUM_AGENT_WORKFLOW_STAGES - 1),
  status: z.enum(["completed", "failed", "cancelled"]),
  workflowId: agentWorkflowIdSchema,
});

export type AgentTaskWorkflowParams = z.infer<typeof agentTaskWorkflowParamsSchema>;
export type AgentWorkflow = z.infer<typeof agentWorkflowSchema>;
export type AgentWorkflowAggregateBudget = z.infer<typeof agentWorkflowAggregateBudgetSchema>;
export type AgentWorkflowStagePlan = z.infer<typeof agentWorkflowStagePlanSchema>;
export type AgentWorkflowStageSummary = z.infer<typeof agentWorkflowStageSummarySchema>;
export type AgentWorkflowStatus = z.infer<typeof agentWorkflowStatusSchema>;
export type AgentWorkflowSummary = z.infer<typeof agentWorkflowSummarySchema>;
export type CancelAgentWorkflowResult = z.infer<typeof cancelAgentWorkflowResultSchema>;
export type CompleteAgentWorkflowStageResult = z.infer<
  typeof completeAgentWorkflowStageResultSchema
>;
export type DeleteAgentWorkflowResult = z.infer<typeof deleteAgentWorkflowResultSchema>;
export type DispatchAgentWorkflowStageResult = z.infer<
  typeof dispatchAgentWorkflowStageResultSchema
>;
export type InspectAgentWorkflowResult = z.infer<typeof inspectAgentWorkflowResultSchema>;
export type ListAgentWorkflowsResult = z.infer<typeof listAgentWorkflowsResultSchema>;
export type StartAgentWorkflowInput = z.infer<typeof startAgentWorkflowInputSchema>;
export type StartAgentWorkflowResult = z.infer<typeof startAgentWorkflowResultSchema>;
export type WorkflowDeliverable = z.infer<typeof workflowDeliverableSchema>;
