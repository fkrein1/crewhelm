import {
  crewAgentRuntimeConfigSchema,
  ownerClientIdSchema,
  pendingToolApprovalSchema,
  recordAgentInboxRunInputSchema,
  runAdmissionIdempotencyKeySchema,
  runBudgetReservationSchema,
  runIdSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

const legacyAiSpendReservationSchema = z.number().int().positive().safe();

const persistedRunBudgetReservationSchema = z.preprocess((value) => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "aiSpendReservationMicrousd")
  ) {
    return value;
  }

  const legacyReservation = Reflect.get(value, "aiSpendReservationMicrousd");

  if (!legacyAiSpendReservationSchema.safeParse(legacyReservation).success) {
    return value;
  }

  const normalized = { ...value };
  Reflect.deleteProperty(normalized, "aiSpendReservationMicrousd");
  return normalized;
}, runBudgetReservationSchema);

export const admittedRunRecordSchema = z.strictObject({
  budgetReservation: persistedRunBudgetReservationSchema,
  cleanupAt: z.number().int().positive(),
  clientId: ownerClientIdSchema,
  configuration: crewAgentRuntimeConfigSchema,
  createdAt: z.number().int().positive(),
  deadlineAt: z.number().int().positive(),
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  promptCharacters: z.number().int().positive(),
  promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  scheduleRevision: z.number().int().positive().nullable().default(null),
});

export const admittedTurnMetadataSchema = z.strictObject({
  crewhelmRun: z.strictObject({
    budgetReservation: persistedRunBudgetReservationSchema,
    configuration: crewAgentRuntimeConfigSchema,
    promptCharacters: z.number().int().positive(),
    promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
    runId: runIdSchema,
  }),
});

export const scheduledRunInputSchema = z.strictObject({
  runId: runIdSchema,
});

export const pendingToolApprovalRecordSchema = pendingToolApprovalSchema
  .omit({ executionId: true })
  .extend({ runId: runIdSchema });

export const agentInboxProjectionOutboxSchema = z.strictObject({
  attempts: z.number().int().nonnegative().max(100),
  cleanupAt: z.number().int().positive(),
  projection: recordAgentInboxRunInputSchema,
  retryAt: z.number().int().positive(),
});

export const scheduledInboxProjectionInputSchema = z.strictObject({
  outbox: agentInboxProjectionOutboxSchema,
  wakeupAt: z.number().int().positive(),
});

export type AdmittedRunRecord = z.infer<typeof admittedRunRecordSchema>;
export type AdmittedTurnMetadata = z.infer<typeof admittedTurnMetadataSchema>["crewhelmRun"];
export type AgentInboxProjectionOutbox = z.infer<typeof agentInboxProjectionOutboxSchema>;
