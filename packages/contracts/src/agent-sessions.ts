import * as z from "zod";

import { agentIdSchema, agentMutationIdempotencyKeySchema } from "./control-plane.js";
import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";

export const MAXIMUM_AGENT_SESSIONS = 1_000;
export const MAXIMUM_SESSION_CONTEXT_CHARACTERS = 16 * 1_024;
export const MAXIMUM_SESSION_INSPECTION_MESSAGES = 20;
export const MAXIMUM_SESSION_INSPECTION_TEXT_CHARACTERS = 2 * 1_024;
export const DEFAULT_AGENT_SESSION_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export const sessionIdSchema = z
  .string()
  .regex(
    /^session_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm session ID.",
  );
export const branchIdSchema = z
  .string()
  .regex(
    /^branch_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "Expected an opaque Crewhelm branch ID.",
  );
export const branchRevisionSchema = z.number().int().positive().safe();

export const sessionContinuationSchema = z.strictObject({
  branchId: branchIdSchema,
  expectedBranchRevision: branchRevisionSchema.describe(
    "Exact conversation revision previously returned by Crewhelm.",
  ),
  sessionId: sessionIdSchema,
});

export const runSessionSchema = z.strictObject({
  branchId: branchIdSchema,
  branchRevision: branchRevisionSchema,
  sessionId: sessionIdSchema,
});

export function continuationFromRunSession(
  session: RunSession | undefined,
): SessionContinuation | undefined {
  return session === undefined
    ? undefined
    : sessionContinuationSchema.parse({
        branchId: session.branchId,
        expectedBranchRevision: session.branchRevision,
        sessionId: session.sessionId,
      });
}

export const sessionMessageSchema = z.strictObject({
  createdAt: z.iso.datetime().nullable(),
  messageId: z.string().min(1).max(256),
  role: z.enum(["assistant", "user"]),
  text: z.string().max(MAXIMUM_SESSION_INSPECTION_TEXT_CHARACTERS),
  truncated: z.boolean(),
});

export const sessionSummarySchema = z.strictObject({
  agentId: agentIdSchema,
  availableUntil: z.iso.datetime(),
  branchId: branchIdSchema,
  branchRevision: branchRevisionSchema,
  createdAt: z.iso.datetime(),
  sessionId: sessionIdSchema,
  status: z.enum(["active", "idle"]),
  updatedAt: z.iso.datetime(),
});

export function crewSessionObjectName(input: {
  agentId: string;
  ownerKey: string;
  sessionId: string;
}): string {
  return `crew-session:${input.ownerKey}:${input.agentId}:${input.sessionId}`;
}

export const listAgentSessionsInputSchema = z.strictObject({
  agentId: agentIdSchema,
  cursor: sessionIdSchema.optional(),
  limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(10),
});

export const inspectAgentSessionInputSchema = z.strictObject({
  agentId: agentIdSchema,
  sessionId: sessionIdSchema,
});

export const deleteAgentSessionInputSchema = z.strictObject({
  agentId: agentIdSchema,
  expectedBranchRevision: branchRevisionSchema,
  idempotencyKey: agentMutationIdempotencyKeySchema,
  sessionId: sessionIdSchema,
});

export const manageAgentSessionsInputSchema = z
  .strictObject({
    action: z.enum(["delete", "inspect", "list"]),
    agentId: agentIdSchema,
    cursor: sessionIdSchema.optional(),
    expectedBranchRevision: branchRevisionSchema.optional(),
    idempotencyKey: agentMutationIdempotencyKeySchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).optional(),
    sessionId: sessionIdSchema.optional(),
  })
  .superRefine((input, context) => {
    const exactSession = input.action === "delete" || input.action === "inspect";

    if (exactSession !== (input.sessionId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Inspect and delete require one exact sessionId.",
        path: ["sessionId"],
      });
    }

    const hasAnyDeletionField =
      input.expectedBranchRevision !== undefined || input.idempotencyKey !== undefined;
    const hasCompleteDeletionFields =
      input.expectedBranchRevision !== undefined && input.idempotencyKey !== undefined;

    if (
      (input.action === "delete" && !hasCompleteDeletionFields) ||
      (input.action !== "delete" && hasAnyDeletionField)
    ) {
      context.addIssue({
        code: "custom",
        message: "Delete requires an exact revision and idempotency key.",
        path: ["expectedBranchRevision"],
      });
    }

    if (input.action !== "list" && (input.cursor !== undefined || input.limit !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Pagination is only available for list requests.",
        path: ["cursor"],
      });
    }
  });

export const browseAgentSessionsInputSchema = z
  .strictObject({
    action: z.enum(["inspect", "list"]),
    agentId: agentIdSchema,
    cursor: sessionIdSchema.optional(),
    limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).optional(),
    sessionId: sessionIdSchema.optional(),
  })
  .superRefine((input, context) => {
    if ((input.action === "inspect") !== (input.sessionId !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Inspect requires one exact sessionId.",
        path: ["sessionId"],
      });
    }

    if (input.action !== "list" && (input.cursor !== undefined || input.limit !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Pagination is only available for list requests.",
        path: ["cursor"],
      });
    }
  });

const sessionReadErrorSchema = z.strictObject({
  code: z.enum([
    "agent_not_found",
    "incompatible_schema",
    "insufficient_scope",
    "invalid_authority",
    "invalid_request",
    "owner_mismatch",
    "session_not_found",
    "session_unavailable",
  ]),
  message: z.literal("Session request denied."),
});

export const listAgentSessionsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    nextCursor: sessionIdSchema.nullable(),
    ok: z.literal(true),
    sessions: z.array(sessionSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
  }),
  z.strictObject({ error: sessionReadErrorSchema, ok: z.literal(false) }),
]);

export const inspectAgentSessionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    continuation: sessionContinuationSchema.describe(
      "Pass this object unchanged to crewhelm_start_run.continuation when the session is idle.",
    ),
    messages: z.array(sessionMessageSchema).max(MAXIMUM_SESSION_INSPECTION_MESSAGES),
    messagesTruncated: z.boolean(),
    ok: z.literal(true),
    session: sessionSummarySchema,
  }),
  z.strictObject({ error: sessionReadErrorSchema, ok: z.literal(false) }),
]);

export const deleteAgentSessionResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    deleted: z.literal(true),
    ok: z.literal(true),
    sessionId: sessionIdSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "agent_not_found",
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
        "revision_conflict",
        "session_busy",
        "session_not_found",
        "session_unavailable",
      ]),
      message: z.literal("Session deletion denied."),
    }),
    ok: z.literal(false),
  }),
]);

export const manageAgentSessionsResultSchema = z.union([
  listAgentSessionsResultSchema,
  inspectAgentSessionResultSchema,
  deleteAgentSessionResultSchema,
]);

export const browseAgentSessionsResultSchema = z.union([
  listAgentSessionsResultSchema,
  inspectAgentSessionResultSchema,
]);

export type DeleteAgentSessionResult = z.infer<typeof deleteAgentSessionResultSchema>;
export type DeleteAgentSessionInput = z.infer<typeof deleteAgentSessionInputSchema>;
export type InspectAgentSessionInput = z.infer<typeof inspectAgentSessionInputSchema>;
export type InspectAgentSessionResult = z.infer<typeof inspectAgentSessionResultSchema>;
export type ListAgentSessionsInput = z.infer<typeof listAgentSessionsInputSchema>;
export type ListAgentSessionsResult = z.infer<typeof listAgentSessionsResultSchema>;
export type RunSession = z.infer<typeof runSessionSchema>;
export type SessionContinuation = z.infer<typeof sessionContinuationSchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
