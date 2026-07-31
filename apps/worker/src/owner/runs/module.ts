import {
  DEFAULT_FLEET_RUN_RETENTION_SECONDS,
  MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
  MAXIMUM_RUN_INPUT_CHARACTERS,
  MAXIMUM_SESSION_CONTEXT_CHARACTERS,
  MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS,
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  composioToolCapabilityGrantSchema,
  RUN_ADMISSION_LIFETIME_MS,
  confirmRunAdmissionResultSchema,
  createRunAdmissionInputSchema,
  createRunAdmissionResultSchema,
  crewAgentRuntimeConfigSchema,
  crewAgentSystemPrompt,
  redeemRunReceiverCapabilityResultSchema,
  runBudgetReservationSchema,
  agentRuntimePlanSchema,
  runAdmissionNonceSchema,
  runAdmissionPermitSchema,
  runReceiverCapabilitySchema,
  runSummarySchema,
  verifyActiveRunAdmissionInputSchema,
  verifyActiveRunAdmissionResultSchema,
  verifyRunAdmissionResultSchema,
  type ConfirmRunAdmissionResult,
  type CreateRunAdmissionResult,
  type CrewAgentRuntimeConfig,
  type FleetConfiguration,
  type ListAgentRunsInput,
  type OwnerAuthority,
  type RunAdmissionPermit,
  type RedeemRunReceiverCapabilityResult,
  type RunBudgetReservation,
  type RunSummary,
  type ComposioToolCapabilityGrant,
  type VerifyActiveRunAdmissionResult,
  type VerifyRunAdmissionResult,
} from "@crewhelm/contracts";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { AI_GATEWAY_CAPABILITY_ID } from "../../agent-capabilities/ai-gateway.js";
import { agentCapabilityRegistry } from "../../agent-capabilities/registry.js";
import { WORKERS_AI_CAPABILITY_ID } from "../../agent-capabilities/workers-ai.js";
import { recordExecutionEvent } from "../../observability/execution.js";
import type { Skills } from "../skills/index.js";
import {
  agentRevisions,
  agents,
  agentInboxItems,
  auditEvents,
  capabilityGrants as storedCapabilityGrants,
  connections,
  runAdmissions,
  toolApprovals,
  toolExecutions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

const RUN_ADMISSION_ERROR = {
  error: {
    code: "invalid_admission",
    message: "Run admission denied.",
  },
  ok: false,
} as const;

type RunAdmissionRequestErrorCode = Extract<
  CreateRunAdmissionResult,
  { ok: false }
>["error"]["code"];
type ControlPlaneDatabase = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type ControlPlaneTransaction = Parameters<Parameters<ControlPlaneDatabase["transaction"]>[0]>[0];
type RunAdmissionDatabase = ControlPlaneDatabase | ControlPlaneTransaction;
type StoredRunAdmission = typeof runAdmissions.$inferSelect;

function projectedRunStatus(currentTime: number) {
  return sql<RunSummary["status"]>`CASE
    WHEN ${runAdmissions.cancelledAt} IS NOT NULL THEN 'cancelled'
    WHEN ${runAdmissions.cancellationRequestedAt} IS NOT NULL THEN 'cancelling'
    WHEN ${runAdmissions.status} = 'issued' THEN 'queued'
    WHEN ${runAdmissions.status} = 'expired' THEN 'failed'
    WHEN ${agentInboxItems.runStatus} IS NOT NULL THEN ${agentInboxItems.runStatus}
    WHEN ${runAdmissions.redeemedAt} IS NOT NULL
      AND ${runAdmissions.redeemedAt}
        + json_extract(${runAdmissions.budgetReservation}, '$.maxDurationSeconds') * 1000
        <= ${currentTime}
      THEN 'failed'
    ELSE 'running'
  END`;
}

function projectedRunCompletedAt(currentTime: number) {
  return sql<number | null>`CASE
    WHEN ${runAdmissions.cancelledAt} IS NOT NULL THEN ${runAdmissions.cancelledAt}
    WHEN ${agentInboxItems.runStatus} IN ('cancelled', 'completed', 'failed')
      THEN ${agentInboxItems.occurredAt}
    WHEN ${runAdmissions.redeemedAt} IS NOT NULL
      AND ${runAdmissions.redeemedAt}
        + json_extract(${runAdmissions.budgetReservation}, '$.maxDurationSeconds') * 1000
        <= ${currentTime}
      THEN ${runAdmissions.redeemedAt}
        + json_extract(${runAdmissions.budgetReservation}, '$.maxDurationSeconds') * 1000
    ELSE NULL
  END`;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function digestBase64Url(value: string): Promise<string> {
  return encodeBase64Url(await digestBytes(new TextEncoder().encode(value)));
}

function createNonce(): string {
  return runAdmissionNonceSchema.parse(encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))));
}

function sameBudgetReservation(left: unknown, right: unknown): boolean {
  const leftReservation = runBudgetReservationSchema.safeParse(left);
  const rightReservation = runBudgetReservationSchema.safeParse(right);

  return (
    leftReservation.success &&
    rightReservation.success &&
    JSON.stringify(leftReservation.data) === JSON.stringify(rightReservation.data)
  );
}

function sameRuntimePlan(left: unknown, right: unknown): boolean {
  const leftPlan = agentRuntimePlanSchema.safeParse(left);
  const rightPlan = agentRuntimePlanSchema.safeParse(right);

  return (
    leftPlan.success &&
    rightPlan.success &&
    JSON.stringify(leftPlan.data) === JSON.stringify(rightPlan.data)
  );
}

