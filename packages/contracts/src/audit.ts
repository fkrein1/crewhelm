import * as z from "zod";

import { MAXIMUM_FLEET_LIST_ITEMS } from "./fleet-capacity.js";

export const auditEventIdSchema = z.number().int().positive().safe();
export const auditActionSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9._-]+$/);
export const auditSubjectIdSchema = z.string().min(1).max(255);

export const auditEventSummarySchema = z.strictObject({
  action: auditActionSchema,
  actor: z.enum(["owner_client", "runtime", "scheduler"]),
  eventId: auditEventIdSchema,
  occurredAt: z.iso.datetime(),
  subjectId: auditSubjectIdSchema,
});

export const listAuditEventsInputSchema = z.strictObject({
  action: auditActionSchema
    .optional()
    .describe("Return events for one exact allowlisted audit action."),
  cursor: auditEventIdSchema.optional(),
  limit: z.number().int().min(1).max(MAXIMUM_FLEET_LIST_ITEMS).default(10),
  occurredAfter: z.iso.datetime().optional(),
  subjectId: auditSubjectIdSchema.optional().describe("Return events for one exact subject."),
});

export const listAuditEventsResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    events: z.array(auditEventSummarySchema).max(MAXIMUM_FLEET_LIST_ITEMS),
    nextCursor: auditEventIdSchema.nullable(),
    ok: z.literal(true),
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.enum([
        "incompatible_schema",
        "insufficient_scope",
        "invalid_authority",
        "invalid_request",
        "owner_mismatch",
      ]),
      message: z.literal("Audit request denied."),
    }),
    ok: z.literal(false),
  }),
]);

export type ListAuditEventsResult = z.infer<typeof listAuditEventsResultSchema>;
