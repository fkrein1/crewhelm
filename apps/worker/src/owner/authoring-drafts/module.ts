import {
  canonicalJson,
  jsonValueSchema,
  MAXIMUM_MCP_AUTHORING_DRAFT_BYTES,
  MAXIMUM_MCP_AUTHORING_DRAFTS,
  MCP_AUTHORING_DRAFT_TTL_SECONDS,
  mcpAuthoringDraftInputSchema,
  mcpAuthoringDraftResultSchema,
  publishAgentBlueprintInputSchema,
  publishSkillInputSchema,
  recipePreviewRequestSchema,
  recipePublicationCandidateSchema,
  type JsonValue,
  type McpAuthoringDraftInput,
  type McpAuthoringDraftKind,
  type McpAuthoringDraftLocator,
  type McpAuthoringDraftReference,
  type McpAuthoringDraftResult,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { and, count, eq, lte } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { mcpAuthoringDrafts, type ControlPlaneDatabaseSchema } from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type FailureCode = Extract<McpAuthoringDraftResult, { ok: false }>["error"]["code"];

const encoder = new TextEncoder();

function denied(code: FailureCode): McpAuthoringDraftResult {
  return {
    error: { code, message: "MCP authoring draft request denied." },
    ok: false,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value: JsonValue): Promise<string> {
  const bytes = encoder.encode(canonicalJson(value));
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function validatedContent(kind: McpAuthoringDraftKind, content: unknown): JsonValue | null {
  const parsed = (() => {
    switch (kind) {
      case "agent-blueprint-package":
        return publishAgentBlueprintInputSchema.safeParse({ mode: "preview", target: content })
          .success
          ? { success: true as const, data: content }
          : { success: false as const };
      case "recipe-installation":
        return recipePreviewRequestSchema.safeParse(content);
      case "recipe-publication":
        return recipePublicationCandidateSchema.safeParse(content);
      case "skill-package":
        return publishSkillInputSchema.safeParse({ mode: "preview", target: content }).success
          ? { success: true as const, data: content }
          : { success: false as const };
      default:
        return { success: false as const };
    }
  })();

  return parsed.success ? jsonValueSchema.parse(parsed.data) : null;
}

function reference(row: typeof mcpAuthoringDrafts.$inferSelect): McpAuthoringDraftReference {
  return {
    digest: row.contentDigest,
    expiresAt: new Date(row.expiresAt).toISOString(),
    id: row.draftId,
    kind: row.kind,
    revision: row.revision,
  };
}

export class McpAuthoringDrafts {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async handle(authority: OwnerAuthority, input: unknown): Promise<McpAuthoringDraftResult> {
    const request = mcpAuthoringDraftInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");

    try {
      this.#deleteExpired(Date.now());

      switch (request.data.action) {
        case "create":
          return await this.#create(authority, request.data);
        case "read":
          return this.#read(authority, request.data.draft);
        case "replace":
          return await this.#replace(authority, request.data);
        case "discard":
          return this.#discard(authority, request.data.draft);
      }
      return denied("invalid_request");
    } catch {
      return denied("storage_unavailable");
    }
  }

  #deleteExpired(now: number): void {
    this.#database.delete(mcpAuthoringDrafts).where(lte(mcpAuthoringDrafts.expiresAt, now)).run();
  }

  async #create(
    authority: OwnerAuthority,
    input: Extract<McpAuthoringDraftInput, { action: "create" }>,
  ): Promise<McpAuthoringDraftResult> {
    const content = validatedContent(input.kind, input.content);
    if (content === null) return denied("invalid_request");
    const canonical = canonicalJson(content);
    const sizeBytes = encoder.encode(canonical).byteLength;
    if (sizeBytes > MAXIMUM_MCP_AUTHORING_DRAFT_BYTES) return denied("invalid_request");
    const [requestDigest, contentDigest] = await Promise.all([
      digest(jsonValueSchema.parse({ content, kind: input.kind })),
      digest(content),
    ]);
    const replay = this.#database
      .select()
      .from(mcpAuthoringDrafts)
      .where(
        and(
          eq(mcpAuthoringDrafts.clientId, authority.clientId),
          eq(mcpAuthoringDrafts.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get();
    if (replay !== undefined) {
      return replay.requestDigest === requestDigest
        ? mcpAuthoringDraftResultSchema.parse({
            action: "create",
            draft: reference(replay),
            ok: true,
            replayed: true,
          })
        : denied("idempotency_conflict");
    }
    const activeCount =
      this.#database.select({ value: count() }).from(mcpAuthoringDrafts).get()?.value ?? 0;
    if (activeCount >= MAXIMUM_MCP_AUTHORING_DRAFTS) return denied("draft_limit_exceeded");
    const now = Date.now();
    const row: typeof mcpAuthoringDrafts.$inferInsert = {
      clientId: authority.clientId,
      content,
      contentDigest,
      createdAt: now,
      draftId: `mcp_draft_${crypto.randomUUID()}`,
      expiresAt: now + MCP_AUTHORING_DRAFT_TTL_SECONDS * 1_000,
      idempotencyKey: input.idempotencyKey,
      kind: input.kind,
      requestDigest,
      revision: 1,
      sizeBytes,
      updatedAt: now,
    };
    this.#database.insert(mcpAuthoringDrafts).values(row).run();
    return mcpAuthoringDraftResultSchema.parse({
      action: "create",
      draft: reference({
        ...row,
        lastIdempotencyKey: null,
        lastRequestDigest: null,
      }),
      ok: true,
      replayed: false,
    });
  }

  #owned(authority: OwnerAuthority, id: string) {
    return this.#database
      .select()
      .from(mcpAuthoringDrafts)
      .where(
        and(
          eq(mcpAuthoringDrafts.draftId, id),
          eq(mcpAuthoringDrafts.clientId, authority.clientId),
        ),
      )
      .get();
  }

  #read(authority: OwnerAuthority, expected: McpAuthoringDraftLocator): McpAuthoringDraftResult {
    const row = this.#owned(authority, expected.id);
    if (row === undefined) return denied("draft_not_found");
    if (
      row.kind !== expected.kind ||
      row.revision !== expected.revision ||
      row.contentDigest !== expected.digest
    ) {
      return denied("revision_conflict");
    }
    return mcpAuthoringDraftResultSchema.parse({
      action: "read",
      content: row.content,
      draft: reference(row),
      ok: true,
    });
  }

  async #replace(
    authority: OwnerAuthority,
    input: Extract<McpAuthoringDraftInput, { action: "replace" }>,
  ): Promise<McpAuthoringDraftResult> {
    const initial = this.#owned(authority, input.draft.id);
    if (initial === undefined) return denied("draft_not_found");
    const content = validatedContent(initial.kind, input.content);
    if (content === null) return denied("invalid_request");
    const sizeBytes = encoder.encode(canonicalJson(content)).byteLength;
    if (sizeBytes > MAXIMUM_MCP_AUTHORING_DRAFT_BYTES) return denied("invalid_request");
    const locator = {
      digest: input.draft.digest,
      id: input.draft.id,
      kind: input.draft.kind,
      revision: input.draft.revision,
    };
    const [requestDigest, contentDigest] = await Promise.all([
      digest(jsonValueSchema.parse({ content, draft: locator })),
      digest(content),
    ]);
    const row = this.#owned(authority, input.draft.id);
    if (row === undefined) return denied("draft_not_found");
    if (
      row.revision === input.draft.revision + 1 &&
      row.lastIdempotencyKey === input.idempotencyKey
    ) {
      return row.lastRequestDigest === requestDigest
        ? mcpAuthoringDraftResultSchema.parse({
            action: "replace",
            draft: reference(row),
            ok: true,
            replayed: true,
          })
        : denied("idempotency_conflict");
    }
    if (
      row.kind !== input.draft.kind ||
      row.revision !== input.draft.revision ||
      row.contentDigest !== input.draft.digest
    ) {
      return denied("revision_conflict");
    }
    const now = Date.now();
    const next = {
      content,
      contentDigest,
      expiresAt: now + MCP_AUTHORING_DRAFT_TTL_SECONDS * 1_000,
      lastIdempotencyKey: input.idempotencyKey,
      lastRequestDigest: requestDigest,
      revision: row.revision + 1,
      sizeBytes,
      updatedAt: now,
    };
    const updated = this.#database
      .update(mcpAuthoringDrafts)
      .set(next)
      .where(
        and(
          eq(mcpAuthoringDrafts.draftId, row.draftId),
          eq(mcpAuthoringDrafts.revision, row.revision),
        ),
      )
      .returning({ revision: mcpAuthoringDrafts.revision })
      .get();
    if (updated === undefined) return denied("revision_conflict");
    return mcpAuthoringDraftResultSchema.parse({
      action: "replace",
      draft: reference({ ...row, ...next }),
      ok: true,
      replayed: false,
    });
  }

  #discard(authority: OwnerAuthority, expected: McpAuthoringDraftLocator): McpAuthoringDraftResult {
    const result = this.#read(authority, expected);
    if (!result.ok) return result;
    this.#database
      .delete(mcpAuthoringDrafts)
      .where(eq(mcpAuthoringDrafts.draftId, expected.id))
      .run();
    return mcpAuthoringDraftResultSchema.parse({
      action: "discard",
      discarded: true,
      draftId: expected.id,
      ok: true,
    });
  }
}

export function deniedMcpAuthoringDraft(code: FailureCode): McpAuthoringDraftResult {
  return denied(code);
}
