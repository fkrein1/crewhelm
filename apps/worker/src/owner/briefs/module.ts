import {
  MAXIMUM_BRIEF_CONTENT_BYTES,
  MAXIMUM_BRIEF_CONTEXT_BYTES,
  MAXIMUM_BRIEF_LIBRARY_BYTES,
  MAXIMUM_BRIEF_VERSIONS,
  MAXIMUM_BRIEFS_PER_OWNER,
  MAXIMUM_WORKFLOW_DELIVERABLE_BYTES,
  admittedBriefContextContentSchema,
  artifactIdSchema,
  briefContentRecordSchema,
  briefContentSchema,
  briefMediaTypeSchema,
  briefReferencesSchema,
  briefSummarySchema,
  briefVersionSchema,
  createBriefInputSchema,
  createBriefResultSchema,
  deleteBriefInputSchema,
  deleteBriefResultSchema,
  inspectBriefInputSchema,
  inspectBriefResultSchema,
  listBriefsInputSchema,
  listBriefsResultSchema,
  readBriefInputSchema,
  readBriefResultSchema,
  renderAdmittedBriefContext,
  reviseBriefInputSchema,
  reviseBriefResultSchema,
  workflowDeliverableSchema,
  type AdmittedBriefBlock,
  type AdmittedBriefContext,
  type AdmittedBriefContextContent,
  type BriefReference,
  type BriefSummary,
  type CreateBriefResult,
  type DeleteBriefResult,
  type InspectBriefResult,
  type ListBriefsResult,
  type OwnerAuthority,
  type ReadBriefResult,
  type ReviseBriefResult,
  type WorkflowDeliverable,
} from "@crewhelm/contracts";
import { and, asc, count, eq, gt, isNotNull, sql, sum } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentWorkflows,
  auditEvents,
  briefDeletions,
  briefMutations,
  briefs,
  briefVersions,
  runAdmissions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type BriefFailureCode = Extract<CreateBriefResult, { ok: false }>["error"]["code"];
type StoredBriefVersion = typeof briefVersions.$inferSelect;

export interface StoredOwnerContent {
  bytes: Uint8Array;
  digest: string;
  mediaType: string;
}

export interface OwnerContentObjectStore {
  delete(key: string, digest: string): Promise<"deleted" | "missing" | "conflict">;
  get(key: string, maximumBytes: number): Promise<StoredOwnerContent | null>;
  put(
    key: string,
    bytes: Uint8Array,
    digest: string,
    mediaType: string,
  ): Promise<"created" | "existing" | "conflict">;
}

export interface WorkflowDeliverableStorage {
  prepareWorkflowDeliverable(input: {
    content: string;
    createdAt: string;
    runId: string;
    stageIndex: number;
    truncated: boolean;
    workflowId: string;
  }): Promise<
    | { content: string; deliverable: WorkflowDeliverable; objectKey: string; ok: true }
    | { code: "storage_corrupt" | "storage_unavailable"; ok: false }
  >;
  commitWorkflowDeliverable(input: {
    content: string;
    deliverable: WorkflowDeliverable;
    objectKey: string;
  }): Promise<{ ok: true } | { code: "storage_corrupt" | "storage_unavailable"; ok: false }>;
  deleteWorkflowDeliverable(objectKey: string, deliverable: WorkflowDeliverable): Promise<boolean>;
  readWorkflowDeliverable(
    objectKey: string,
    deliverable: WorkflowDeliverable,
  ): Promise<string | null>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const suspectedSecretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=/]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
] as const;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digests(bytes: Uint8Array): Promise<{ base64Url: string; hex: string }> {
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { base64Url: encodeBase64Url(hashed), hex: encodeHex(hashed) };
}

async function requestDigest(input: unknown): Promise<string> {
  return (await digests(encoder.encode(JSON.stringify(input)))).base64Url;
}

