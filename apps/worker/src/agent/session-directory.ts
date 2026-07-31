import {
  acceptRunAdmissionInputSchema,
  acceptRunAdmissionResultSchema,
  branchIdSchema,
  continuationFromRunSession,
  crewAgentObjectName,
  crewSessionObjectName,
  DEFAULT_AGENT_SESSION_RETENTION_SECONDS,
  deleteAgentSessionResultSchema,
  inspectAgentSessionResultSchema,
  listAgentSessionsResultSchema,
  MAXIMUM_AGENT_SESSIONS,
  runIdSchema,
  runSessionSchema,
  sessionContinuationSchema,
  sessionIdSchema,
  sessionSummarySchema,
  type AcceptRunAdmissionResult,
  type DeleteAgentSessionResult,
  type InspectAgentSessionResult,
  type ListAgentSessionsResult,
  type RunSession,
  type SessionContinuation,
  type SessionSummary,
} from "@crewhelm/contracts";
import * as z from "zod";

import { CrewSession } from "./admitted-runs/index.js";

const SESSION_RECORD_PREFIX = "crewhelm:session:";
const RUN_SESSION_PREFIX = "crewhelm:run-session:";
const SESSION_RUN_INDEX_PREFIX = "crewhelm:session-run:";
const SESSION_DELETE_PREFIX = "crewhelm:session-delete:";
const SESSION_DELETE_INTENT_PREFIX = "crewhelm:session-deletion-intent:";
const SESSION_RUN_PAGE_SIZE = 50;

const sessionDirectoryRecordSchema = z.strictObject({
  activeRunId: runIdSchema.nullable(),
  agentId: z.string().min(1),
  availableUntil: z.number().int().positive(),
  branchId: branchIdSchema,
  branchRevision: z.number().int().positive().safe(),
  createdAt: z.number().int().positive(),
  deleting: z.boolean().default(false),
  ownerKey: z.string().min(1),
  sessionId: sessionIdSchema,
  updatedAt: z.number().int().positive(),
  visible: z.boolean(),
});

const runSessionDirectoryRecordSchema = z.strictObject({
  continuation: sessionContinuationSchema.nullable(),
  deadlineAt: z.number().int().positive(),
  previousRevision: z.number().int().nonnegative().safe(),
  session: runSessionSchema,
});

const sessionDirectoryRequestSchema = z.strictObject({
  agentId: z.string().min(1),
  ownerKey: z.string().min(1),
});

const listSessionsRequestSchema = sessionDirectoryRequestSchema.extend({
  cursor: sessionIdSchema.optional(),
  limit: z.number().int().min(1).max(100),
});

const inspectSessionRequestSchema = sessionDirectoryRequestSchema.extend({
  sessionId: sessionIdSchema,
});

const listSessionRunIdsRequestSchema = inspectSessionRequestSchema.extend({
  cursor: runIdSchema.optional(),
});

const deleteSessionRequestSchema = inspectSessionRequestSchema.extend({
  expectedBranchRevision: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(128),
});

const sessionDeleteReceiptSchema = z.strictObject({
  deletedAt: z.number().int().positive(),
  expectedBranchRevision: z.number().int().positive().safe(),
  sessionId: sessionIdSchema,
});

const sessionDeleteIntentSchema = z.strictObject({
  expectedBranchRevision: z.number().int().positive().safe(),
  idempotencyKey: z.string().min(1).max(128),
  sessionId: sessionIdSchema,
});

type SessionDirectoryRecord = z.infer<typeof sessionDirectoryRecordSchema>;
type RunSessionDirectoryRecord = z.infer<typeof runSessionDirectoryRecordSchema>;

function sessionRecordKey(sessionId: string): string {
  return `${SESSION_RECORD_PREFIX}${sessionId}`;
}

function runSessionKey(runId: string): string {
  return `${RUN_SESSION_PREFIX}${runId}`;
}

