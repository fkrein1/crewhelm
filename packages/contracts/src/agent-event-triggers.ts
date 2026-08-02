import * as z from "zod";

import {
  agentIdSchema,
  agentMutationIdempotencyKeySchema,
  agentRevisionNumberSchema,
} from "./control-plane.js";
import { MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT } from "./agent-schedules.js";
import { outputContractSchema } from "./output-contracts.js";
import type { OutputContract } from "./output-contracts.js";
import { runIdSchema } from "./capabilities.js";
import { runPromptSchema } from "./run-admission.js";
import { connectionIdSchema } from "./connections.js";
import {
  integrationSlugSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSlugSchema,
} from "./integrations.js";

export const MAXIMUM_AGENT_EVENT_TRIGGER_HISTORY_ITEMS = 20;
export const MAXIMUM_RETAINED_AGENT_EVENT_TRIGGER_OCCURRENCES = 100;

export type AgentEventTriggerDefinition = {
  instruction: string;
  name: string;
  outputContract?: OutputContract | undefined;
  source: {
    configuration: z.infer<typeof integrationToolParameterMapSchema>;
    connectionId: string;
    delivery: "provider_polling" | "realtime";
    integrationSlug: string;
    kind: "connection_event";
    sourceSlug: string;
    sourceVersion: string;
  };
};
export type AgentEventTriggerOccurrence = {
  eventId: string;
  occurredAt: string;
  outcome: "pending" | "dispatched" | "skipped";
  reason:
    | "active_run"
    | "agent_changed"
    | "agent_unavailable"
    | "connection_unavailable"
    | "dispatch_exception"
    | "event_too_large"
    | "record_dispatch_conflict"
    | "run_unavailable"
    | "source_mismatch"
    | "event_trigger_deleted"
    | "event_trigger_paused"
    | "event_trigger_queue_full"
    | null;
  runId: string | null;
  eventTriggerRevision: number;
};
export type AgentEventTrigger = {
  agentId: string;
  agentRevision: number;
  createdAt: string;
  definition: AgentEventTriggerDefinition;
  id: string;
  lastOccurrence: AgentEventTriggerOccurrence | null;
  revision: number;
  status: "active" | "paused";
};

export const agentEventTriggerIdSchema = z
  .string()
  .regex(
    /^event_trigger_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Agent Event Trigger ID.",
  )
  .describe("Opaque Event Trigger identity for exact lifecycle operations.");
export const agentEventTriggerRevisionNumberSchema = z.number().int().positive();

export const agentEventTriggerSourceSchema = z.strictObject({
  configuration: integrationToolParameterMapSchema,
  connectionId: connectionIdSchema,
  delivery: z.enum(["provider_polling", "realtime"]),
  integrationSlug: integrationSlugSchema,
  kind: z.literal("connection_event"),
  sourceSlug: integrationToolSlugSchema,
  sourceVersion: integrationToolkitVersionSchema,
});

const agentEventTriggerNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe("Short owner-facing name for this Event Trigger.");

export const agentEventTriggerDefinitionSchema: z.ZodType<AgentEventTriggerDefinition> =
  z.strictObject({
    instruction: runPromptSchema.describe(
      "What the Agent should do for each Event Trigger occurrence and what useful outcome it should return.",
    ),
    name: agentEventTriggerNameSchema,
    outputContract: outputContractSchema
      .describe("Optional deliverable contract frozen for every Event Trigger occurrence.")
      .optional(),
    source: agentEventTriggerSourceSchema,
  });

const eventTriggerFiltersSchema = z
  .record(
    z.string().min(1).max(128),
    z.union([z.boolean(), z.number().finite(), z.string().max(2_048)]),
  )
  .superRefine((filters, context) => {
    if (Object.keys(filters).length > 32) {
      context.addIssue({
        code: "custom",
        message: "An Event Trigger has too many filters.",
      });
    }
  });

const eventTriggerToolDefinitionSchema = z.strictObject({
  connectionId: connectionIdSchema.describe("Connected account returned by sources."),
  delivery: z.enum(["provider_polling", "realtime"]).describe("Delivery returned by sources."),
  eventSlug: integrationToolSlugSchema.describe("Event slug returned by sources."),
  eventVersion: integrationToolkitVersionSchema.describe("Event version returned by sources."),
  filters: eventTriggerFiltersSchema.describe("Event filters described by the source."),
  integrationSlug: integrationSlugSchema.describe("Integration returned by sources."),
  instruction: runPromptSchema.describe("The Agent's responsibility for each matching event."),
  name: agentEventTriggerNameSchema,
  outputContract: outputContractSchema
    .describe("Optional output contract for each event Run.")
    .optional(),
});

export const agentEventTriggerToolDefinitionSchema = eventTriggerToolDefinitionSchema;

