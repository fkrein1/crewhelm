import {
  crewAgentRuntimeConfigSchema,
  ownerClientIdSchema,
  pendingToolApprovalSchema,
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

export type AdmittedRunRecord = z.infer<typeof admittedRunRecordSchema>;
export type AdmittedTurnMetadata = z.infer<typeof admittedTurnMetadataSchema>["crewhelmRun"];
