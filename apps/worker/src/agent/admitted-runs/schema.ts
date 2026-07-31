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
const LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION = 2;

function legacyWorkersAiCapabilities(model: string) {
  return [
    {
      configuration: { fallbackModels: [], primaryModel: model },
      id: LEGACY_WORKERS_AI_CAPABILITY_ID,
      schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    },
  ];
}

function normalizeWorkersAiCapabilities(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  let changed = false;
  const normalized = value.map((capability) => {
    if (
      typeof capability !== "object" ||
      capability === null ||
      Array.isArray(capability) ||
      Reflect.get(capability, "id") !== LEGACY_WORKERS_AI_CAPABILITY_ID ||
      Reflect.get(capability, "schemaVersion") !== 1
    ) {
      return capability;
    }

    const configuration = Reflect.get(capability, "configuration");

    if (
      typeof configuration !== "object" ||
      configuration === null ||
      Array.isArray(configuration)
    ) {
      return capability;
    }

    const model = agentModelSchema.safeParse(Reflect.get(configuration, "model"));

    if (!model.success) {
      return capability;
    }

    changed = true;
    return legacyWorkersAiCapabilities(model.data)[0];
  });

  return changed ? normalized : value;
}

function legacyWorkersAiRuntimePlan(model: string) {
  return {
    inference: {
      fallbackModels: [],
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

function normalizeWorkersAiRuntimePlan(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const inference = Reflect.get(value, "inference");
  const modules = Reflect.get(value, "modules");

  if (
    typeof inference !== "object" ||
    inference === null ||
    Array.isArray(inference) ||
    Reflect.get(inference, "moduleId") !== LEGACY_WORKERS_AI_CAPABILITY_ID ||
    Reflect.get(inference, "schemaVersion") !== 1 ||
    !Array.isArray(modules)
  ) {
    return value;
  }

  const model = agentModelSchema.safeParse(Reflect.get(inference, "model"));

  if (!model.success) {
    return value;
  }

  return {
    ...value,
    inference: {
      ...inference,
      fallbackModels: [],
      schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION,
    },
    modules: modules.map((module) =>
      typeof module === "object" &&
      module !== null &&
      !Array.isArray(module) &&
      Reflect.get(module, "id") === LEGACY_WORKERS_AI_CAPABILITY_ID &&
      Reflect.get(module, "schemaVersion") === 1
        ? { ...module, schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION }
        : module,
    ),
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

  const runtimePlan = normalizeWorkersAiRuntimePlan(Reflect.get(value, "runtimePlan"));

  if (runtimePlan !== Reflect.get(value, "runtimePlan")) {
    Reflect.set(normalized, "runtimePlan", runtimePlan);
    changed = true;
  }

  return changed ? normalized : value;
}, runBudgetReservationSchema);

const persistedCrewAgentRuntimeConfigSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const normalized = { ...value };
  let changed = false;
  const legacyModel = agentModelSchema.safeParse(Reflect.get(value, "model"));

  if (legacyModel.success) {
    if (!Object.hasOwn(value, "capabilities")) {
      Reflect.set(normalized, "capabilities", legacyWorkersAiCapabilities(legacyModel.data));
    }
    if (!Object.hasOwn(value, "runtimePlan")) {
      Reflect.set(normalized, "runtimePlan", legacyWorkersAiRuntimePlan(legacyModel.data));
    }
    Reflect.deleteProperty(normalized, "model");
    changed = true;
  }

  const capabilities = normalizeWorkersAiCapabilities(Reflect.get(value, "capabilities"));

  if (capabilities !== Reflect.get(value, "capabilities")) {
    Reflect.set(normalized, "capabilities", capabilities);
    changed = true;
  }

  const runtimePlan = normalizeWorkersAiRuntimePlan(Reflect.get(value, "runtimePlan"));

  if (runtimePlan !== Reflect.get(value, "runtimePlan")) {
    Reflect.set(normalized, "runtimePlan", runtimePlan);
    changed = true;
  }

  return changed ? normalized : value;
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
