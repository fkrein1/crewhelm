import * as z from "zod";

import { runIdSchema, sha256DigestSchema } from "./capabilities.js";
import { agentIdSchema, agentRevisionNumberSchema, ownerKeySchema } from "./control-plane.js";
import { fleetConfigurationRevisionNumberSchema } from "./fleet-configuration.js";
import { runAdmissionIdempotencyKeySchema } from "./run-admission.js";
import { agentScheduleRevisionNumberSchema } from "./schedule-revision.js";
import { agentInboxDeferredReasonSchema } from "./diagnostics.js";

export const MAXIMUM_AGENT_INBOX_ITEMS = 25;
export const MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS = 240;
export const AGENT_INBOX_POLL_AFTER_SECONDS = 30;

export const agentInboxItemIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^inbox_(?:run_[0-9a-f-]{36}|deferred_[0-9a-f-]{36})$/,
    "Expected an opaque Agent inbox item ID.",
  );

export const agentInboxItemVersionSchema = z.iso.datetime();
export const agentInboxItemKindSchema = z.enum([
  "action_required",
  "deferred",
  "exception",
  "outcome",
]);
export const agentInboxSeveritySchema = z.enum(["attention_required", "info", "warning"]);
export const agentInboxNextActionSchema = z.enum([
  "decide_approval",
  "inspect_run",
  "review_configuration",
  "review_output",
  "wait_until_retry",
]);

const agentInboxConfigurationSchema = z.strictObject({
  agentRevision: agentRevisionNumberSchema,
  fleetRevision: fleetConfigurationRevisionNumberSchema,
  scheduleRevision: z.number().int().positive().safe().nullable(),
});

const agentInboxPreviewSchema = z.string().min(1).max(MAXIMUM_AGENT_INBOX_PREVIEW_CHARACTERS);

export const agentInboxItemSchema = z.strictObject({
  acknowledgedAt: z.iso.datetime().nullable(),
  agentId: agentIdSchema,
  agentName: z.string().min(1).max(120),
  approvalCount: z.number().int().min(0).max(100),
  configuration: agentInboxConfigurationSchema,
  itemId: agentInboxItemIdSchema,
  kind: agentInboxItemKindSchema,
  needsAction: z.boolean(),
  nextAction: agentInboxNextActionSchema,
  occurredAt: z.iso.datetime(),
  policy: z
    .strictObject({
      layer: z.enum(["agent", "fleet", "integration", "runtime", "schedule"]),
      reason: agentInboxDeferredReasonSchema,
      retryAt: z.iso.datetime().nullable(),
    })
    .nullable(),
  requestPreview: agentInboxPreviewSchema,
  resultPreview: agentInboxPreviewSchema.nullable(),
  runId: runIdSchema.nullable(),
  runStatus: z.enum(["cancelled", "completed", "failed", "running"]).nullable(),
  severity: agentInboxSeveritySchema,
  summary: agentInboxPreviewSchema,
  version: agentInboxItemVersionSchema,
});

const agentInboxFilterFields = {
  agentId: agentIdSchema.optional().describe("Return items for one exact Agent."),
  includeAcknowledged: z
    .boolean()
    .optional()
    .describe("Include acknowledged items; defaults to false."),
  kinds: z
    .array(agentInboxItemKindSchema)
    .min(1)
    .max(agentInboxItemKindSchema.options.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, "Expected unique inbox kinds.")
    .optional()
    .describe("Return only these inbox kinds."),
  needsAction: z
    .boolean()
    .optional()
    .describe("Return only items that do or do not require an owner action."),
  occurredAfter: z.iso.datetime().optional().describe("Return items occurring after this time."),
  severities: z
    .array(agentInboxSeveritySchema)
    .min(1)
    .max(agentInboxSeveritySchema.options.length)
    .refine(
      (severities) => new Set(severities).size === severities.length,
      "Expected unique inbox severities.",
    )
    .optional()
    .describe("Return only these deterministic severity classes."),
};

export const agentInboxInputSchema = z.strictObject({
  action: z
    .enum(["acknowledge", "list", "overview"])
    .describe("Summarize or list the inbox, or acknowledge one exact non-approval item version."),
  ...agentInboxFilterFields,
  cursor: agentInboxItemIdSchema
    .optional()
    .describe("Continue a list request after this opaque inbox item."),
  itemId: agentInboxItemIdSchema
    .optional()
    .describe("Exact item to acknowledge; omitted for overview and list."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAXIMUM_AGENT_INBOX_ITEMS)
    .optional()
    .describe("Maximum compact items to return; defaults to 10."),
  version: agentInboxItemVersionSchema
    .optional()
    .describe("Exact item version to acknowledge; omitted for overview and list."),
});

