import {
  MAXIMUM_RUN_ADMISSIONS_PER_OWNER,
  MAXIMUM_OWNER_RUN_INPUT_CHARACTERS_PER_WINDOW,
  MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW,
  MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW,
  MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
  composioToolCapabilityGrantSchema,
  RUN_ADMISSION_LIFETIME_MS,
  RUN_ADMISSION_RETENTION_MS,
  RUN_BUDGET_WINDOW_MS,
  confirmRunAdmissionResultSchema,
  createRunAdmissionInputSchema,
  createRunAdmissionResultSchema,
  crewAgentRuntimeConfigSchema,
  redeemRunReceiverCapabilityResultSchema,
  runnableAgentModelSchema,
  runBudgetReservationSchema,
  runAdmissionNonceSchema,
  runAdmissionPermitSchema,
  runReceiverCapabilitySchema,
  verifyActiveRunAdmissionInputSchema,
  verifyActiveRunAdmissionResultSchema,
  verifyRunAdmissionResultSchema,
  type ConfirmRunAdmissionResult,
  type CreateRunAdmissionResult,
  type CrewAgentRuntimeConfig,
  type OwnerAuthority,
  type RunAdmissionPermit,
  type RedeemRunReceiverCapabilityResult,
  type RunBudgetReservation,
  type ComposioToolCapabilityGrant,
  type VerifyActiveRunAdmissionResult,
  type VerifyRunAdmissionResult,
} from "@crewhelm/contracts";
import { and, count, eq, gt, inArray, isNotNull, isNull, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { recordExecutionEvent } from "../../observability/execution.js";
import {
  agentRevisions,
  agents,
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

function createBudgetReservation(input: {
  executionLimits: CrewAgentRuntimeConfig["executionLimits"];
  instructions: string;
  model: string;
  promptCharacters: number;
  toolGrants: ComposioToolCapabilityGrant[];
}): RunBudgetReservation {
  const grantedToolCalls = input.toolGrants.reduce(
    (total, grant) => total + grant.limits.maxCallsPerRun,
    0,
  );
  const maxToolCalls = Math.min(input.executionLimits.maxToolCalls, grantedToolCalls);
  const maxTurns = Math.min(input.executionLimits.maxTurns, maxToolCalls + 1);
  const maxModelCalls = Math.min(input.executionLimits.maxTurns, maxTurns + maxToolCalls);

  return runBudgetReservationSchema.parse({
    maxDurationSeconds: input.executionLimits.maxDurationSeconds,
    maxInputCharacters: input.instructions.length + input.promptCharacters,
    maxModelCalls,
    model: input.model,
    maxOutputTokens: Math.min(
      input.executionLimits.maxModelTokens,
      MAXIMUM_RUN_MODEL_OUTPUT_TOKENS,
    ),
    maxToolCalls,
    maxTurns,
    reservationId: `budget_${crypto.randomUUID()}`,
    toolGrants: input.toolGrants,
  });
}

function canonicalRequest(input: {
  agentId: string;
  expectedRevision: number;
  promptCharacters: number;
  promptDigest: string;
}): string {
  return JSON.stringify({
    agentId: input.agentId,
    expectedRevision: input.expectedRevision,
    promptCharacters: input.promptCharacters,
    promptDigest: input.promptDigest,
  });
}

export class RunAdmissions {
  readonly #database: ControlPlaneDatabase;
  readonly #objectName: string | undefined;
  readonly #storage: DurableObjectStorage;

  constructor(
    objectName: string | undefined,
    database: ControlPlaneDatabase,
    storage: DurableObjectStorage,
  ) {
    this.#database = database;
    this.#objectName = objectName;
    this.#storage = storage;
  }

  async create(authority: OwnerAuthority, input: unknown): Promise<CreateRunAdmissionResult> {
    const request = createRunAdmissionInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedRequest("invalid_request");
    }

    const requestDigest = await digestBase64Url(canonicalRequest(request.data));
    const currentTime = Date.now();
    const expiresAt = currentTime + RUN_ADMISSION_LIFETIME_MS;
    const cleanupAt = currentTime + RUN_ADMISSION_RETENTION_MS;
    const nonce = createNonce();
    const nonceDigest = await digestBase64Url(nonce);

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
          }),
          state: "issued",
        });
      }

      const agent = transaction
        .select({
          capabilityGrants: agentRevisions.capabilityGrants,
          currentRevision: agents.currentRevision,
          executionLimits: agentRevisions.executionLimits,
          instructions: agentRevisions.instructions,
          model: agentRevisions.model,
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

      if (!runnableAgentModelSchema.safeParse(agent.model).success) {
        return this.#deniedRequest("model_unavailable");
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

      const admissionCount =
        transaction.select({ value: count() }).from(runAdmissions).get()?.value ?? 0;

      if (admissionCount >= MAXIMUM_RUN_ADMISSIONS_PER_OWNER) {
        return this.#deniedRequest("admission_limit_exceeded");
      }

      const budgetReservation = createBudgetReservation({
        executionLimits: agent.executionLimits,
        instructions: agent.instructions,
        model: agent.model,
        promptCharacters: request.data.promptCharacters,
        toolGrants,
      });
      const activeReservations = transaction
        .select({ budgetReservation: runAdmissions.budgetReservation })
        .from(runAdmissions)
        .where(gt(runAdmissions.createdAt, currentTime - RUN_BUDGET_WINDOW_MS))
        .all();
      const reserved = activeReservations.reduce(
        (total, row) => ({
          inputCharacters: total.inputCharacters + row.budgetReservation.maxInputCharacters,
          modelCalls: total.modelCalls + row.budgetReservation.maxModelCalls,
          outputTokens:
            total.outputTokens +
            row.budgetReservation.maxOutputTokens * row.budgetReservation.maxModelCalls,
        }),
        { inputCharacters: 0, modelCalls: 0, outputTokens: 0 },
      );

      if (
        reserved.inputCharacters + budgetReservation.maxInputCharacters >
          MAXIMUM_OWNER_RUN_INPUT_CHARACTERS_PER_WINDOW ||
        reserved.modelCalls + budgetReservation.maxModelCalls >
          MAXIMUM_OWNER_RUN_MODEL_CALLS_PER_WINDOW ||
        reserved.outputTokens +
          budgetReservation.maxOutputTokens * budgetReservation.maxModelCalls >
          MAXIMUM_OWNER_RUN_OUTPUT_TOKENS_PER_WINDOW
      ) {
        return this.#deniedRequest("budget_exhausted");
      }

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
          promptDigest: request.data.promptDigest,
          requestDigest,
          runId,
          status: "issued",
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

    return this.#database.transaction((transaction) => {
      this.#cleanup(transaction, currentTime);
      const row = this.#admission(transaction, permit.data.runId);

      if (
        row === undefined ||
        row.status !== "issued" ||
        row.cancellationRequestedAt !== null ||
        row.nonceDigest !== nonceDigest ||
        row.expiresAt <= currentTime ||
        !this.#matchesPermit(row, permit.data)
      ) {
        return RUN_ADMISSION_ERROR;
      }

      const configuration = this.#runtimeConfiguration(
        transaction,
        permit.data.agentId,
        permit.data.agentRevision,
      );

      if (
        configuration === undefined ||
        !this.#reservationMatchesConfiguration(permit.data.budgetReservation, configuration)
      ) {
        this.#expire(transaction, permit.data.runId);
        return RUN_ADMISSION_ERROR;
      }

      return verifyRunAdmissionResultSchema.parse({
        configuration,
        ok: true,
        runId: permit.data.runId,
      });
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

      const configuration = this.#runtimeConfiguration(
        transaction,
        permit.data.agentId,
        permit.data.agentRevision,
      );

      if (
        configuration === undefined ||
        !this.#reservationMatchesConfiguration(permit.data.budgetReservation, configuration)
      ) {
        this.#expire(transaction, permit.data.runId);
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
        JSON.stringify(row.budgetReservation) !== JSON.stringify(request.data.budgetReservation) ||
        this.#runtimeConfiguration(transaction, row.agentId, row.agentRevision) === undefined
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
      JSON.stringify(row.budgetReservation) !== JSON.stringify(capability.data.budgetReservation) ||
      (capability.data.action === "resume" &&
        (row.clientId !== capability.data.clientId ||
          this.#runtimeConfiguration(this.#database, row.agentId, row.agentRevision) ===
            undefined)) ||
      (["approve_tool", "reject_tool"].includes(capability.data.action) &&
        this.#runtimeConfiguration(this.#database, row.agentId, row.agentRevision) === undefined)
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

    database.delete(toolApprovals).where(inArray(toolApprovals.runId, expiredRunIds)).run();
    database.delete(toolExecutions).where(inArray(toolExecutions.runId, expiredRunIds)).run();
    database.delete(runAdmissions).where(lte(runAdmissions.cleanupAt, currentTime)).run();
  }

  #runtimeConfiguration(
    database: RunAdmissionDatabase,
    agentId: string,
    revision: number,
  ): CrewAgentRuntimeConfig | undefined {
    const row = database
      .select({
        capabilityGrants: agentRevisions.capabilityGrants,
        currentRevision: agents.currentRevision,
        executionLimits: agentRevisions.executionLimits,
        instructions: agentRevisions.instructions,
        model: agentRevisions.model,
      })
      .from(agents)
      .innerJoin(
        agentRevisions,
        and(eq(agentRevisions.agentId, agents.agentId), eq(agentRevisions.revision, revision)),
      )
      .where(eq(agents.agentId, agentId))
      .get();

    if (row === undefined || row.currentRevision !== revision || this.#objectName === undefined) {
      return undefined;
    }

    return crewAgentRuntimeConfigSchema.parse({
      agentId,
      capabilityGrants: row.capabilityGrants,
      executionLimits: row.executionLimits,
      instructions: row.instructions,
      model: row.model,
      ownerKey: this.#objectName,
      revision,
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
        row?.grantStatus !== "active" ||
        row.connectionStatus !== "active" ||
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

      grants.push(parsed.data);
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
      JSON.stringify(row.budgetReservation) === JSON.stringify(permit.budgetReservation) &&
      row.expiresAt === Date.parse(permit.expiresAt)
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
    });
  }

  #reservationMatchesConfiguration(
    reservation: RunBudgetReservation,
    configuration: CrewAgentRuntimeConfig,
  ): boolean {
    return (
      reservation.maxDurationSeconds <= configuration.executionLimits.maxDurationSeconds &&
      reservation.model === configuration.model &&
      reservation.maxOutputTokens <= configuration.executionLimits.maxModelTokens &&
      reservation.maxToolCalls <= configuration.executionLimits.maxToolCalls &&
      reservation.toolGrants.length === configuration.capabilityGrants.length &&
      reservation.toolGrants.every(
        (grant, index) => grant.grantId === configuration.capabilityGrants[index],
      ) &&
      reservation.maxTurns <= configuration.executionLimits.maxTurns
    );
  }

  #expire(database: RunAdmissionDatabase, runId: string): void {
    database
      .update(runAdmissions)
      .set({ status: "expired" })
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
