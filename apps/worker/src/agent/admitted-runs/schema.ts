import {
  agentModelSchema,
  admittedBriefContextContentSchema,
  crewAgentRuntimeConfigSchema,
  ownerClientIdSchema,
  pendingToolApprovalSchema,
  recordAgentInboxRunInputSchema,
  admittedOutputContractSchema,
  jsonDeliverableSchema,
  MAXIMUM_RUN_OUTPUT_CHARACTERS,
  runAdmissionIdempotencyKeySchema,
  runBudgetReservationSchema,
  runIdSchema,
  runSessionSchema,
  runTriggerSchema,
  runEventTriggerReferenceSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

const legacyAiSpendReservationSchema = z.number().int().positive().safe();
const LEGACY_WORKERS_AI_CAPABILITY_ID = "inference.workers-ai";
const LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const capabilities: unknown[] = value;
  const normalized = capabilities.map((capability) => {
    if (
      !isRecord(capability) ||
      capability.id !== LEGACY_WORKERS_AI_CAPABILITY_ID ||
      capability.schemaVersion !== 1
    ) {
      return capability;
    }

    const configuration = capability.configuration;

    if (!isRecord(configuration)) {
      return capability;
    }

    const model = agentModelSchema.safeParse(configuration.model);

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
  if (!isRecord(value)) {
    return value;
  }

  const inference = value.inference;
  const modules = value.modules;

  if (
    !isRecord(inference) ||
    inference.moduleId !== LEGACY_WORKERS_AI_CAPABILITY_ID ||
    inference.schemaVersion !== 1 ||
    !Array.isArray(modules)
  ) {
    return value;
  }

  const model = agentModelSchema.safeParse(inference.model);

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
    modules: (modules as unknown[]).map((module) =>
      isRecord(module) &&
      module.id === LEGACY_WORKERS_AI_CAPABILITY_ID &&
      module.schemaVersion === 1
        ? { ...module, schemaVersion: LEGACY_WORKERS_AI_CAPABILITY_SCHEMA_VERSION }
        : module,
    ),
  };
}

const persistedRunBudgetReservationSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  const normalized = { ...value };
  let changed = false;
  const legacyAiReservation = value.aiSpendReservationMicrousd;

  if (legacyAiSpendReservationSchema.safeParse(legacyAiReservation).success) {
    Reflect.deleteProperty(normalized, "aiSpendReservationMicrousd");
    changed = true;
  }

  const legacyModel = agentModelSchema.safeParse(value.model);

  if (legacyModel.success) {
    if (!Object.hasOwn(value, "runtimePlan")) {
      Reflect.set(normalized, "runtimePlan", legacyWorkersAiRuntimePlan(legacyModel.data));
    }
    Reflect.deleteProperty(normalized, "model");
    changed = true;
  }

  const runtimePlan = normalizeWorkersAiRuntimePlan(value.runtimePlan);

  if (runtimePlan !== value.runtimePlan) {
    Reflect.set(normalized, "runtimePlan", runtimePlan);
    changed = true;
  }

  return changed ? normalized : value;
}, runBudgetReservationSchema);

const persistedCrewAgentRuntimeConfigSchema = z.preprocess((value) => {
  if (!isRecord(value)) {
    return value;
  }

  const normalized = { ...value };
  let changed = false;
  const legacyModel = agentModelSchema.safeParse(value.model);

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

  const capabilities = normalizeWorkersAiCapabilities(value.capabilities);

  if (capabilities !== value.capabilities) {
    Reflect.set(normalized, "capabilities", capabilities);
    changed = true;
  }

  const runtimePlan = normalizeWorkersAiRuntimePlan(value.runtimePlan);

  if (runtimePlan !== value.runtimePlan) {
    Reflect.set(normalized, "runtimePlan", runtimePlan);
    changed = true;
  }

  return changed ? normalized : value;
}, crewAgentRuntimeConfigSchema);

export const admittedRunRecordSchema = z.strictObject({
  budgetReservation: persistedRunBudgetReservationSchema,
  briefContext: admittedBriefContextContentSchema.optional(),
  cleanupAt: z.number().int().positive(),
  clientId: ownerClientIdSchema,
  configuration: persistedCrewAgentRuntimeConfigSchema,
  createdAt: z.number().int().positive(),
  deadlineAt: z.number().int().positive(),
  idempotencyKey: runAdmissionIdempotencyKeySchema,
  outputContract: admittedOutputContractSchema.optional(),
  promptCharacters: z.number().int().positive(),
  promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  scheduleRevision: z.number().int().positive().nullable().default(null),
  trigger: runTriggerSchema.default("manual"),
  eventTrigger: runEventTriggerReferenceSchema.optional(),
  session: runSessionSchema.optional(),
  sessionContext: z
    .strictObject({
      characters: z.number().int().nonnegative().safe(),
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      messages: z.array(
        z.strictObject({
          content: z.string(),
          role: z.enum(["assistant", "user"]),
        }),
      ),
      truncated: z.boolean(),
    })
    .optional(),
});

export const admittedTurnMetadataSchema = z.strictObject({
  crewhelmRun: z.strictObject({
    budgetReservation: persistedRunBudgetReservationSchema,
    briefContext: admittedBriefContextContentSchema.optional(),
    configuration: persistedCrewAgentRuntimeConfigSchema,
    deadlineAt: z.number().int().positive().default(1),
    promptCharacters: z.number().int().positive(),
    promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
    outputContract: admittedOutputContractSchema.optional(),
    runId: runIdSchema,
    session: runSessionSchema.optional(),
    sessionContext: admittedRunRecordSchema.shape.sessionContext,
    trigger: runTriggerSchema.default("manual"),
  }),
});

export const scheduledRunInputSchema = z.strictObject({
  runId: runIdSchema,
});

export const sessionTerminalStatusSchema = z.enum(["cancelled", "completed", "failed"]);
export type SessionTerminalStatus = z.infer<typeof sessionTerminalStatusSchema>;

export const validatedRunOutputRecordSchema = z.discriminatedUnion("state", [
  z.strictObject({
    canonical: z.string().max(MAXIMUM_RUN_OUTPUT_CHARACTERS),
    deliverable: jsonDeliverableSchema.options[0],
    messageId: z.string().min(1).max(256),
    validation: z.enum(["initial", "repair"]),
    state: z.literal("valid"),
  }),
  z.strictObject({
    deliverable: jsonDeliverableSchema.options[1],
    messageId: z.string().min(1).max(256),
    state: z.literal("invalid"),
  }),
  z.strictObject({
    claimedAt: z.number().int().positive(),
    deliverable: jsonDeliverableSchema.options[1],
    messageId: z.string().min(1).max(256),
    state: z.literal("repairing"),
  }),
]);

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