async function deterministicUuid(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(seed))).slice(
    0,
    16,
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = encodeHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function denied(code: BriefFailureCode, nextAction?: "contact_operator" | "retry_same_request") {
  return {
    error: {
      code,
      message: "Brief request denied." as const,
      ...(nextAction === undefined ? {} : { operation: { nextAction } }),
    },
    ok: false as const,
  };
}

export function deniedBrief(code: BriefFailureCode) {
  return denied(code);
}

function escapedNamePattern(name: string): string {
  return `%${name.toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

function validatesMediaType(content: string, mediaType: string): boolean {
  if (mediaType !== "application/json") return true;
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

const credentialJsonKeyNames = [
  "access_token",
  "api_key",
  "api_secret",
  "auth_token",
  "bearer_token",
  "client_key",
  "client_secret",
  "credential",
  "credentials",
  "password",
  "passphrase",
  "passwd",
  "private_key",
  "refresh_token",
  "secret",
  "secret_key",
  "signing_key",
  "token",
] as const;

function isCredentialJsonKey(key: string): boolean {
  const normalized = key
    .trim()
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z\d]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return credentialJsonKeyNames.some(
    (name) => normalized === name || normalized.endsWith(`_${name}`),
  );
}

function jsonHasSuspectedSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => jsonHasSuspectedSecret(item));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      (isCredentialJsonKey(key) && typeof nested === "string" && nested.length > 0) ||
      jsonHasSuspectedSecret(nested),
  );
}

function hasSuspectedSecret(content: string, mediaType: string): boolean {
  if (suspectedSecretPatterns.some((pattern) => pattern.test(content))) return true;
  if (mediaType !== "application/json") return false;
  try {
    return jsonHasSuspectedSecret(JSON.parse(content));
  } catch {
    return false;
  }
}

export class Briefs implements WorkflowDeliverableStorage {
  readonly #database: Database;
  readonly #objectStore: OwnerContentObjectStore;
  readonly #ownerKey: string | undefined;

  constructor(
    database: Database,
    objectStore: OwnerContentObjectStore,
    ownerKey: string | undefined,
  ) {
    this.#database = database;
    this.#objectStore = objectStore;
    this.#ownerKey = ownerKey;
  }

  async create(authority: OwnerAuthority, input: unknown): Promise<CreateBriefResult> {
    const request = createBriefInputSchema.safeParse(input);
    if (!request.success || this.#ownerKey === undefined) return denied("invalid_request");
    if (!validatesMediaType(request.data.content, request.data.mediaType)) {
      return denied("invalid_request");
    }
    if (hasSuspectedSecret(request.data.content, request.data.mediaType)) {
      return denied("suspected_secret");
    }

    const mutationDigest = await requestDigest(request.data);
    const replay = this.#mutationReplay(authority, request.data.idempotencyKey, mutationDigest);
    if (replay !== null) return createBriefResultSchema.parse(replay);

    const briefId = `brief_${await deterministicUuid(
      `${this.#ownerKey}:${authority.clientId}:${request.data.idempotencyKey}`,
    )}`;
    const prepared = await this.#prepareContent(request.data.content);
    const objectKey = `briefs/${this.#ownerKey}/${briefId}/1`;
    const candidate = this.#validateCreate(request.data.name, prepared.bytes.byteLength);
    if (!candidate.ok) return createBriefResultSchema.parse(candidate);

    const stored = await this.#put(
      objectKey,
      prepared.bytes,
      prepared.digest,
      request.data.mediaType,
    );
    if (!stored.ok) return createBriefResultSchema.parse(stored.result);

    try {
      const result = this.#database.transaction((transaction) => {
        const concurrent = this.#mutationReplay(
          authority,
          request.data.idempotencyKey,
          mutationDigest,
          transaction,
        );
        if (concurrent !== null) return concurrent;
        const revalidated = this.#validateCreate(
          request.data.name,
          prepared.bytes.byteLength,
          transaction,
        );
        if (!revalidated.ok) return revalidated;

        const now = Date.now();
        transaction
          .insert(briefs)
          .values({
            briefId,
            createdAt: now,
            currentRevision: 1,
            name: request.data.name,
            status: "active",
            updatedAt: now,
          })
          .run();
        transaction
          .insert(briefVersions)
          .values({
            briefId,
            createdAt: now,
            digest: prepared.digest,
            mediaType: request.data.mediaType,
            objectKey,
            revision: 1,
            sizeBytes: prepared.bytes.byteLength,
          })
          .run();
        transaction
          .insert(briefMutations)
          .values({
            briefId,
            clientId: authority.clientId,
            idempotencyKey: request.data.idempotencyKey,
            operation: "create",
            requestDigest: mutationDigest,
            revision: 1,
          })
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "brief.created",
            clientId: authority.clientId,
            occurredAt: now,
            subjectId: briefId,
          })
          .run();
        return this.#mutationResult(briefId, 1, true, transaction);
      });
      if (!result.ok && stored.disposition === "created") {
        try {
          if ((await this.#objectStore.delete(objectKey, prepared.digest)) === "conflict") {
            return createBriefResultSchema.parse(
              denied("brief_storage_corrupt", "contact_operator"),
            );
          }
        } catch {
          return createBriefResultSchema.parse(
            denied("brief_storage_unavailable", "retry_same_request"),
          );
        }
      }
      return createBriefResultSchema.parse(result);
    } catch {
      if (
        !(await this.#cleanupUncommittedVersion(
          briefId,
          1,
          objectKey,
          prepared.digest,
          stored.disposition,
        ))
      ) {
        return createBriefResultSchema.parse(
          denied("brief_storage_unavailable", "retry_same_request"),
        );
      }
      return createBriefResultSchema.parse(
        denied("brief_storage_unavailable", "retry_same_request"),
      );
    }
  }

  async revise(authority: OwnerAuthority, input: unknown): Promise<ReviseBriefResult> {
    const request = reviseBriefInputSchema.safeParse(input);
    if (!request.success || this.#ownerKey === undefined) return denied("invalid_request");
    if (!validatesMediaType(request.data.content, request.data.mediaType)) {
      return denied("invalid_request");
    }
    if (hasSuspectedSecret(request.data.content, request.data.mediaType)) {
      return denied("suspected_secret");
    }

    const mutationDigest = await requestDigest(request.data);
    const replay = this.#mutationReplay(authority, request.data.idempotencyKey, mutationDigest);
    if (replay !== null) return reviseBriefResultSchema.parse(replay);
    const prepared = await this.#prepareContent(request.data.content);
    const candidate = this.#validateRevision(
      request.data,
      prepared.digest,
      prepared.bytes.byteLength,
    );
    if (!candidate.ok) return reviseBriefResultSchema.parse(candidate);
    const revision = request.data.expectedRevision + 1;
    const objectKey = `briefs/${this.#ownerKey}/${request.data.id}/${revision}`;
    const stored = await this.#put(
      objectKey,
      prepared.bytes,
      prepared.digest,
      request.data.mediaType,
    );
    if (!stored.ok) return reviseBriefResultSchema.parse(stored.result);

    try {
      const result = this.#database.transaction((transaction) => {
        const concurrent = this.#mutationReplay(
          authority,
          request.data.idempotencyKey,
          mutationDigest,
          transaction,
        );
        if (concurrent !== null) return concurrent;
        const revalidated = this.#validateRevision(
          request.data,
          prepared.digest,
          prepared.bytes.byteLength,
          transaction,
        );
        if (!revalidated.ok) return revalidated;

        const now = Date.now();
        transaction
          .insert(briefVersions)
          .values({
            briefId: request.data.id,
            createdAt: now,
            digest: prepared.digest,
            mediaType: request.data.mediaType,
            objectKey,
            revision,
            sizeBytes: prepared.bytes.byteLength,
          })
          .run();
        transaction
          .update(briefs)
          .set({ currentRevision: revision, updatedAt: now })
          .where(eq(briefs.briefId, request.data.id))
          .run();
        transaction
          .insert(briefMutations)
          .values({
            briefId: request.data.id,
            clientId: authority.clientId,
            idempotencyKey: request.data.idempotencyKey,
            operation: "revise",
            requestDigest: mutationDigest,
            revision,
          })
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "brief.revised",
            clientId: authority.clientId,
            occurredAt: now,
            subjectId: request.data.id,
          })
          .run();
        return this.#mutationResult(request.data.id, revision, true, transaction);
      });
      if (
        !result.ok &&
        !(await this.#cleanupUncommittedVersion(
          request.data.id,
          revision,
          objectKey,
          prepared.digest,
          stored.disposition,
        ))
      ) {
        return reviseBriefResultSchema.parse(
          denied("brief_storage_unavailable", "retry_same_request"),
        );
      }
      return reviseBriefResultSchema.parse(result);
    } catch {
      if (
        !(await this.#cleanupUncommittedVersion(
          request.data.id,
          revision,
          objectKey,
          prepared.digest,
          stored.disposition,
        ))
      ) {
        return reviseBriefResultSchema.parse(
          denied("brief_storage_unavailable", "retry_same_request"),
        );
      }
      return reviseBriefResultSchema.parse(
        denied("brief_storage_unavailable", "retry_same_request"),
      );
    }
  }

  list(input: unknown): ListBriefsResult {
    const request = listBriefsInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const rows = this.#database
      .select({ id: briefs.briefId })
      .from(briefs)
      .where(
        and(
          request.data.cursor === undefined ? undefined : gt(briefs.briefId, request.data.cursor),
          request.data.name === undefined
            ? undefined
            : sql`lower(${briefs.name}) LIKE ${escapedNamePattern(request.data.name)} ESCAPE '!'`,
        ),
      )
      .orderBy(asc(briefs.briefId))
      .limit(request.data.limit + 1)
      .all();
    const page = rows.slice(0, request.data.limit);
    return listBriefsResultSchema.parse({
      briefs: page.flatMap(({ id }) => {
        const summary = this.#summary(id);
        return summary === null ? [] : [summary];
      }),
      nextCursor: rows.length > page.length ? (page.at(-1)?.id ?? null) : null,
      ok: true,
    });
  }

  inspect(input: unknown): InspectBriefResult {
    const request = inspectBriefInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const summary = this.#summary(request.data.id);
    if (summary === null || summary.status !== "active") return denied("brief_not_found");
    const revision = request.data.revision ?? summary.currentRevision;
    const version = this.#version(request.data.id, revision);
    return version === null
      ? denied("brief_not_found")
      : inspectBriefResultSchema.parse({ brief: summary, ok: true, version });
  }

  async read(input: unknown): Promise<ReadBriefResult> {
    const request = readBriefInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const inspected = this.inspect(request.data);
    if (!inspected.ok) return inspected;
    const row = this.#versionRow(request.data.id, request.data.revision);
    if (row === undefined) return denied("brief_not_found");
    const loaded = await this.#load(row);
    if (!loaded.ok) return readBriefResultSchema.parse(loaded.result);
    return readBriefResultSchema.parse({
      brief: inspected.brief,
      content: briefContentRecordSchema.parse({ ...inspected.version, content: loaded.content }),
      ok: true,
    });
  }

  async materialize(
    references: BriefReference[] | undefined,
  ): Promise<
    | { context: AdmittedBriefContextContent | undefined; ok: true }
    | { code: "brief_context_too_large" | "brief_unavailable"; ok: false }
  > {
    const parsed = briefReferencesSchema.safeParse(references ?? []);
    if (!parsed.success) return { code: "brief_unavailable", ok: false };
    if (parsed.data.length === 0) return { context: undefined, ok: true };
    const blocks: AdmittedBriefBlock[] = [];

    for (const reference of parsed.data) {
      const summary = this.#summary(reference.id);
      const row = this.#versionRow(reference.id, reference.revision);
      if (summary?.status !== "active" || row === undefined) {
        return { code: "brief_unavailable", ok: false };
      }
      const loaded = await this.#load(row);
      if (!loaded.ok) return { code: "brief_unavailable", ok: false };
      blocks.push({
        content: loaded.content,
        contentTrust: "untrusted",
        digest: row.digest,
        id: row.briefId,
        mediaType: row.mediaType,
        name: summary.name,
        revision: row.revision,
        sizeBytes: row.sizeBytes,
      });
    }

    const rendered = renderAdmittedBriefContext(blocks);
    const bytes = encoder.encode(rendered);
    if (bytes.byteLength > MAXIMUM_BRIEF_CONTEXT_BYTES) {
      return { code: "brief_context_too_large", ok: false };
    }
    const digest = (await digests(bytes)).hex;
    return {
      context: admittedBriefContextContentSchema.parse({
        blocks,
        characters: rendered.length,
        digest,
        references: blocks.map(
          ({ content: _content, contentTrust: _trust, ...reference }) => reference,
        ),
        sizeBytes: bytes.byteLength,
      }),
      ok: true,
    };
  }

  validateFrozen(
    context: AdmittedBriefContext | undefined,
    database: Database = this.#database,
  ): boolean {
    if (context === undefined) return true;

    return context.references.every((reference) => {
      const row = database
        .select({ brief: briefs, version: briefVersions })
        .from(briefs)
        .innerJoin(
          briefVersions,
          and(
            eq(briefVersions.briefId, briefs.briefId),
            eq(briefVersions.revision, reference.revision),
          ),
        )
        .where(and(eq(briefs.briefId, reference.id), eq(briefs.status, "active")))
        .get();

      return (
        row !== undefined &&
        row.brief.name === reference.name &&
        row.version.digest === reference.digest &&
        row.version.mediaType === reference.mediaType &&
        row.version.sizeBytes === reference.sizeBytes
      );
    });
  }

  async delete(authority: OwnerAuthority, input: unknown): Promise<DeleteBriefResult> {
    const request = deleteBriefInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const digest = await requestDigest(request.data);
    const replay = this.#database
      .select()
      .from(briefDeletions)
      .where(
        and(
          eq(briefDeletions.clientId, authority.clientId),
          eq(briefDeletions.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();
    if (replay !== undefined) {
      if (replay.requestDigest !== digest || replay.briefId !== request.data.id) {
        return denied("idempotency_conflict");
      }
      return this.#finishDelete(authority.clientId, request.data.id);
    }
    try {
      const sealed = this.#database.transaction((transaction) => {
        const concurrentReplay = transaction
          .select()
          .from(briefDeletions)
          .where(
            and(
              eq(briefDeletions.clientId, authority.clientId),
              eq(briefDeletions.idempotencyKey, request.data.idempotencyKey),
            ),
          )
          .get();
        if (concurrentReplay !== undefined) {
          return concurrentReplay.requestDigest === digest &&
            concurrentReplay.briefId === request.data.id
            ? { ok: true as const, replay: true as const }
            : denied("idempotency_conflict");
        }
        if (
          transaction
            .select({ id: briefDeletions.briefId })
            .from(briefDeletions)
            .where(eq(briefDeletions.briefId, request.data.id))
            .get() !== undefined
        ) {
          return denied("brief_deleted");
        }
        const summary = this.#summary(request.data.id, transaction);
        if (summary === null) return denied("brief_not_found");
        if (summary.currentRevision !== request.data.expectedRevision) {
          return denied("revision_conflict");
        }
        if (this.#isReferenced(request.data.id, transaction)) return denied("brief_busy");

        const now = Date.now();
        transaction
          .update(briefs)
          .set({ deletingAt: now, status: "deleting", updatedAt: now })
          .where(eq(briefs.briefId, request.data.id))
          .run();
        transaction
          .insert(briefDeletions)
          .values({
            briefId: request.data.id,
            clientId: authority.clientId,
            deletedAt: now,
            expectedRevision: request.data.expectedRevision,
            idempotencyKey: request.data.idempotencyKey,
            requestDigest: digest,
          })
          .run();
        return { ok: true as const, replay: false as const };
      });
      if (!sealed.ok) return deleteBriefResultSchema.parse(sealed);
    } catch {
      return denied("brief_storage_unavailable", "retry_same_request");
    }
    return this.#finishDelete(authority.clientId, request.data.id);
  }

  async prepareWorkflowDeliverable(input: {
    content: string;
    createdAt: string;
    runId: string;
    stageIndex: number;
    truncated: boolean;
    workflowId: string;
  }): Promise<
    | { content: string; deliverable: WorkflowDeliverable; objectKey: string; ok: true }
    | { code: "storage_corrupt" | "storage_unavailable"; ok: false }
  > {
    if (this.#ownerKey === undefined) return { code: "storage_unavailable", ok: false };
    const bytes = encoder.encode(input.content);
    if (bytes.byteLength > MAXIMUM_WORKFLOW_DELIVERABLE_BYTES) {
      return { code: "storage_corrupt", ok: false };
    }
    const digest = (await digests(bytes)).hex;
    const artifactId = artifactIdSchema.parse(input.workflowId.replace("workflow_", "artifact_"));
    const objectKey = `deliverables/${this.#ownerKey}/${input.workflowId}`;
    return {
      content: input.content,
      deliverable: workflowDeliverableSchema.parse({
        artifactId,
        createdAt: input.createdAt,
        digest,
        mediaType: "text/markdown",
        runId: input.runId,
        sizeBytes: bytes.byteLength,
        stageIndex: input.stageIndex,
        truncated: input.truncated,
      }),
      objectKey,
      ok: true,
    };
  }

  async commitWorkflowDeliverable(input: {
    content: string;
    deliverable: WorkflowDeliverable;
    objectKey: string;
  }): Promise<{ ok: true } | { code: "storage_corrupt" | "storage_unavailable"; ok: false }> {
    const bytes = encoder.encode(input.content);
    if (
      bytes.byteLength !== input.deliverable.sizeBytes ||
      (await digests(bytes)).hex !== input.deliverable.digest
    ) {
      return { code: "storage_corrupt", ok: false };
    }
    const stored = await this.#put(
      input.objectKey,
      bytes,
      input.deliverable.digest,
      input.deliverable.mediaType,
    );
    if (stored.ok) return { ok: true };
    return {
      code:
        stored.result.error.code === "brief_storage_corrupt"
          ? "storage_corrupt"
          : "storage_unavailable",
      ok: false,
    };
  }

  async readWorkflowDeliverable(
    objectKey: string,
    deliverable: WorkflowDeliverable,
  ): Promise<string | null> {
    try {
      const stored = await this.#objectStore.get(objectKey, MAXIMUM_WORKFLOW_DELIVERABLE_BYTES);
      if (
        stored === null ||
        stored.digest !== deliverable.digest ||
        stored.mediaType !== deliverable.mediaType ||
        stored.bytes.byteLength !== deliverable.sizeBytes
      ) {
        return null;
      }
      return decoder.decode(stored.bytes);
    } catch {
      return null;
    }
  }

  async deleteWorkflowDeliverable(
    objectKey: string,
    deliverable: WorkflowDeliverable,
  ): Promise<boolean> {
    try {
      return (await this.#objectStore.delete(objectKey, deliverable.digest)) !== "conflict";
    } catch {
      return false;
    }
  }

  usage(): { active: number; storedBytes: number; total: number; versions: number } {
    const briefCounts = this.#database
      .select({
        active: count(sql`CASE WHEN ${briefs.status} = 'active' THEN 1 END`),
        total: count(),
      })
      .from(briefs)
      .get();
    const versionCounts = this.#database
      .select({ storedBytes: sum(briefVersions.sizeBytes).mapWith(Number), versions: count() })
      .from(briefVersions)
      .get();
    return {
      active: briefCounts?.active ?? 0,
      storedBytes: versionCounts?.storedBytes ?? 0,
      total: briefCounts?.total ?? 0,
      versions: versionCounts?.versions ?? 0,
    };
  }

  async #prepareContent(content: string): Promise<{ bytes: Uint8Array; digest: string }> {
    const bytes = encoder.encode(content);
    return { bytes, digest: (await digests(bytes)).hex };
  }

  async #put(key: string, bytes: Uint8Array, digest: string, mediaType: string) {
    try {
      const stored = await this.#objectStore.put(key, bytes, digest, mediaType);
      return stored === "conflict"
        ? { ok: false as const, result: denied("brief_storage_corrupt", "contact_operator") }
        : { disposition: stored, ok: true as const };
    } catch {
      return {
        ok: false as const,
        result: denied("brief_storage_unavailable", "retry_same_request"),
      };
    }
  }

  async #load(row: StoredBriefVersion) {
    let stored: StoredOwnerContent | null;
    try {
      stored = await this.#objectStore.get(row.objectKey, MAXIMUM_BRIEF_CONTENT_BYTES);
    } catch {
      return {
        ok: false as const,
        result: denied("brief_storage_unavailable", "retry_same_request"),
      };
    }
    if (
      stored === null ||
      stored.digest !== row.digest ||
      stored.mediaType !== row.mediaType ||
      stored.bytes.byteLength !== row.sizeBytes
    ) {
      return { ok: false as const, result: denied("brief_storage_corrupt", "contact_operator") };
    }
    let content: string;
    try {
      content = decoder.decode(stored.bytes);
    } catch {
      return { ok: false as const, result: denied("brief_storage_corrupt", "contact_operator") };
    }
    if (
      !briefContentSchema.safeParse(content).success ||
      !briefMediaTypeSchema.safeParse(row.mediaType).success ||
      !validatesMediaType(content, row.mediaType)
    ) {
      return { ok: false as const, result: denied("brief_storage_corrupt", "contact_operator") };
    }
    return { content, ok: true as const };
  }

  async #cleanupUncommittedVersion(
    briefId: string,
    revision: number,
    objectKey: string,
    digest: string,
    disposition: "created" | "existing",
  ): Promise<boolean> {
    if (disposition !== "created") return true;
    const committed = this.#versionRow(briefId, revision);
    if (committed?.objectKey === objectKey && committed.digest === digest) return true;
    try {
      return (await this.#objectStore.delete(objectKey, digest)) !== "conflict";
    } catch {
      return false;
    }
  }

  #validateCreate(name: string, sizeBytes: number, database: Database = this.#database) {
    if (
      (database.select({ value: count() }).from(briefs).get()?.value ?? 0) >=
      MAXIMUM_BRIEFS_PER_OWNER
    ) {
      return denied("quota_exceeded");
    }
    if (
      database
        .select({ id: briefs.briefId })
        .from(briefs)
        .where(and(eq(briefs.name, name), eq(briefs.status, "active")))
        .get() !== undefined
    ) {
      return denied("revision_conflict");
    }
    const stored =
      database
        .select({ value: sum(briefVersions.sizeBytes).mapWith(Number) })
        .from(briefVersions)
        .get()?.value ?? 0;
    return stored + sizeBytes > MAXIMUM_BRIEF_LIBRARY_BYTES
      ? denied("quota_exceeded")
      : { ok: true as const };
  }

  #validateRevision(
    input: ReturnType<typeof reviseBriefInputSchema.parse>,
    digest: string,
    sizeBytes: number,
    database: Database = this.#database,
  ) {
    const summary = this.#summary(input.id, database);
    if (summary === null || summary.status !== "active") return denied("brief_not_found");
    if (summary.currentRevision !== input.expectedRevision) return denied("revision_conflict");
    if (summary.currentRevision >= MAXIMUM_BRIEF_VERSIONS) return denied("quota_exceeded");
    if (summary.current.digest === digest && summary.current.mediaType === input.mediaType) {
      return denied("no_changes");
    }
    const stored =
      database
        .select({ value: sum(briefVersions.sizeBytes).mapWith(Number) })
        .from(briefVersions)
        .get()?.value ?? 0;
    return stored + sizeBytes > MAXIMUM_BRIEF_LIBRARY_BYTES
      ? denied("quota_exceeded")
      : { ok: true as const };
  }

  #mutationReplay(
    authority: OwnerAuthority,
    idempotencyKey: string,
    digest: string,
    database: Database = this.#database,
  ) {
    const mutation = database
      .select()
      .from(briefMutations)
      .where(
        and(
          eq(briefMutations.clientId, authority.clientId),
          eq(briefMutations.idempotencyKey, idempotencyKey),
        ),
      )
      .get();
    if (mutation === undefined) return null;
    if (mutation.requestDigest !== digest) return denied("idempotency_conflict");
    const result = this.#mutationResult(mutation.briefId, mutation.revision, false, database);
    return result.ok ? result : denied("brief_deleted");
  }

  #mutationResult(
    id: string,
    revision: number,
    applied: boolean,
    database: Database = this.#database,
  ) {
    const summary = this.#summary(id, database);
    const version = this.#version(id, revision, database);
    return summary === null || version === null
      ? denied("brief_deleted")
      : { applied, brief: summary, ok: true as const, version };
  }

  #summary(id: string, database: Database = this.#database): BriefSummary | null {
    const row = database
      .select({ brief: briefs, version: briefVersions })
      .from(briefs)
      .innerJoin(
        briefVersions,
        and(
          eq(briefVersions.briefId, briefs.briefId),
          eq(briefVersions.revision, briefs.currentRevision),
        ),
      )
      .where(eq(briefs.briefId, id))
      .get();
    if (row === undefined) return null;
    const versionCount =
      database
        .select({ value: count() })
        .from(briefVersions)
        .where(eq(briefVersions.briefId, id))
        .get()?.value ?? 0;
    return briefSummarySchema.parse({
      createdAt: new Date(row.brief.createdAt).toISOString(),
      current: this.#versionSummary(row.version),
      currentRevision: row.brief.currentRevision,
      id: row.brief.briefId,
      name: row.brief.name,
      status: row.brief.status,
      updatedAt: new Date(row.brief.updatedAt).toISOString(),
      versionCount,
    });
  }

  #version(id: string, revision: number, database: Database = this.#database) {
    const row = database
      .select()
      .from(briefVersions)
      .where(and(eq(briefVersions.briefId, id), eq(briefVersions.revision, revision)))
      .get();
    const summary = this.#summaryName(id, database);
    return row === undefined || summary === undefined
      ? null
      : briefVersionSchema.parse({
          ...this.#versionSummary(row),
          contentTrust: "untrusted",
          id,
          name: summary.name,
        });
  }

  #versionSummary(row: StoredBriefVersion) {
    return {
      createdAt: new Date(row.createdAt).toISOString(),
      digest: row.digest,
      mediaType: row.mediaType,
      revision: row.revision,
      sizeBytes: row.sizeBytes,
    };
  }

  #summaryName(id: string, database: Database = this.#database) {
    return database.select({ name: briefs.name }).from(briefs).where(eq(briefs.briefId, id)).get();
  }

  #versionRow(id: string, revision: number, database: Database = this.#database) {
    return database
      .select()
      .from(briefVersions)
      .where(and(eq(briefVersions.briefId, id), eq(briefVersions.revision, revision)))
      .get();
  }

  #isReferenced(id: string, database: Database = this.#database): boolean {
    const runRows = database
      .select({ context: runAdmissions.briefContext })
      .from(runAdmissions)
      .where(isNotNull(runAdmissions.briefContext))
      .all();
    const workflowRows = database
      .select({ context: agentWorkflows.briefContext })
      .from(agentWorkflows)
      .where(isNotNull(agentWorkflows.briefContext))
      .all();
    return [...runRows, ...workflowRows].some(
      ({ context }) => context?.references.some((reference) => reference.id === id) === true,
    );
  }

  async #finishDelete(clientId: string, id: string): Promise<DeleteBriefResult> {
    const summary = this.#summary(id);
    if (summary === null) return deleteBriefResultSchema.parse({ deleted: true, id, ok: true });
    if (summary.status !== "deleting" || this.#isReferenced(id)) return denied("brief_busy");
    const versions = this.#database
      .select()
      .from(briefVersions)
      .where(eq(briefVersions.briefId, id))
      .all();
    for (const version of versions) {
      try {
        if ((await this.#objectStore.delete(version.objectKey, version.digest)) === "conflict") {
          return denied("brief_storage_corrupt", "contact_operator");
        }
      } catch {
        return denied("brief_storage_unavailable", "retry_same_request");
      }
    }
    try {
      this.#database.transaction((transaction) => {
        transaction.delete(briefs).where(eq(briefs.briefId, id)).run();
        transaction
          .insert(auditEvents)
          .values({ action: "brief.deleted", clientId, occurredAt: Date.now(), subjectId: id })
          .run();
      });
    } catch {
      return denied("brief_storage_unavailable", "retry_same_request");
    }
    return deleteBriefResultSchema.parse({ deleted: true, id, ok: true });
  }
}