const agentInboxErrorSchema = z.strictObject({
  code: z.enum([
    "incompatible_schema",
    "inbox_item_changed",
    "inbox_item_not_acknowledgeable",
    "inbox_item_not_found",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
  ]),
  message: z.literal("Agent inbox request denied."),
});

export const agentInboxResultSchema = z.union([
  z.strictObject({
    action: z.literal("overview"),
    counts: z.strictObject({
      actionRequired: z.number().int().nonnegative().safe(),
      attention: z.strictObject({
        needsAction: z.number().int().nonnegative().safe(),
        oldestNeedsActionAt: z.iso.datetime().nullable(),
        warnings: z.number().int().nonnegative().safe(),
      }),
      deferred: z.number().int().nonnegative().safe(),
      exceptions: z.number().int().nonnegative().safe(),
      outcomes: z.number().int().nonnegative().safe(),
      total: z.number().int().nonnegative().safe(),
    }),
    generatedAt: z.iso.datetime(),
    ok: z.literal(true),
    pollAfterSeconds: z.literal(AGENT_INBOX_POLL_AFTER_SECONDS),
  }),
  z.strictObject({
    action: z.literal("list"),
    generatedAt: z.iso.datetime(),
    items: z.array(agentInboxItemSchema).max(MAXIMUM_AGENT_INBOX_ITEMS),
    nextCursor: agentInboxItemIdSchema.nullable(),
    ok: z.literal(true),
    pollAfterSeconds: z.literal(AGENT_INBOX_POLL_AFTER_SECONDS),
  }),
  z.strictObject({
    acknowledged: z.literal(true),
    action: z.literal("acknowledge"),
    itemId: agentInboxItemIdSchema,
    ok: z.literal(true),
    version: agentInboxItemVersionSchema,
  }),
  z.strictObject({
    error: agentInboxErrorSchema,
    ok: z.literal(false),
  }),
]);

export const recordAgentInboxRunInputSchema = z
  .strictObject({
    event: z.strictObject({
      approvalCount: z.number().int().min(0).max(100),
      kind: z.enum(["action_required", "exception", "outcome"]),
      occurredAt: z.iso.datetime(),
      resultPreview: agentInboxPreviewSchema.nullable(),
      runStatus: z.enum(["cancelled", "completed", "failed", "running"]),
    }),
    reference: z.strictObject({
      agentId: agentIdSchema,
      agentRevision: agentRevisionNumberSchema,
      idempotencyKey: runAdmissionIdempotencyKeySchema,
      ownerKey: ownerKeySchema,
      promptDigest: sha256DigestSchema,
      runId: runIdSchema,
      scheduleRevision: agentScheduleRevisionNumberSchema.nullable().default(null),
    }),
  })
  .superRefine((input, context) => {
    const { approvalCount, kind, resultPreview, runStatus } = input.event;

    if (kind === "action_required") {
      if (approvalCount === 0 || resultPreview !== null || runStatus !== "running") {
        context.addIssue({
          code: "custom",
          message: "Approval projections require a running run and at least one approval.",
          path: ["event"],
        });
      }
      return;
    }

    if (approvalCount !== 0 || runStatus === "running") {
      context.addIssue({
        code: "custom",
        message: "Terminal projections cannot contain pending approvals or a running status.",
        path: ["event"],
      });
    }

    if (
      (kind === "exception" && runStatus !== "failed") ||
      (kind === "outcome" && !["cancelled", "completed"].includes(runStatus))
    ) {
      context.addIssue({
        code: "custom",
        message: "Projection kind and run status do not match.",
        path: ["event"],
      });
    }
  });

export const recordAgentInboxRunResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    recorded: z.boolean(),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.literal("invalid_admission"),
      message: z.literal("Agent inbox projection denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type AgentInboxDeferredReason = z.infer<typeof agentInboxDeferredReasonSchema>;
export type AgentInboxInput = z.infer<typeof agentInboxInputSchema>;
export type AgentInboxItem = z.infer<typeof agentInboxItemSchema>;
export type AgentInboxResult = z.infer<typeof agentInboxResultSchema>;
export type AgentInboxSeverity = z.infer<typeof agentInboxSeveritySchema>;
export type RecordAgentInboxRunInput = z.infer<typeof recordAgentInboxRunInputSchema>;
export type RecordAgentInboxRunResult = z.infer<typeof recordAgentInboxRunResultSchema>;