export const agentEventTriggerOccurrenceSchema: z.ZodType<AgentEventTriggerOccurrence> =
  z.strictObject({
    eventId: z.string().min(1).max(256),
    occurredAt: z.iso.datetime(),
    outcome: z.enum(["pending", "dispatched", "skipped"]),
    reason: z
      .enum([
        "active_run",
        "agent_changed",
        "agent_unavailable",
        "dispatch_exception",
        "connection_unavailable",
        "record_dispatch_conflict",
        "run_unavailable",
        "event_trigger_deleted",
        "event_trigger_paused",
        "event_trigger_queue_full",
        "source_mismatch",
        "event_too_large",
      ])
      .nullable(),
    runId: runIdSchema.nullable(),
    eventTriggerRevision: agentEventTriggerRevisionNumberSchema,
  });

export const agentEventTriggerSchema: z.ZodType<AgentEventTrigger> = z.strictObject({
  agentId: agentIdSchema,
  agentRevision: agentRevisionNumberSchema,
  createdAt: z.iso.datetime(),
  definition: agentEventTriggerDefinitionSchema,
  id: agentEventTriggerIdSchema,
  lastOccurrence: agentEventTriggerOccurrenceSchema.nullable(),
  revision: agentEventTriggerRevisionNumberSchema,
  status: z.enum(["active", "paused"]),
});

const eventTriggerMutationBase = {
  agentId: agentIdSchema,
  expectedAgentRevision: agentRevisionNumberSchema,
  idempotencyKey: agentMutationIdempotencyKeySchema,
};

export const agentEventTriggersInputSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("sources"), connectionId: connectionIdSchema }),
  z.strictObject({
    action: z.literal("create"),
    ...eventTriggerMutationBase,
    eventTrigger: agentEventTriggerDefinitionSchema,
  }),
  z.strictObject({
    action: z.literal("update"),
    ...eventTriggerMutationBase,
    expectedEventTriggerRevision: agentEventTriggerRevisionNumberSchema,
    eventTrigger: agentEventTriggerDefinitionSchema,
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("pause"),
    ...eventTriggerMutationBase,
    expectedEventTriggerRevision: agentEventTriggerRevisionNumberSchema,
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("resume"),
    ...eventTriggerMutationBase,
    expectedEventTriggerRevision: agentEventTriggerRevisionNumberSchema,
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    ...eventTriggerMutationBase,
    expectedEventTriggerRevision: agentEventTriggerRevisionNumberSchema,
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("inspect"),
    agentId: agentIdSchema,
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("list"),
    agentId: agentIdSchema,
  }),
  z.strictObject({
    action: z.literal("history"),
    agentId: agentIdSchema,
    limit: z.number().int().min(1).max(MAXIMUM_AGENT_EVENT_TRIGGER_HISTORY_ITEMS).default(10),
    eventTriggerId: agentEventTriggerIdSchema,
  }),
]);

export const agentEventTriggersToolInputSchema = z
  .strictObject({
    action: z
      .enum([
        "sources",
        "create",
        "update",
        "pause",
        "resume",
        "delete",
        "inspect",
        "list",
        "history",
      ])
      .describe(
        "Send only fields for the action: sources(connectionId); create(agentId,expectedAgentRevision,idempotencyKey,eventTrigger); update(create fields plus eventTriggerId,expectedEventTriggerRevision); pause|resume|delete(agentId,expectedAgentRevision,expectedEventTriggerRevision,idempotencyKey,eventTriggerId); inspect(agentId,eventTriggerId); list(agentId); history(agentId,eventTriggerId,limit?).",
      ),
    agentId: agentIdSchema.optional(),
    connectionId: connectionIdSchema.optional(),
    expectedAgentRevision: agentRevisionNumberSchema.optional(),
    expectedEventTriggerRevision: agentEventTriggerRevisionNumberSchema.optional(),
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_AGENT_EVENT_TRIGGER_HISTORY_ITEMS).optional(),
    eventTrigger: agentEventTriggerToolDefinitionSchema.optional(),
    eventTriggerId: agentEventTriggerIdSchema.optional(),
  })
  .superRefine((input, context) => {
    const allowed = {
      sources: ["action", "connectionId"],
      create: ["action", "agentId", "expectedAgentRevision", "idempotencyKey", "eventTrigger"],
      update: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedEventTriggerRevision",
        "idempotencyKey",
        "eventTrigger",
        "eventTriggerId",
      ],
      pause: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedEventTriggerRevision",
        "idempotencyKey",
        "eventTriggerId",
      ],
      resume: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedEventTriggerRevision",
        "idempotencyKey",
        "eventTriggerId",
      ],
      delete: [
        "action",
        "agentId",
        "expectedAgentRevision",
        "expectedEventTriggerRevision",
        "idempotencyKey",
        "eventTriggerId",
      ],
      inspect: ["action", "agentId", "eventTriggerId"],
      list: ["action", "agentId"],
      history: ["action", "agentId", "limit", "eventTriggerId"],
    } as const;
    const required = allowed[input.action].filter(
      (field) => field !== "action" && !(input.action === "history" && field === "limit"),
    );

    for (const field of required) {
      if (input[field] === undefined) {
        context.addIssue({
          code: "custom",
          message: `${input.action} requires ${field}.`,
          path: [field],
        });
      }
    }

    for (const field of [
      "agentId",
      "connectionId",
      "expectedAgentRevision",
      "expectedEventTriggerRevision",
      "idempotencyKey",
      "limit",
      "eventTrigger",
      "eventTriggerId",
    ] as const) {
      if (
        input[field] !== undefined &&
        !allowed[input.action].some((allowedField) => allowedField === field)
      ) {
        context.addIssue({
          code: "custom",
          message: `${input.action} does not accept ${field}.`,
          path: [field],
        });
      }
    }
  });

const agentEventTriggerErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "agent_unavailable",
    "connection_not_found",
    "connection_unavailable",
    "idempotency_conflict",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "no_changes",
    "owner_mismatch",
    "revision_conflict",
    "event_trigger_busy",
    "event_trigger_limit_exceeded",
    "event_trigger_not_found",
    "event_trigger_operation_unknown",
    "event_trigger_source_unavailable",
  ]),
  message: z.literal("Agent Event Trigger request denied."),
});

const successfulEventTriggerMutationSchema = z.strictObject({
  action: z.enum(["create", "update", "pause", "resume"]),
  changed: z.boolean(),
  ok: z.literal(true),
  eventTrigger: agentEventTriggerSchema,
});

export type AgentEventTriggersInput = z.infer<typeof agentEventTriggersInputSchema>;
export type AgentEventTriggersResult =
  | {
      action: "sources";
      ok: true;
      sources: Array<{
        configuration: Array<{
          description: string | null;
          id: string;
          label: string;
          options: Array<boolean | number | string>;
          required: boolean;
          type: "boolean" | "number" | "select" | "string";
        }>;
        connectionId: string;
        delivery: "provider_polling" | "realtime";
        description: string | null;
        id: string;
        integration: { name: string; slug: string };
        kind: "connection_event";
        name: string;
        sourceSlug: string;
        sourceVersion: string;
      }>;
    }
  | {
      action: "create" | "pause" | "resume" | "update";
      changed: boolean;
      ok: true;
      eventTrigger: AgentEventTrigger;
    }
  | { action: "delete"; deleted: boolean; ok: true; eventTriggerId: string }
  | { action: "inspect"; ok: true; eventTrigger: AgentEventTrigger }
  | { action: "list"; ok: true; eventTriggers: AgentEventTrigger[] }
  | {
      action: "history";
      occurrences: AgentEventTriggerOccurrence[];
      ok: true;
      eventTriggerId: string;
    }
  | {
      error: {
        code:
          | "agent_not_found"
          | "agent_unavailable"
          | "connection_not_found"
          | "connection_unavailable"
          | "idempotency_conflict"
          | "incompatible_schema"
          | "insufficient_scope"
          | "invalid_authority"
          | "invalid_request"
          | "no_changes"
          | "owner_mismatch"
          | "revision_conflict"
          | "event_trigger_busy"
          | "event_trigger_limit_exceeded"
          | "event_trigger_not_found"
          | "event_trigger_operation_unknown"
          | "event_trigger_source_unavailable";
        message: "Agent Event Trigger request denied.";
      };
      ok: false;
    };

export const agentEventTriggersResultSchema: z.ZodType<AgentEventTriggersResult> = z.union([
  z.strictObject({
    action: z.literal("sources"),
    ok: z.literal(true),
    sources: z
      .array(
        z.strictObject({
          configuration: z
            .array(
              z.strictObject({
                description: z.string().min(1).max(300).nullable(),
                id: z.string().min(1).max(128),
                label: z.string().min(1).max(120),
                options: z.array(z.union([z.boolean(), z.number(), z.string()])).max(50),
                required: z.boolean(),
                type: z.enum(["boolean", "number", "select", "string"]),
              }),
            )
            .max(32),
          connectionId: connectionIdSchema,
          delivery: z.enum(["provider_polling", "realtime"]),
          description: z.string().min(1).max(500).nullable(),
          id: z.string().min(1).max(512),
          integration: z.strictObject({
            name: z.string().min(1).max(160),
            slug: integrationSlugSchema,
          }),
          kind: z.literal("connection_event"),
          name: z.string().min(1).max(160),
          sourceSlug: integrationToolSlugSchema,
          sourceVersion: integrationToolkitVersionSchema,
        }),
      )
      .max(20),
  }),
  successfulEventTriggerMutationSchema,
  z.strictObject({
    action: z.literal("delete"),
    deleted: z.boolean(),
    ok: z.literal(true),
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({
    action: z.literal("inspect"),
    ok: z.literal(true),
    eventTrigger: agentEventTriggerSchema,
  }),
  z.strictObject({
    action: z.literal("list"),
    ok: z.literal(true),
    eventTriggers: z
      .array(agentEventTriggerSchema)
      .max(MAXIMUM_AGENT_SCHEDULES_AND_EVENT_TRIGGERS_PER_AGENT),
  }),
  z.strictObject({
    action: z.literal("history"),
    occurrences: z
      .array(agentEventTriggerOccurrenceSchema)
      .max(MAXIMUM_AGENT_EVENT_TRIGGER_HISTORY_ITEMS),
    ok: z.literal(true),
    eventTriggerId: agentEventTriggerIdSchema,
  }),
  z.strictObject({ error: agentEventTriggerErrorSchema, ok: z.literal(false) }),
]);