function sessionRunIndexPrefix(sessionId: string): string {
  return `${SESSION_RUN_INDEX_PREFIX}${sessionId}:`;
}

function sessionRunIndexKey(sessionId: string, runId: string): string {
  return `${sessionRunIndexPrefix(sessionId)}${runId}`;
}

function sessionDeleteKey(idempotencyKey: string): string {
  return `${SESSION_DELETE_PREFIX}${idempotencyKey}`;
}

function sessionDeleteIntentKey(idempotencyKey: string): string {
  return `${SESSION_DELETE_INTENT_PREFIX}${idempotencyKey}`;
}

function newSessionId(): string {
  return `session_${crypto.randomUUID()}`;
}

function newBranchId(): string {
  return `branch_${crypto.randomUUID()}`;
}

function sessionProjection(record: SessionDirectoryRecord): SessionSummary {
  return sessionSummarySchema.parse({
    agentId: record.agentId,
    availableUntil: new Date(record.availableUntil).toISOString(),
    branchId: record.branchId,
    branchRevision: record.branchRevision,
    createdAt: new Date(record.createdAt).toISOString(),
    sessionId: record.sessionId,
    status: record.activeRunId === null && !record.deleting ? "idle" : "active",
    updatedAt: new Date(record.updatedAt).toISOString(),
  });
}

const invalidAdmission = {
  error: { code: "invalid_admission", message: "Run admission denied." },
  ok: false,
} as const;

export class CrewAgent extends CrewSession {
  protected durableSessionsEnabled(): boolean {
    return true;
  }

  protected sessionNamespace(): DurableObjectNamespace<CrewSession> {
    return this.env.CREW_SESSION;
  }

  override async acceptRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    if (!this.durableSessionsEnabled()) {
      return super.acceptRunAdmission(input);
    }

    const request = acceptRunAdmissionInputSchema.safeParse(input);

    if (!request.success || request.data.session !== undefined) {
      return invalidAdmission;
    }

    if (request.data.permit.scheduleRevision !== null) {
      return request.data.continuation === undefined
        ? super.acceptRunAdmission(request.data)
        : invalidAdmission;
    }