function createBudgetReservation(input: {
  configuration: FleetConfiguration;
  executionLimits: CrewAgentRuntimeConfig["executionLimits"];
  promptCharacters: number;
  runtimePlan: CrewAgentRuntimeConfig["runtimePlan"];
  systemPromptCharacters: number;
  toolGrants: ComposioToolCapabilityGrant[];
}): RunBudgetReservation {
  const effectiveExecutionLimits = {
    maxDurationSeconds: Math.min(
      input.executionLimits.maxDurationSeconds,
      input.configuration.data.execution.maxDurationSeconds,
    ),
    maxModelTokens: Math.min(
      input.executionLimits.maxModelTokens,
      input.configuration.data.execution.maxModelTokens,
    ),
    maxToolCalls: Math.min(
      input.executionLimits.maxToolCalls,
      input.configuration.data.execution.maxToolCalls,
      input.configuration.data.integrations.maxCallsPerRun,
    ),
    maxTurns: Math.min(input.executionLimits.maxTurns, input.configuration.data.execution.maxTurns),
  };
  const grantedToolCalls = input.toolGrants.reduce(
    (total, grant) =>
      total +
      Math.min(
        grant.limits.maxCallsPerRun,
        input.configuration.data.integrations.maxCallsPerToolPerRun,
      ),
    0,
  );
  const maxToolCalls = Math.min(effectiveExecutionLimits.maxToolCalls, grantedToolCalls);
  const maxTurns = Math.min(effectiveExecutionLimits.maxTurns, maxToolCalls + 1);
  const baseModelCalls = Math.min(effectiveExecutionLimits.maxTurns, maxTurns + maxToolCalls);
  const maxModelCalls = Math.min(
    100,
    baseModelCalls * (1 + input.runtimePlan.inference.fallbackModels.length),
  );

  return runBudgetReservationSchema.parse({
    fleetConfigurationRevision: input.configuration.revision,
    integrationLimits: input.configuration.data.integrations,
    maxDurationSeconds: effectiveExecutionLimits.maxDurationSeconds,
    maxInputCharacters: Math.min(
      MAXIMUM_RUN_INPUT_CHARACTERS,
      input.systemPromptCharacters + input.promptCharacters + MAXIMUM_SESSION_CONTEXT_CHARACTERS,
    ),
    maxModelCalls,
    maxOutputTokens: Math.min(
      effectiveExecutionLimits.maxModelTokens,
      MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
    ),
    maxToolCalls,
    maxTurns,
    reservationId: `budget_${crypto.randomUUID()}`,
    retentionSeconds: input.configuration.data.retention.runSeconds,
    runtimePlan: input.runtimePlan,
    toolGrants: input.toolGrants,
  });
}

function canonicalRequest(input: {
  agentId: string;
  continuation?:
    | { branchId: string; expectedBranchRevision: number; sessionId: string }
    | undefined;
  expectedRevision: number;
  expectedFleetRevision: number | null;
  promptCharacters: number;
  promptDigest: string;
  scheduleRevision: number | null;
  trigger: "manual" | "schedule" | "workflow";
}): string {
  return JSON.stringify({
    agentId: input.agentId,
    ...(input.continuation === undefined ? {} : { continuation: input.continuation }),
    expectedRevision: input.expectedRevision,
    ...(input.expectedFleetRevision === null
      ? {}
      : { expectedFleetRevision: input.expectedFleetRevision }),
    promptCharacters: input.promptCharacters,
    promptDigest: input.promptDigest,
    ...(input.scheduleRevision === null ? {} : { scheduleRevision: input.scheduleRevision }),
    trigger: input.trigger,
  });
}

export class RunAdmissions {
  readonly #availableCapabilityPrerequisites: ReadonlySet<string>;
  readonly #currentFleetConfiguration: () => FleetConfiguration;
  readonly #database: ControlPlaneDatabase;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;
  readonly #skills: Skills;

  constructor(
    objectName: string | undefined,
    database: ControlPlaneDatabase,
    storage: DurableObjectStorage,
    currentFleetConfiguration: () => FleetConfiguration,
    skills: Skills,
    availableCapabilityPrerequisites: ReadonlySet<string>,
  ) {
    this.#availableCapabilityPrerequisites = availableCapabilityPrerequisites;
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#objectName = objectName;
    this.#storage = storage;
    this.#skills = skills;
  }

  async create(authority: OwnerAuthority, input: unknown): Promise<CreateRunAdmissionResult> {
    const request = createRunAdmissionInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedRequest("invalid_request");
    }

    const requestDigest = await digestBase64Url(canonicalRequest(request.data));
    const currentTime = Date.now();
    const nonce = createNonce();
    const nonceDigest = await digestBase64Url(nonce);
    const fleetConfiguration = this.#currentFleetConfiguration();
    const expiresAt = currentTime + RUN_ADMISSION_LIFETIME_MS;
    const cleanupAt = currentTime + fleetConfiguration.data.retention.runSeconds * 1_000;

    if (
      request.data.expectedFleetRevision !== null &&
      request.data.expectedFleetRevision !== fleetConfiguration.revision
    ) {
      return this.#deniedRequest("revision_conflict");
    }

    const result = this.#database.transaction((transaction) => {
      this.#cleanup(transaction, currentTime);

