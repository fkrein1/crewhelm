import {
  agentModelSchema,
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
const LEGACY_WORKERS_AI_CAPABILITY_ID = "inference.workers-ai";
const LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION = 1;

function legacyWorkersAiCapabilities(model: string) {
  return [
    {
      configuration: { model },
      id: LEGACY_WORKERS_AI_CAPABILITY_ID,
      schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    },
  ];
}

function legacyWorkersAiRuntimePlan(model: string) {
  return {
    inference: {
      model,
      moduleId: LEGACY_WORKERS_AI_CAPABILITY_ID,
      schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    },
    modules: [
      {
        id: LEGACY_WORKERS_AI_CAPABILITY_ID,
        schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
      },
    ],
    systemContext: [],
  };
}

const persistedRunBudgetReservationSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const normalized = { ...value };
  let changed = false;
  const legacyAiReservation = Reflect.get(value, "aiSpendReservationMicrousd");

  if (legacyAiSpendReservationSchema.safeParse(legacyAiReservation).success) {
    Reflect.deleteProperty(normalized, "aiSpendReservationMicrousd");
    changed = true;
  }

  const legacyModel = agentModelSchema.safeParse(Reflect.get(value, "model"));

  if (legacyModel.success) {
    if (!Object.hasOwn(value, "runtimePlan")) {
      Reflect.set(normalized, "runtimePlan", legacyWorkersAiRuntimePlan(legacyModel.data));
    }
    Reflect.deleteProperty(normalized, "model");
    changed = true;
  }

  return changed ? normalized : value;
}, runBudgetReservationSchema);

const persistedCrewAgentRuntimeConfigSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const legacyModel = agentModelSchema.safeParse(Reflect.get(value, "model"));

  if (!legacyModel.success) {
    return value;
  }

  const normalized = { ...value };

  if (!Object.hasOwn(value, "capabilities")) {
    Reflect.set(normalized, "capabilities", legacyWorkersAiCapabilities(legacyModel.data));
  }
  if (!Object.hasOwn(value, "runtimePlan")) {
    Reflect.set(normalized, "runtimePlan", legacyWorkersAiRuntimePlan(legacyModel.data));
  }
  Reflect.deleteProperty(normalized, "model");
  return normalized;
}, crewAgentRuntimeConfigSchema);

export const admittedRunRecordSchema = z.strictObject({
  budgetReservation: persistedRunBudgetReservationSchema,
  cleanupAt: z.number().int().positive(),
  clientId: ownerClientIdSchema,
  configuration: persistedCrewAgentRuntimeConfigSchema,
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
    configuration: persistedCrewAgentRuntimeConfigSchema,
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