    const prepared = await this.#prepareSession(
      request.data.permit.ownerKey,
      request.data.permit.agentId,
      request.data.permit.runId,
      Date.now() + request.data.permit.budgetReservation.maxDurationSeconds * 1_000,
      Date.now() +
        Math.max(
          DEFAULT_AGENT_SESSION_RETENTION_SECONDS,
          request.data.permit.budgetReservation.retentionSeconds,
        ) *
          1_000,
      true,
      request.data.continuation,
    );

    if (!prepared.ok) {
      return prepared.result;
    }

    let result: AcceptRunAdmissionResult;

    try {
      result = acceptRunAdmissionResultSchema.parse(
        await this.#session(prepared.mapping.session).acceptRunAdmission({
          permit: request.data.permit,
          prompt: request.data.prompt,
          session: prepared.mapping.session,
        }),
      );
    } catch {
      result = invalidAdmission;
    }

    if (!result.ok) {
      try {
        const state = await this.#session(prepared.mapping.session).inspectSessionRunState({
          runId: request.data.permit.runId,
          session: prepared.mapping.session,
        });

        if (state === null) {
          await this.#rollbackPreparedSession(request.data.permit.runId, prepared.mapping);
        }
      } catch {
        // Preserve ambiguous routing so an idempotent retry reaches the same session runtime.
      }
    } else if (!result.accepted) {
      try {
        const discarded = await this.#session(prepared.mapping.session).discardRejectedSessionRun({
          runId: request.data.permit.runId,
          session: prepared.mapping.session,
        });

        if (discarded) {
          await this.#rollbackPreparedSession(request.data.permit.runId, prepared.mapping);
        }
      } catch {
        // Preserve the reservation if exact cleanup cannot be confirmed.
      }
    }

    return result;
  }

  override async resumeRunAdmission(input: unknown): Promise<AcceptRunAdmissionResult> {
    if (!this.durableSessionsEnabled()) {
      return super.resumeRunAdmission(input);
    }

    const request = z
      .strictObject({
        capability: z.object({ runId: runIdSchema }).passthrough(),
        continuation: sessionContinuationSchema.optional(),
        prompt: z.string(),
      })
      .safeParse(input);

    if (!request.success) {
      return invalidAdmission;
    }

    const mapping = await this.#readRunSession(request.data.capability.runId);

    if (mapping === undefined) {
      return super.resumeRunAdmission(input);
    }

    if (
      JSON.stringify(mapping.continuation ?? undefined) !==
      JSON.stringify(request.data.continuation)
    ) {
      return invalidAdmission;
    }

    try {
      return acceptRunAdmissionResultSchema.parse(
        await this.#session(mapping.session).resumeRunAdmission({
          capability: request.data.capability,
          ...(request.data.continuation === undefined
            ? {}
            : { continuation: request.data.continuation }),
          prompt: request.data.prompt,
          session: mapping.session,
        }),
      );
    } catch {
      return invalidAdmission;
    }
  }

  override async inspectAdmittedRun(input: unknown) {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.inspectAdmittedRun(input)
      : session.inspectAdmittedRun(input);
  }

  override async cancelAdmittedRun(input: unknown) {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.cancelAdmittedRun(input)
      : session.cancelAdmittedRun(input);
  }

  override async listAdmittedRunToolApprovals(input: unknown) {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.listAdmittedRunToolApprovals(input)
      : session.listAdmittedRunToolApprovals(input);
  }

  override async decideAdmittedRunToolApproval(input: unknown) {
    const session = await this.#sessionForRunInput(input);
    return session === undefined
      ? super.decideAdmittedRunToolApproval(input)
      : session.decideAdmittedRunToolApproval(input);
  }

  async completeSessionRun(input: unknown): Promise<boolean> {
    const request = z
      .strictObject({ runId: runIdSchema, session: runSessionSchema })
      .safeParse(input);

    if (!request.success) {
      return false;
    }

    const mapping = await this.#readRunSession(request.data.runId);

    if (
      mapping === undefined ||
      JSON.stringify(mapping.session) !== JSON.stringify(request.data.session)
    ) {
      return false;
    }

    const record = await this.#readSession(request.data.session.sessionId);

    if (record === undefined || record.activeRunId !== request.data.runId) {
      return false;
    }

    await this.ctx.storage.put(sessionRecordKey(record.sessionId), {
      ...record,
      activeRunId: null,
      updatedAt: Date.now(),
    });
    await this.#scheduleSessionCleanup();
    return true;
  }

  async listAgentSessions(input: unknown): Promise<ListAgentSessionsResult> {
    const request = listSessionsRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return { error: { code: "owner_mismatch", message: "Session request denied." }, ok: false };
    }

    await this.#cleanupExpiredSessions();
    const records = await this.#sessionRecords();
    const after = request.data.cursor;
    const eligible = records.filter(
      (record) => record.visible && (after === undefined || record.sessionId > after),
    );
    const page = eligible.slice(0, request.data.limit);

    return listAgentSessionsResultSchema.parse({
      nextCursor: eligible.length > page.length ? (page.at(-1)?.sessionId ?? null) : null,
      ok: true,
      sessions: page.map(sessionProjection),
    });
  }

  async inspectAgentSession(input: unknown): Promise<InspectAgentSessionResult> {
    const request = inspectSessionRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return { error: { code: "owner_mismatch", message: "Session request denied." }, ok: false };
    }

    const record = await this.#readAvailableSession(request.data.sessionId);

    if (record === undefined || !record.visible) {
      return {
        error: { code: "session_not_found", message: "Session request denied." },
        ok: false,
      };
    }

    try {
      const inspection = await this.#session({
        branchId: record.branchId,
        branchRevision: record.branchRevision,
        sessionId: record.sessionId,
      }).inspectSessionMessages();

      return inspectAgentSessionResultSchema.parse({
        ...inspection,
        continuation: continuationFromRunSession(sessionProjection(record)),
        ok: true,
        session: sessionProjection(record),
      });
    } catch {
      return {
        error: { code: "session_unavailable", message: "Session request denied." },
        ok: false,
      };
    }
  }

  async deleteAgentSession(input: unknown): Promise<DeleteAgentSessionResult> {
    const request = deleteSessionRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return {
        error: { code: "owner_mismatch", message: "Session deletion denied." },
        ok: false,
      };
    }

    const priorDeletion = sessionDeleteReceiptSchema.safeParse(
      await this.ctx.storage.get(sessionDeleteKey(request.data.idempotencyKey)),
    );

    if (priorDeletion.success) {
      return priorDeletion.data.sessionId === request.data.sessionId &&
        priorDeletion.data.expectedBranchRevision === request.data.expectedBranchRevision
        ? { deleted: true, ok: true, sessionId: request.data.sessionId }
        : {
            error: { code: "invalid_request", message: "Session deletion denied." },
            ok: false,
          };
    }

    const record = await this.#readAvailableSession(request.data.sessionId);

    if (record === undefined || !record.visible) {
      return {
        error: { code: "session_not_found", message: "Session deletion denied." },
        ok: false,
      };
    }

    if (record.branchRevision !== request.data.expectedBranchRevision) {
      return {
        error: { code: "revision_conflict", message: "Session deletion denied." },
        ok: false,
      };
    }

    if (await this.#reconcileActiveRun(record)) {
      return {
        error: { code: "session_busy", message: "Session deletion denied." },
        ok: false,
      };
    }

    const reservedDeletion = await this.ctx.storage.transaction(async (storage) => {
      const current = sessionDirectoryRecordSchema.safeParse(
        await storage.get(sessionRecordKey(record.sessionId)),
      );
      const intent = sessionDeleteIntentSchema.safeParse(
        await storage.get(sessionDeleteIntentKey(request.data.idempotencyKey)),
      );

      if (
        intent.success &&
        (intent.data.expectedBranchRevision !== request.data.expectedBranchRevision ||
          intent.data.sessionId !== request.data.sessionId)
      ) {
        return { code: "invalid_request", ok: false } as const;
      }

      if (!current.success || current.data.branchRevision !== request.data.expectedBranchRevision) {
        return { code: "revision_conflict", ok: false } as const;
      }

      if (current.data.deleting) {
        return intent.success &&
          intent.data.expectedBranchRevision === request.data.expectedBranchRevision &&
          intent.data.idempotencyKey === request.data.idempotencyKey &&
          intent.data.sessionId === request.data.sessionId
          ? ({ ok: true, record: current.data } as const)
          : ({ code: "session_busy", ok: false } as const);
      }

      if (current.data.activeRunId !== null) {
        return { code: "session_busy", ok: false } as const;
      }

      const reserved = sessionDirectoryRecordSchema.parse({
        ...current.data,
        deleting: true,
        updatedAt: Date.now(),
      });
      await storage.put(sessionDeleteIntentKey(request.data.idempotencyKey), {
        expectedBranchRevision: request.data.expectedBranchRevision,
        idempotencyKey: request.data.idempotencyKey,
        sessionId: request.data.sessionId,
      });
      await storage.put(sessionRecordKey(reserved.sessionId), reserved);
      return { ok: true, record: reserved } as const;
    });

    if (!reservedDeletion.ok) {
      return {
        error: { code: reservedDeletion.code, message: "Session deletion denied." },
        ok: false,
      };
    }

    const idleRecord = reservedDeletion.record;

    const session = {
      branchId: idleRecord.branchId,
      branchRevision: idleRecord.branchRevision,
      sessionId: idleRecord.sessionId,
    };

    try {
      const child = this.#session(session);
      const deleted = await child.deleteSessionStorage({
        objectName: crewSessionObjectName({
          agentId: idleRecord.agentId,
          ownerKey: idleRecord.ownerKey,
          sessionId: idleRecord.sessionId,
        }),
      });

      if (!deleted) {
        throw new Error("Session runtime refused deletion.");
      }

      await this.ctx.storage.transaction(async (storage) => {
        const current = sessionDirectoryRecordSchema.safeParse(
          await storage.get(sessionRecordKey(idleRecord.sessionId)),
        );
        const intent = sessionDeleteIntentSchema.safeParse(
          await storage.get(sessionDeleteIntentKey(request.data.idempotencyKey)),
        );

        if (
          !current.success ||
          !current.data.deleting ||
          !intent.success ||
          intent.data.expectedBranchRevision !== request.data.expectedBranchRevision ||
          intent.data.idempotencyKey !== request.data.idempotencyKey ||
          intent.data.sessionId !== request.data.sessionId
        ) {
          throw new Error("Session deletion reservation changed.");
        }

        await storage.put(sessionDeleteKey(request.data.idempotencyKey), {
          deletedAt: Date.now(),
          expectedBranchRevision: request.data.expectedBranchRevision,
          sessionId: idleRecord.sessionId,
        });
        await storage.delete([
          sessionDeleteIntentKey(request.data.idempotencyKey),
          sessionRecordKey(idleRecord.sessionId),
        ]);
      });
    } catch {
      // The child may already be empty or finalization may have crashed. Keep the durable intent
      // sealed so only the exact idempotent request can resume deletion and finish owner cleanup.
      return {
        error: { code: "session_unavailable", message: "Session deletion denied." },
        ok: false,
      };
    }

    await this.#scheduleSessionCleanup();

    return deleteAgentSessionResultSchema.parse({
      deleted: true,
      ok: true,
      sessionId: idleRecord.sessionId,
    });
  }

  async cleanupExpiredSessions(): Promise<void> {
    if (!this.ctx.id.name?.startsWith("crew-agent:")) {
      return;
    }

    await this.#cleanupExpiredSessions();
    await this.#scheduleSessionCleanup();
  }

  async listAgentSessionRunIds(
    input: unknown,
  ): Promise<{ nextCursor: string | null; runIds: string[] } | null> {
    const request = listSessionRunIdsRequestSchema.safeParse(input);

    if (!request.success || !this.#directoryMatches(request.data)) {
      return null;
    }

    const prefix = sessionRunIndexPrefix(request.data.sessionId);
    const entries = await this.ctx.storage.list<boolean>({
      limit: SESSION_RUN_PAGE_SIZE,
      prefix,
      ...(request.data.cursor === undefined
        ? {}
        : { startAfter: sessionRunIndexKey(request.data.sessionId, request.data.cursor) }),
    });
    const runIds = [...entries.keys()].map((key) => key.slice(prefix.length));

    return {
      nextCursor: entries.size < SESSION_RUN_PAGE_SIZE ? null : (runIds.at(-1) ?? null),
      runIds,
    };
  }

  async #prepareSession(
    ownerKey: string,
    agentId: string,
    runId: string,
    deadlineAt: number,
    availableUntil: number,
    visible: boolean,
    continuation: SessionContinuation | undefined,
  ): Promise<
    | { mapping: RunSessionDirectoryRecord; ok: true }
    | { ok: false; result: AcceptRunAdmissionResult }
  > {
    if (!this.#directoryMatches({ agentId, ownerKey })) {
      return { ok: false, result: invalidAdmission };
    }

    const existingMapping = await this.#readRunSession(runId);

    if (existingMapping !== undefined) {
      return JSON.stringify(existingMapping.continuation ?? undefined) ===
        JSON.stringify(continuation)
        ? { mapping: existingMapping, ok: true }
        : { ok: false, result: invalidAdmission };
    }

    await this.#cleanupExpiredSessions();
    const currentTime = Date.now();
    let record: SessionDirectoryRecord;

    if (continuation === undefined) {
      if ((await this.#sessionRecords()).length >= MAXIMUM_AGENT_SESSIONS) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      record = sessionDirectoryRecordSchema.parse({
        activeRunId: runId,
        agentId,
        availableUntil,
        branchId: newBranchId(),
        branchRevision: 1,
        createdAt: currentTime,
        ownerKey,
        sessionId: newSessionId(),
        updatedAt: currentTime,
        visible,
      });
    } else {
      const current = await this.#readAvailableSession(continuation.sessionId);

      if (current === undefined || !current.visible) {
        return {
          ok: false,
          result: {
            error: { code: "session_not_found", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      if (current.deleting) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      if (await this.#reconcileActiveRun(current)) {
        return {
          ok: false,
          result: {
            error: { code: "session_busy", message: "Run admission denied." },
            ok: false,
          },
        };
      }

      const reservation = await this.ctx.storage.transaction(async (storage) => {
        const refreshed = sessionDirectoryRecordSchema.safeParse(
          await storage.get(sessionRecordKey(current.sessionId)),
        );

        if (
          !refreshed.success ||
          !refreshed.data.visible ||
          refreshed.data.availableUntil <= Date.now()
        ) {
          return { error: "session_not_found" as const };
        }

        if (refreshed.data.deleting || refreshed.data.activeRunId !== null) {
          return { error: "session_busy" as const };
        }

        if (
          refreshed.data.branchId !== continuation.branchId ||
          refreshed.data.branchRevision !== continuation.expectedBranchRevision
        ) {
          return { error: "branch_revision_conflict" as const };
        }

        const reservedRecord = sessionDirectoryRecordSchema.parse({
          ...refreshed.data,
          activeRunId: runId,
          availableUntil: Math.max(refreshed.data.availableUntil, availableUntil),
          branchRevision: refreshed.data.branchRevision + 1,
          updatedAt: currentTime,
        });
        const reservedMapping = runSessionDirectoryRecordSchema.parse({
          continuation,
          deadlineAt,
          previousRevision: refreshed.data.branchRevision,
          session: {
            branchId: reservedRecord.branchId,
            branchRevision: reservedRecord.branchRevision,
            sessionId: reservedRecord.sessionId,
          },
        });

        await storage.put({
          [runSessionKey(runId)]: reservedMapping,
          [sessionRunIndexKey(reservedRecord.sessionId, runId)]: true,
          [sessionRecordKey(reservedRecord.sessionId)]: reservedRecord,
        });
        return { mapping: reservedMapping };
      });

      if ("error" in reservation) {
        return {
          ok: false,
          result: {
            error: { code: reservation.error, message: "Run admission denied." },
            ok: false,
          },
        };
      }

      await this.#scheduleSessionCleanup();
      return { mapping: reservation.mapping, ok: true };
    }

    const mapping = runSessionDirectoryRecordSchema.parse({
      continuation: continuation ?? null,
      deadlineAt,
      previousRevision: 0,
      session: {
        branchId: record.branchId,
        branchRevision: record.branchRevision,
        sessionId: record.sessionId,
      },
    });

    await this.ctx.storage.put({
      [runSessionKey(runId)]: mapping,
      [sessionRunIndexKey(record.sessionId, runId)]: true,
      [sessionRecordKey(record.sessionId)]: record,
    });
    await this.#scheduleSessionCleanup();

    return { mapping, ok: true };
  }

  async #rollbackPreparedSession(runId: string, mapping: RunSessionDirectoryRecord): Promise<void> {
    const record = await this.#readSession(mapping.session.sessionId);

    if (record?.activeRunId !== runId) {
      return;
    }

    if (mapping.previousRevision === 0) {
      await this.ctx.storage.delete([
        runSessionKey(runId),
        sessionRunIndexKey(record.sessionId, runId),
        sessionRecordKey(record.sessionId),
      ]);
      return;
    }

    await this.ctx.storage.put(sessionRecordKey(record.sessionId), {
      ...record,
      activeRunId: null,
      branchRevision: mapping.previousRevision,
      updatedAt: Date.now(),
    });
    await this.ctx.storage.delete([
      runSessionKey(runId),
      sessionRunIndexKey(record.sessionId, runId),
    ]);
  }

  async #sessionForRunInput(input: unknown) {
    const runId =
      typeof input === "object" && input !== null && !Array.isArray(input)
        ? Reflect.get(Reflect.get(input, "capability") ?? {}, "runId")
        : undefined;
    const parsedRunId = runIdSchema.safeParse(runId);

    if (!parsedRunId.success) {
      return undefined;
    }

    const mapping = await this.#readRunSession(parsedRunId.data);

    if (mapping === undefined) {
      return undefined;
    }

    return this.#session(mapping.session);
  }

  #session(session: RunSession) {
    return this.sessionNamespace().getByName(
      crewSessionObjectName({
        agentId: this.#agentIdentity().agentId,
        ownerKey: this.#agentIdentity().ownerKey,
        sessionId: session.sessionId,
      }),
    );
  }

  #agentIdentity(): { agentId: string; ownerKey: string } {
    const match = /^crew-agent:([^:]+):(.+)$/.exec(this.ctx.id.name ?? "");

    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("CrewAgent session directory identity is invalid.");
    }

    return { agentId: match[2], ownerKey: match[1] };
  }

  #directoryMatches(input: { agentId: string; ownerKey: string }): boolean {
    return this.ctx.id.name === crewAgentObjectName(input);
  }

  async #readSession(sessionId: string): Promise<SessionDirectoryRecord | undefined> {
    const parsed = sessionDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(sessionRecordKey(sessionId)),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async #readAvailableSession(sessionId: string): Promise<SessionDirectoryRecord | undefined> {
    const record = await this.#readSession(sessionId);

    if (record === undefined || record.deleting || record.availableUntil > Date.now()) {
      return record;
    }

    await this.#deleteExpiredSession(record);
    return undefined;
  }

  async #readRunSession(runId: string): Promise<RunSessionDirectoryRecord | undefined> {
    const parsed = runSessionDirectoryRecordSchema.safeParse(
      await this.ctx.storage.get(runSessionKey(runId)),
    );
    return parsed.success ? parsed.data : undefined;
  }

  async #sessionRecords(): Promise<SessionDirectoryRecord[]> {
    const stored = await this.ctx.storage.list({ prefix: SESSION_RECORD_PREFIX });
    return [...stored.values()]
      .flatMap((value) => {
        const parsed = sessionDirectoryRecordSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  async #cleanupExpiredSessions(): Promise<void> {
    const currentTime = Date.now();
    const expired = (await this.#sessionRecords()).filter(
      (record) =>
        !record.deleting && record.availableUntil <= currentTime && record.activeRunId === null,
    );

    for (const record of expired) {
      await this.#deleteExpiredSession(record);
    }

    const deletions = await this.ctx.storage.list({ prefix: SESSION_DELETE_PREFIX });
    const expiredDeletions = [...deletions.entries()].flatMap(([key, value]) => {
      const parsed = sessionDeleteReceiptSchema.safeParse(value);
      return parsed.success &&
        parsed.data.deletedAt + DEFAULT_AGENT_SESSION_RETENTION_SECONDS * 1_000 <= currentTime
        ? [{ key, sessionId: parsed.data.sessionId }]
        : [];
    });

    for (const deletion of expiredDeletions) {
      await this.#deleteDirectorySession(deletion.sessionId);
      await this.ctx.storage.delete(deletion.key);
    }
  }

  async #scheduleSessionCleanup(): Promise<void> {
    const sessionExpiries = (await this.#sessionRecords())
      .filter((record) => !record.deleting && record.activeRunId === null)
      .map((record) => record.availableUntil);
    const deletionReceipts = await this.ctx.storage.list({ prefix: SESSION_DELETE_PREFIX });
    const deletionExpiries = [...deletionReceipts.values()].flatMap((value) => {
      const parsed = sessionDeleteReceiptSchema.safeParse(value);
      return parsed.success
        ? [parsed.data.deletedAt + DEFAULT_AGENT_SESSION_RETENTION_SECONDS * 1_000]
        : [];
    });
    const nextExpiry = [...sessionExpiries, ...deletionExpiries].toSorted(
      (left, right) => left - right,
    )[0];

    if (nextExpiry !== undefined) {
      await this.schedule(new Date(Math.max(Date.now() + 1, nextExpiry)), "cleanupExpiredSessions");
    }
  }

  async #deleteExpiredSession(record: SessionDirectoryRecord): Promise<void> {
    if (record.deleting) {
      return;
    }

    try {
      await this.#session({
        branchId: record.branchId,
        branchRevision: record.branchRevision,
        sessionId: record.sessionId,
      }).deleteSessionStorage({
        objectName: crewSessionObjectName({
          agentId: record.agentId,
          ownerKey: record.ownerKey,
          sessionId: record.sessionId,
        }),
      });
      await this.#deleteDirectorySession(record.sessionId);
    } catch {
      // Keep the directory record so a later access can retry exact cleanup.
    }
  }

  async #deleteDirectorySession(sessionId: string): Promise<void> {
    const prefix = sessionRunIndexPrefix(sessionId);

    for (;;) {
      const indexes = await this.ctx.storage.list<boolean>({
        limit: SESSION_RUN_PAGE_SIZE,
        prefix,
      });

      if (indexes.size === 0) {
        break;
      }

      const runKeys = [...indexes.keys()].map((key) => runSessionKey(key.slice(prefix.length)));
      await this.ctx.storage.delete([...indexes.keys(), ...runKeys]);
    }

    await this.ctx.storage.delete(sessionRecordKey(sessionId));
  }

  async #reconcileActiveRun(record: SessionDirectoryRecord): Promise<boolean> {
    if (record.activeRunId === null) {
      return false;
    }

    const session: RunSession = {
      branchId: record.branchId,
      branchRevision: record.branchRevision,
      sessionId: record.sessionId,
    };

    try {
      const status = await this.#session(session).inspectSessionRunState({
        runId: record.activeRunId,
        session,
      });

      if (status !== null && ["cancelled", "completed", "failed"].includes(status)) {
        return !(await this.#clearReconciledRun(record));
      }

      if (status === null) {
        const mapping = await this.#readRunSession(record.activeRunId);

        if (mapping !== undefined && Date.now() >= mapping.deadlineAt) {
          return !(await this.#clearReconciledRun(record));
        }
      }
    } catch {
      // Fail closed while the exact session runtime is unavailable.
    }

    return true;
  }

  async #clearReconciledRun(record: SessionDirectoryRecord): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const current = sessionDirectoryRecordSchema.safeParse(
        await storage.get(sessionRecordKey(record.sessionId)),
      );

      if (!current.success) {
        return false;
      }

      if (current.data.activeRunId === null) {
        return true;
      }

      if (
        current.data.activeRunId !== record.activeRunId ||
        current.data.branchRevision !== record.branchRevision ||
        current.data.deleting
      ) {
        return false;
      }

      await storage.put(sessionRecordKey(record.sessionId), {
        ...current.data,
        activeRunId: null,
        updatedAt: Date.now(),
      });
      return true;
    });
  }
}