      const existing = transaction
        .select()
        .from(runAdmissions)
        .where(
          and(
            eq(runAdmissions.clientId, authority.clientId),
            eq(runAdmissions.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .get();

      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) {
          return this.#deniedRequest("idempotency_conflict");
        }

        if (existing.status !== "issued") {
          return createRunAdmissionResultSchema.parse({
            admission: {
              agentId: existing.agentId,
              agentRevision: existing.agentRevision,
              expiresAt: new Date(existing.expiresAt).toISOString(),
              runId: existing.runId,
              status: existing.status,
            },
            created: false,
            ok: true,
            state: existing.status,
          });
        }

        if (!this.#admissionConfigurationIsActive(transaction, existing)) {
          this.#expire(
            transaction,
            existing.runId,
            this.#admissionSkillsAreActive(transaction, existing) ? null : "skill_unavailable",
          );
          return this.#deniedRequest("agent_unavailable");
        }

        transaction
          .update(runAdmissions)
          .set({ nonceDigest })
          .where(
            and(
              eq(runAdmissions.clientId, authority.clientId),
              eq(runAdmissions.idempotencyKey, request.data.idempotencyKey),
              eq(runAdmissions.status, "issued"),
            ),
          )
          .run();

        return createRunAdmissionResultSchema.parse({
          created: false,
          ok: true,
          permit: this.#permit({
            agentId: existing.agentId,
            agentRevision: existing.agentRevision,
            budgetReservation: existing.budgetReservation,
            clientId: existing.clientId,
            expiresAt: existing.expiresAt,
            idempotencyKey: existing.idempotencyKey,
            nonce: nonce,
            ownerKey: authority.ownerKey,
            promptDigest: existing.promptDigest,
            runId: existing.runId,
            scheduleRevision: existing.scheduleRevision,
            trigger: existing.trigger,
          }),
          state: "issued",
        });
      }

      const agent = transaction
        .select({
          capabilities: agentRevisions.capabilities,
          capabilityGrants: agentRevisions.capabilityGrants,
          currentRevision: agents.currentRevision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          status: agents.status,
        })
        .from(agents)
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agents.agentId),
            eq(agentRevisions.revision, agents.currentRevision),
          ),
        )
        .where(eq(agents.agentId, request.data.agentId))
        .get();

      if (agent === undefined) {
        return this.#deniedRequest("agent_not_found");
      }

      if (agent.currentRevision !== request.data.expectedRevision) {
        return this.#deniedRequest("revision_conflict");
      }

      if (agent.status !== "active") {
        return this.#deniedRequest("agent_unavailable");
      }

      const compiledCapabilities = agentCapabilityRegistry.compile(agent.capabilities, {
        availablePrerequisites: this.#availableCapabilityPrerequisites,
        checkPrerequisites: true,
        fleetConfiguration: fleetConfiguration.data,
      });

      if (!compiledCapabilities.ok) {
        return this.#deniedRequest(
          compiledCapabilities.code === "configuration_unavailable" &&
            (compiledCapabilities.moduleId === WORKERS_AI_CAPABILITY_ID ||
              compiledCapabilities.moduleId === AI_GATEWAY_CAPABILITY_ID)
            ? "model_unavailable"
            : "capability_unavailable",
        );
      }

      if (
        this.#skills.runtimeProvenance(
          compiledCapabilities.runtimePlan.skillReferences,
          transaction,
          true,
        ) === undefined
      ) {
        return this.#deniedRequest("capability_unavailable");
      }

      const toolGrants = this.#toolGrants(
        transaction,
        authority.ownerKey,
        request.data.agentId,
        agent.currentRevision,
        agent.capabilityGrants,
      );

      if (toolGrants === undefined) {
        return this.#deniedRequest("capability_unavailable");
      }

      const systemPromptCharacters =
        crewAgentSystemPrompt({
          instructions: agent.instructions,
          runtimePlan: compiledCapabilities.runtimePlan,
        }).length +
        (compiledCapabilities.runtimePlan.skillReferences.length === 0
          ? 0
          : MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS);

      if (systemPromptCharacters + request.data.promptCharacters > MAXIMUM_RUN_INPUT_CHARACTERS) {
        return this.#deniedRequest("capability_unavailable");
      }

      const admissionCount =
        transaction.select({ value: count() }).from(runAdmissions).get()?.value ?? 0;

      if (
        admissionCount >= MAXIMUM_RUN_ADMISSIONS_PER_OWNER ||
        this.#activeCount(transaction) >= fleetConfiguration.data.capacity.maxConcurrentRuns
      ) {
        return this.#deniedRequest("admission_limit_exceeded");
      }

      const budgetReservation = createBudgetReservation({
        configuration: fleetConfiguration,
        executionLimits: agent.executionLimits,
        promptCharacters: request.data.promptCharacters,
        runtimePlan: compiledCapabilities.runtimePlan,
        systemPromptCharacters,
        toolGrants,
      });
      const runId = `run_${crypto.randomUUID()}`;

      transaction
        .insert(runAdmissions)
        .values({
          agentId: request.data.agentId,
          agentRevision: agent.currentRevision,
          cleanupAt,
          clientId: authority.clientId,
          createdAt: currentTime,
          budgetReservation,
          expiresAt,
          idempotencyKey: request.data.idempotencyKey,
          nonceDigest,
          prompt: request.data.prompt ?? null,
          promptDigest: request.data.promptDigest,
          requestDigest,
          runId,
          scheduleRevision: request.data.scheduleRevision,
          status: "issued",
          trigger: request.data.trigger,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "run.admitted",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: runId,
        })
        .run();

      return createRunAdmissionResultSchema.parse({
        created: true,
        ok: true,
        permit: this.#permit({
          agentId: request.data.agentId,
          agentRevision: agent.currentRevision,
          budgetReservation,
          clientId: authority.clientId,
          expiresAt,
          idempotencyKey: request.data.idempotencyKey,
          nonce,
          ownerKey: authority.ownerKey,
          promptDigest: request.data.promptDigest,
          runId,
          scheduleRevision: request.data.scheduleRevision,
          trigger: request.data.trigger,
        }),
        state: "issued",
      });
    });

    if (result.ok && result.state === "issued") {
      recordExecutionEvent({
        outcome: result.created ? "created" : "replayed",
        phase: "run.admission",
        runId: result.permit.runId,
      });
      await this.#scheduleCleanup(Date.parse(result.permit.expiresAt));
    }

    return result;
  }

  requestCancellation(
    authority: OwnerAuthority,
    runId: string,
  ): "not_cancellable" | "not_found" | "requested" {
    const currentTime = Date.now();
    let recorded = false;

    const result = this.#database.transaction((transaction) => {
      const row = this.#admission(transaction, runId);

      if (row === undefined) {
        return "not_found";
      }

      if (row.cancellationRequestedAt !== null) {
        return "requested";
      }

      if (
        row.status === "expired" ||
        transaction
          .select({ toolCallId: toolExecutions.toolCallId })
          .from(toolExecutions)
          .where(and(eq(toolExecutions.runId, runId), isNotNull(toolExecutions.dispatchedAt)))
          .get() !== undefined
      ) {
        return "not_cancellable";
      }

      const updated = transaction
        .update(runAdmissions)
        .set({ cancellationRequestedAt: currentTime })
        .where(and(eq(runAdmissions.runId, runId), isNull(runAdmissions.cancellationRequestedAt)))
        .returning({ runId: runAdmissions.runId })
        .all();

      if (updated.length !== 1) {
        return "not_cancellable";
      }

      transaction
        .insert(auditEvents)
        .values({
          action: "run.cancellation_requested",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: runId,
        })
        .run();
      recorded = true;

      return "requested";
    });

    if (recorded) {
      recordExecutionEvent({
        outcome: "requested",
        phase: "run.cancellation",
        runId,
      });
    }

    return result;
  }

  completeCancellation(authority: OwnerAuthority, runId: string): boolean {
    const currentTime = Date.now();
    let recorded = false;

    const result = this.#database.transaction((transaction) => {
      const row = this.#admission(transaction, runId);

      if (row === undefined || row.cancellationRequestedAt === null) {
        return false;
      }

      if (row.cancelledAt !== null) {
        return true;
      }

      const updated = transaction
        .update(runAdmissions)
        .set({ cancelledAt: currentTime })
        .where(and(eq(runAdmissions.runId, runId), isNull(runAdmissions.cancelledAt)))
        .returning({ runId: runAdmissions.runId })
        .all();

      if (updated.length !== 1) {
        return false;
      }

      transaction
        .insert(auditEvents)
        .values({
          action: "run.cancelled",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: runId,
        })
        .run();
      recorded = true;

      return true;
    });

    if (recorded) {
      recordExecutionEvent({
        outcome: "completed",
        phase: "run.cancellation",
        runId,
      });
    }

    return result;
  }

  releaseCancellation(authority: OwnerAuthority, runId: string): boolean {
    const currentTime = Date.now();

    return this.#database.transaction((transaction) => {
      const row = this.#admission(transaction, runId);

      if (row === undefined || row.cancellationRequestedAt === null || row.cancelledAt !== null) {
        return false;
      }

      const updated = transaction
        .update(runAdmissions)
        .set({ cancellationRequestedAt: null })
        .where(
          and(
            eq(runAdmissions.runId, runId),
            isNotNull(runAdmissions.cancellationRequestedAt),
            isNull(runAdmissions.cancelledAt),
          ),
        )
        .returning({ runId: runAdmissions.runId })
        .all();

      if (updated.length !== 1) {
        return false;
      }

      transaction
        .insert(auditEvents)
        .values({
          action: "run.cancellation_not_applied",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: runId,
        })
        .run();

      return true;
    });
  }

  async verify(input: unknown): Promise<VerifyRunAdmissionResult> {
    const permit = runAdmissionPermitSchema.safeParse(input);

    if (!permit.success || permit.data.ownerKey !== this.#objectName) {
      return RUN_ADMISSION_ERROR;
    }

    const nonceDigest = await digestBase64Url(permit.data.nonce);
    const currentTime = Date.now();

    const candidate = this.#database.transaction((transaction) => {
      this.#cleanup(transaction, currentTime);
      const row = this.#admission(transaction, permit.data.runId);

      if (!this.#matchesIssuedPermit(row, permit.data, nonceDigest, currentTime)) {
        return RUN_ADMISSION_ERROR;
      }

      if (!this.#admissionConfigurationIsActive(transaction, row)) {
        this.#expire(
          transaction,
          permit.data.runId,
          this.#admissionSkillsAreActive(transaction, row) ? null : "skill_unavailable",
        );
        return RUN_ADMISSION_ERROR;
      }

      const configuration = this.#runtimeConfiguration(
        transaction,
        permit.data.agentId,
        permit.data.agentRevision,
      );

      if (configuration === undefined) {
        this.#expire(transaction, permit.data.runId);
        return RUN_ADMISSION_ERROR;
      }

      return verifyRunAdmissionResultSchema.parse({
        configuration,
        ok: true,
        runId: permit.data.runId,
      });
    });

    if (!candidate.ok || candidate.configuration.runtimePlan.skillReferences.length === 0) {
      return candidate;
    }

    const loaded = await this.#skills.loadRuntimeInstructions(
      candidate.configuration.runtimePlan.skillReferences,
    );

    if (!loaded.ok) {
      this.#database.transaction((transaction) => {
        const row = this.#admission(transaction, permit.data.runId);

        if (this.#matchesIssuedPermit(row, permit.data, nonceDigest, Date.now())) {
          this.#expire(transaction, permit.data.runId, "skill_unavailable");
        }
      });
      return RUN_ADMISSION_ERROR;
    }

    const revalidated = this.#database.transaction((transaction) => {
      const row = this.#admission(transaction, permit.data.runId);

      if (!this.#matchesIssuedPermit(row, permit.data, nonceDigest, Date.now())) {
        return false;
      }

      if (!this.#admissionConfigurationIsActive(transaction, row)) {
        this.#expire(
          transaction,
          permit.data.runId,
          this.#admissionSkillsAreActive(transaction, row) ? null : "skill_unavailable",
        );
        return false;
      }

      return true;
    });

    if (!revalidated) {
      return RUN_ADMISSION_ERROR;
    }

    return verifyRunAdmissionResultSchema.parse({
      configuration: {
        ...candidate.configuration,
        skillInstructions: loaded.instructions,
      },
      ok: true,
      runId: permit.data.runId,
    });
  }

  async confirm(input: unknown): Promise<ConfirmRunAdmissionResult> {
    const permit = runAdmissionPermitSchema.safeParse(input);

    if (!permit.success || permit.data.ownerKey !== this.#objectName) {
      return RUN_ADMISSION_ERROR;
    }

    const nonceDigest = await digestBase64Url(permit.data.nonce);
    const currentTime = Date.now();

    const result = this.#database.transaction((transaction) => {
      this.#cleanup(transaction, currentTime);
      const row = this.#admission(transaction, permit.data.runId);

      if (
        row === undefined ||
        row.cancellationRequestedAt !== null ||
        row.nonceDigest !== nonceDigest ||
        !this.#matchesPermit(row, permit.data)
      ) {
        return RUN_ADMISSION_ERROR;
      }

      if (row.status === "redeemed") {
        return confirmRunAdmissionResultSchema.parse({
          confirmed: false,
          ok: true,
          runId: permit.data.runId,
        });
      }

      if (row.status !== "issued" || row.expiresAt <= currentTime) {
        return RUN_ADMISSION_ERROR;
      }

      if (!this.#admissionConfigurationIsActive(transaction, row)) {
        this.#expire(
          transaction,
          permit.data.runId,
          this.#admissionSkillsAreActive(transaction, row) ? null : "skill_unavailable",
        );
        return RUN_ADMISSION_ERROR;
      }

      transaction
        .update(runAdmissions)
        .set({ redeemedAt: currentTime, status: "redeemed" })
        .where(and(eq(runAdmissions.runId, permit.data.runId), eq(runAdmissions.status, "issued")))
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "run.admission_redeemed",
          clientId: permit.data.clientId,
          occurredAt: currentTime,
          subjectId: permit.data.runId,
        })
        .run();

      return confirmRunAdmissionResultSchema.parse({
        confirmed: true,
        ok: true,
        runId: permit.data.runId,
      });
    });

    if (result.ok && result.confirmed) {
      recordExecutionEvent({
        outcome: "redeemed",
        phase: "run.admission",
        runId: result.runId,
      });
    }

    return result;
  }

  verifyActive(input: unknown): VerifyActiveRunAdmissionResult {
    const request = verifyActiveRunAdmissionInputSchema.safeParse(input);

    if (!request.success || request.data.ownerKey !== this.#objectName) {
      return RUN_ADMISSION_ERROR;
    }

    return this.#database.transaction((transaction) => {
      const currentTime = Date.now();
      this.#cleanup(transaction, currentTime);
      const row = this.#admission(transaction, request.data.runId);

      if (
        row === undefined ||
        row.status !== "redeemed" ||
        row.cancellationRequestedAt !== null ||
        row.cleanupAt <= currentTime ||
        row.modelCallsConsumed >= row.budgetReservation.maxModelCalls ||
        row.agentId !== request.data.agentId ||
        row.agentRevision !== request.data.agentRevision ||
        row.clientId !== request.data.clientId ||
        row.idempotencyKey !== request.data.idempotencyKey ||
        row.promptDigest !== request.data.promptDigest ||
        row.scheduleRevision !== request.data.scheduleRevision ||
        !sameBudgetReservation(row.budgetReservation, request.data.budgetReservation) ||
        !this.#admissionConfigurationIsActive(transaction, row)
      ) {
        return RUN_ADMISSION_ERROR;
      }

      const claimedRuns = transaction
        .update(runAdmissions)
        .set({
          modelCallConsumedAt: currentTime,
          modelCallsConsumed: row.modelCallsConsumed + 1,
        })
        .where(
          and(
            eq(runAdmissions.runId, request.data.runId),
            eq(runAdmissions.status, "redeemed"),
            eq(runAdmissions.modelCallsConsumed, row.modelCallsConsumed),
          ),
        )
        .returning({
          runId: runAdmissions.runId,
        })
        .all();

      if (claimedRuns.length !== 1 || claimedRuns[0]?.runId !== request.data.runId) {
        return RUN_ADMISSION_ERROR;
      }

      return verifyActiveRunAdmissionResultSchema.parse({
        modelCall: row.modelCallsConsumed + 1,
        ok: true,
        runId: request.data.runId,
      });
    });
  }

  verifyReceiverCapability(input: unknown): RedeemRunReceiverCapabilityResult {
    const capability = runReceiverCapabilitySchema.safeParse(input);

    if (!capability.success || capability.data.ownerKey !== this.#objectName) {
      return RUN_ADMISSION_ERROR;
    }

    const currentTime = Date.now();
    this.cleanup(currentTime);
    const row = this.#admission(this.#database, capability.data.runId);

    if (
      row === undefined ||
      row.status !== "redeemed" ||
      (!["cancel", "inspect"].includes(capability.data.action) &&
        row.cancellationRequestedAt !== null) ||
      row.cleanupAt <= currentTime ||
      row.agentId !== capability.data.agentId ||
      row.agentRevision !== capability.data.agentRevision ||
      row.idempotencyKey !== capability.data.idempotencyKey ||
      row.promptDigest !== capability.data.promptDigest ||
      row.scheduleRevision !== capability.data.scheduleRevision ||
      !sameBudgetReservation(row.budgetReservation, capability.data.budgetReservation) ||
      (capability.data.action === "resume" &&
        (row.clientId !== capability.data.clientId ||
          !this.#admissionConfigurationIsActive(this.#database, row))) ||
      (["approve_tool", "reject_tool"].includes(capability.data.action) &&
        !this.#admissionConfigurationIsActive(this.#database, row))
    ) {
      return RUN_ADMISSION_ERROR;
    }

    return redeemRunReceiverCapabilityResultSchema.parse({
      ok: true,
      runId: capability.data.runId,
    });
  }

  read(runId: string): StoredRunAdmission | undefined {
    return this.#database.select().from(runAdmissions).where(eq(runAdmissions.runId, runId)).get();
  }

  skillProvenance(admission: StoredRunAdmission) {
    return (
      this.#skills.runtimeProvenance(admission.budgetReservation.runtimePlan.skillReferences) ?? []
    );
  }

  list(input: ListAgentRunsInput): { nextCursor: string | null; runs: RunSummary[] } | undefined {
    const currentTime = Date.now();
    const projectedStatus = projectedRunStatus(currentTime);
    const projectedCompletedAt = projectedRunCompletedAt(currentTime);
    const filters = and(
      input.agentId === undefined ? undefined : eq(runAdmissions.agentId, input.agentId),
      input.createdAfter === undefined
        ? undefined
        : gte(runAdmissions.createdAt, Date.parse(input.createdAfter)),
      input.createdBefore === undefined
        ? undefined
        : lte(runAdmissions.createdAt, Date.parse(input.createdBefore)),
      input.status === undefined
        ? undefined
        : input.status === "active"
          ? inArray(projectedStatus, ["queued", "running", "cancelling"])
          : eq(projectedStatus, input.status),
      input.trigger === undefined ? undefined : eq(runAdmissions.trigger, input.trigger),
    );
    const cursorRow =
      input.cursor === undefined
        ? undefined
        : this.#database
            .select({
              createdAt: runAdmissions.createdAt,
              runId: runAdmissions.runId,
            })
            .from(runAdmissions)
            .leftJoin(agentInboxItems, eq(agentInboxItems.runId, runAdmissions.runId))
            .where(and(eq(runAdmissions.runId, input.cursor), filters))
            .get();

    if (input.cursor !== undefined && cursorRow === undefined) {
      return undefined;
    }

    const rows = this.#database
      .select({
        agentId: runAdmissions.agentId,
        agentRevision: runAdmissions.agentRevision,
        completedAt: projectedCompletedAt,
        createdAt: runAdmissions.createdAt,
        runId: runAdmissions.runId,
        startedAt: runAdmissions.redeemedAt,
        status: projectedStatus,
        trigger: runAdmissions.trigger,
      })
      .from(runAdmissions)
      .leftJoin(agentInboxItems, eq(agentInboxItems.runId, runAdmissions.runId))
      .where(
        and(
          filters,
          cursorRow === undefined
            ? undefined
            : or(
                lt(runAdmissions.createdAt, cursorRow.createdAt),
                and(
                  eq(runAdmissions.createdAt, cursorRow.createdAt),
                  lt(runAdmissions.runId, cursorRow.runId),
                ),
              ),
        ),
      )
      .orderBy(desc(runAdmissions.createdAt), desc(runAdmissions.runId))
      .limit(input.limit + 1)
      .all();
    const hasMore = rows.length > input.limit;
    const runs = rows.slice(0, input.limit).map((row) =>
      runSummarySchema.parse({
        agentId: row.agentId,
        agentRevision: row.agentRevision,
        ...(row.completedAt === null
          ? {}
          : { completedAt: new Date(row.completedAt).toISOString() }),
        createdAt: new Date(row.createdAt).toISOString(),
        runId: row.runId,
        ...(row.startedAt === null ? {} : { startedAt: new Date(row.startedAt).toISOString() }),
        status: row.status,
        trigger: row.trigger,
      }),
    );

    return {
      nextCursor: hasMore ? (runs.at(-1)?.runId ?? null) : null,
      runs,
    };
  }

  activeCount(): number {
    return this.#activeCount(this.#database);
  }

  cleanup(currentTime: number): void {
    this.#database.transaction((transaction) => {
      this.#cleanup(transaction, currentTime);
    });
  }

  nextCleanupAt(): number | null {
    const expiry =
      this.#database
        .select({ value: min(runAdmissions.expiresAt) })
        .from(runAdmissions)
        .where(eq(runAdmissions.status, "issued"))
        .get()?.value ?? null;
    const retention =
      this.#database
        .select({ value: min(runAdmissions.cleanupAt) })
        .from(runAdmissions)
        .get()?.value ?? null;

    if (expiry === null) {
      return retention;
    }

    return retention === null ? expiry : Math.min(expiry, retention);
  }

  #admission(database: RunAdmissionDatabase, runId: string): StoredRunAdmission | undefined {
    return database.select().from(runAdmissions).where(eq(runAdmissions.runId, runId)).get();
  }

  #cleanup(database: RunAdmissionDatabase, currentTime: number): void {
    database
      .update(runAdmissions)
      .set({ status: "expired" })
      .where(and(eq(runAdmissions.status, "issued"), lte(runAdmissions.expiresAt, currentTime)))
      .run();
    const expiredRunIds = database
      .select({ runId: runAdmissions.runId })
      .from(runAdmissions)
      .where(lte(runAdmissions.cleanupAt, currentTime))
      .all()
      .map((row) => row.runId);

    if (expiredRunIds.length === 0) {
      return;
    }

    const unresolvedRunIds = new Set(
      database
        .select({ runId: toolExecutions.runId })
        .from(toolExecutions)
        .where(
          and(inArray(toolExecutions.runId, expiredRunIds), eq(toolExecutions.status, "unknown")),
        )
        .all()
        .map((row) => row.runId),
    );
    const retainedRunIds = [...unresolvedRunIds];
    const safeToDeleteRunIds = expiredRunIds.filter((runId) => !unresolvedRunIds.has(runId));

    if (retainedRunIds.length > 0) {
      database
        .update(runAdmissions)
        .set({
          cleanupAt: sql`${currentTime} + coalesce(
            json_extract(${runAdmissions.budgetReservation}, '$.retentionSeconds'),
            ${DEFAULT_FLEET_RUN_RETENTION_SECONDS}
          ) * 1000`,
        })
        .where(inArray(runAdmissions.runId, retainedRunIds))
        .run();
    }

    if (safeToDeleteRunIds.length > 0) {
      database.delete(toolApprovals).where(inArray(toolApprovals.runId, safeToDeleteRunIds)).run();
      database
        .delete(toolExecutions)
        .where(inArray(toolExecutions.runId, safeToDeleteRunIds))
        .run();
      database.delete(runAdmissions).where(inArray(runAdmissions.runId, safeToDeleteRunIds)).run();
    }
  }

  #activeCount(database: RunAdmissionDatabase): number {
    const currentTime = Date.now();

    return (
      database
        .select({ value: count() })
        .from(runAdmissions)
        .leftJoin(agentInboxItems, eq(agentInboxItems.runId, runAdmissions.runId))
        .where(inArray(projectedRunStatus(currentTime), ["queued", "running", "cancelling"]))
        .get()?.value ?? 0
    );
  }

  #runtimeConfiguration(
    database: RunAdmissionDatabase,
    agentId: string,
    revision: number,
  ): CrewAgentRuntimeConfig | undefined {
    const row = database
      .select({
        capabilities: agentRevisions.capabilities,
        capabilityGrants: agentRevisions.capabilityGrants,
        currentRevision: agents.currentRevision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        status: agents.status,
      })
      .from(agents)
      .innerJoin(
        agentRevisions,
        and(eq(agentRevisions.agentId, agents.agentId), eq(agentRevisions.revision, revision)),
      )
      .where(eq(agents.agentId, agentId))
      .get();

    if (
      row === undefined ||
      row.currentRevision !== revision ||
      row.status !== "active" ||
      this.#objectName === undefined
    ) {
      return undefined;
    }

    const compiledCapabilities = agentCapabilityRegistry.compile(row.capabilities, {
      availablePrerequisites: this.#availableCapabilityPrerequisites,
      checkPrerequisites: true,
      fleetConfiguration: this.#currentFleetConfiguration().data,
    });

    if (!compiledCapabilities.ok) {
      return undefined;
    }

    return crewAgentRuntimeConfigSchema.parse({
      agentId,
      capabilities: compiledCapabilities.capabilities,
      capabilityGrants: row.capabilityGrants,
      executionLimits: row.executionLimits,
      instructions: row.instructions,
      ownerKey: this.#objectName,
      revision,
      runtimePlan: compiledCapabilities.runtimePlan,
    });
  }

  #toolGrants(
    database: RunAdmissionDatabase,
    ownerKey: string,
    agentId: string,
    agentRevision: number,
    grantIds: readonly string[],
  ): ComposioToolCapabilityGrant[] | undefined {
    if (grantIds.length === 0) {
      return [];
    }

    const rows = database
      .select({
        agentId: storedCapabilityGrants.agentId,
        agentRevision: storedCapabilityGrants.agentRevision,
        connectionId: storedCapabilityGrants.connectionId,
        connectionStatus: connections.status,
        grant: storedCapabilityGrants.grant,
        grantId: storedCapabilityGrants.grantId,
        grantStatus: storedCapabilityGrants.status,
      })
      .from(storedCapabilityGrants)
      .innerJoin(connections, eq(connections.connectionId, storedCapabilityGrants.connectionId))
      .where(inArray(storedCapabilityGrants.grantId, [...grantIds]))
      .all();
    const byGrantId = new Map(rows.map((row) => [row.grantId, row]));
    const grants: ComposioToolCapabilityGrant[] = [];

    for (const grantId of grantIds) {
      const row = byGrantId.get(grantId);
      const parsed = composioToolCapabilityGrantSchema.safeParse(row?.grant);

      if (
        !parsed.success ||
        row === undefined ||
        row.agentId !== agentId ||
        row.agentRevision !== agentRevision ||
        row.connectionId !== parsed.data.connectionId ||
        parsed.data.ownerKey !== ownerKey ||
        parsed.data.agentId !== agentId ||
        parsed.data.agentRevision !== agentRevision ||
        parsed.data.grantId !== grantId
      ) {
        return undefined;
      }

      if (row.grantStatus === "active" && row.connectionStatus === "active") {
        grants.push(parsed.data);
      }
    }

    return grants;
  }

  #matchesPermit(row: StoredRunAdmission, permit: RunAdmissionPermit): boolean {
    return (
      row.clientId === permit.clientId &&
      row.idempotencyKey === permit.idempotencyKey &&
      row.runId === permit.runId &&
      row.agentId === permit.agentId &&
      row.agentRevision === permit.agentRevision &&
      row.promptDigest === permit.promptDigest &&
      row.scheduleRevision === permit.scheduleRevision &&
      row.trigger === permit.trigger &&
      sameBudgetReservation(row.budgetReservation, permit.budgetReservation) &&
      row.expiresAt === Date.parse(permit.expiresAt)
    );
  }

  #matchesIssuedPermit(
    row: StoredRunAdmission | undefined,
    permit: RunAdmissionPermit,
    nonceDigest: string,
    currentTime: number,
  ): row is StoredRunAdmission {
    return (
      row !== undefined &&
      row.status === "issued" &&
      row.cancellationRequestedAt === null &&
      row.nonceDigest === nonceDigest &&
      row.expiresAt > currentTime &&
      this.#matchesPermit(row, permit)
    );
  }

  #permit(input: {
    agentId: string;
    agentRevision: number;
    budgetReservation: RunAdmissionPermit["budgetReservation"];
    clientId: string;
    expiresAt: number | string;
    idempotencyKey: string;
    nonce: string;
    ownerKey: string;
    promptDigest: string;
    runId: string;
    scheduleRevision: number | null;
    trigger: RunAdmissionPermit["trigger"];
  }): RunAdmissionPermit {
    return runAdmissionPermitSchema.parse({
      agentId: input.agentId,
      agentRevision: input.agentRevision,
      budgetReservation: input.budgetReservation,
      clientId: input.clientId,
      expiresAt:
        typeof input.expiresAt === "number"
          ? new Date(input.expiresAt).toISOString()
          : input.expiresAt,
      idempotencyKey: input.idempotencyKey,
      nonce: input.nonce,
      ownerKey: input.ownerKey,
      promptDigest: input.promptDigest,
      runId: input.runId,
      scheduleRevision: input.scheduleRevision,
      trigger: input.trigger,
    });
  }

  #reservationMatchesConfiguration(
    reservation: RunBudgetReservation,
    configuration: CrewAgentRuntimeConfig,
    activeToolGrants: readonly ComposioToolCapabilityGrant[],
  ): boolean {
    return (
      reservation.maxDurationSeconds <= configuration.executionLimits.maxDurationSeconds &&
      sameRuntimePlan(reservation.runtimePlan, configuration.runtimePlan) &&
      reservation.maxOutputTokens <= configuration.executionLimits.maxModelTokens &&
      reservation.maxToolCalls <= configuration.executionLimits.maxToolCalls &&
      reservation.toolGrants.length === activeToolGrants.length &&
      reservation.toolGrants.every(
        (grant, index) =>
          JSON.stringify(grant) === JSON.stringify(activeToolGrants[index]) &&
          configuration.capabilityGrants.includes(grant.grantId),
      ) &&
      reservation.maxTurns <= configuration.executionLimits.maxTurns
    );
  }

  #admissionConfigurationIsActive(
    database: RunAdmissionDatabase,
    admission: StoredRunAdmission,
  ): boolean {
    if (
      this.#currentFleetConfiguration().revision !==
      admission.budgetReservation.fleetConfigurationRevision
    ) {
      return false;
    }

    const configuration = this.#runtimeConfiguration(
      database,
      admission.agentId,
      admission.agentRevision,
    );

    if (configuration === undefined || this.#objectName === undefined) {
      return false;
    }

    if (admission.status === "issued" && !this.#admissionSkillsAreActive(database, admission)) {
      return false;
    }

    const activeToolGrants = this.#toolGrants(
      database,
      this.#objectName,
      admission.agentId,
      admission.agentRevision,
      configuration.capabilityGrants,
    );

    return (
      activeToolGrants !== undefined &&
      this.#reservationMatchesConfiguration(
        admission.budgetReservation,
        configuration,
        activeToolGrants,
      )
    );
  }

  #admissionSkillsAreActive(
    database: RunAdmissionDatabase,
    admission: StoredRunAdmission,
  ): boolean {
    const references = agentRuntimePlanSchema.safeParse(admission.budgetReservation.runtimePlan);

    return (
      references.success &&
      this.#skills.runtimeProvenance(references.data.skillReferences, database, true) !== undefined
    );
  }

  #expire(
    database: RunAdmissionDatabase,
    runId: string,
    failureCode: StoredRunAdmission["failureCode"] = null,
  ): void {
    database
      .update(runAdmissions)
      .set({ failureCode, status: "expired" })
      .where(and(eq(runAdmissions.runId, runId), eq(runAdmissions.status, "issued")))
      .run();
  }

  #deniedRequest(code: RunAdmissionRequestErrorCode): CreateRunAdmissionResult {
    return createRunAdmissionResultSchema.parse({
      error: {
        code,
        message: "Run admission denied.",
      },
      ok: false,
    });
  }

  async #scheduleCleanup(cleanupAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || cleanupAt < scheduledAlarm) {
      await this.#storage.setAlarm(cleanupAt);
    }
  }
}
