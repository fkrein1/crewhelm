import {
  MAXIMUM_SKILL_LIBRARY_BYTES,
  MAXIMUM_SKILLS,
  MAXIMUM_SKILL_VERSIONS,
  MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS,
  crewAgentSkillContext,
  getSkillInputSchema,
  getSkillResultSchema,
  listSkillsInputSchema,
  listSkillsResultSchema,
  publishSkillInputSchema,
  publishSkillResultSchema,
  retireSkillInputSchema,
  retireSkillResultSchema,
  skillPackageSchema,
  admittedSkillProvenanceSchema,
  skillSummarySchema,
  skillVersionRecordSchema,
  type GetSkillResult,
  type ListSkillsResult,
  type OwnerAuthority,
  type PublishSkillInput,
  type PublishSkillResult,
  type RetireSkillInput,
  type RetireSkillResult,
  type SkillPackage,
  type SkillPackageDescriptor,
  type SkillSummary,
  type SkillWarning,
  type AdmittedSkillInstructions,
  type AdmittedSkillProvenance,
  type AgentRuntimePlan,
} from "@crewhelm/contracts";
import { and, asc, count, eq, gt, sql, sum } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  auditEvents,
  skillMutations,
  skillObjects,
  skills,
  skillVersions,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type FailureCode = Exclude<
  Extract<RetireSkillResult, { ok: false }>["error"]["code"],
  "skill_storage_corrupt" | "skill_storage_unavailable"
>;
type GetSkillFailureCode = Extract<GetSkillResult, { ok: false }>["error"]["code"];
type SkillRuntimeLoadFailure = Extract<SkillRuntimeLoadResult, { ok: false }>;
type StoredSummaryRow = {
  createdAt: number;
  currentVersion: number;
  description: string;
  fileCount: number;
  name: string;
  packageDigest: string;
  sizeBytes: number;
  skillId: string;
  status: "active" | "retired";
  updatedAt: number;
  versionCount: number;
  warnings: SkillWarning[];
};
type PublishCandidate = {
  noChange: boolean;
  ok: true;
  version: number;
};

class SkillStorageInvariantError extends Error {
  override readonly name = "SkillStorageInvariantError";
}

export interface StoredSkillPackage {
  bytes: Uint8Array;
  digest: string;
}

export interface SkillPackageObjectStore {
  get(key: string): Promise<StoredSkillPackage | null>;
  put(key: string, bytes: Uint8Array, digest: string): Promise<"created" | "existing" | "conflict">;
}

export type SkillRuntimeLoadResult =
  | {
      instructions: AdmittedSkillInstructions[];
      ok: true;
    }
  | {
      code:
        | "instructions_oversized"
        | "reference_unavailable"
        | "storage_corrupt"
        | "storage_unavailable";
      ok: false;
    };

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=/]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
] as const;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(bytes: Uint8Array): Promise<{ base64Url: string; hex: string }> {
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

  return { base64Url: encodeBase64Url(hashed), hex: encodeHex(hashed) };
}

function canonicalPackage(skillPackage: SkillPackage): string {
  return JSON.stringify({
    description: skillPackage.description,
    files: skillPackage.files.map(({ content, path }) => ({ content, path })),
    name: skillPackage.name,
    provenance: skillPackage.provenance,
  });
}

function packageWarnings(skillPackage: SkillPackage): SkillWarning[] {
  const warnings: SkillWarning[] = [];
  const provenanceSource =
    skillPackage.provenance.kind === "authored" ? undefined : skillPackage.provenance.source;

  if (secretPatterns.some((pattern) => pattern.test(skillPackage.description))) {
    warnings.push({ code: "suspected_secret", path: "$description" });
  }

  if (
    provenanceSource !== undefined &&
    secretPatterns.some((pattern) => {
      try {
        return pattern.test(decodeURIComponent(new URL(provenanceSource).pathname));
      } catch {
        return true;
      }
    })
  ) {
    warnings.push({ code: "suspected_secret", path: "$provenance.source" });
  }

  for (const file of skillPackage.files) {
    if (file.path.startsWith("scripts/")) {
      warnings.push({ code: "executable_content", path: file.path });
    }

    if (secretPatterns.some((pattern) => pattern.test(file.content))) {
      warnings.push({ code: "suspected_secret", path: file.path });
    }
  }

  return warnings.toSorted((left, right) =>
    left.path < right.path
      ? -1
      : left.path > right.path
        ? 1
        : left.code < right.code
          ? -1
          : left.code > right.code
            ? 1
            : 0,
  );
}

function warningCounts(warnings: readonly SkillWarning[]): {
  executableContent: number;
  suspectedSecrets: number;
} {
  return {
    executableContent: warnings.filter(({ code }) => code === "executable_content").length,
    suspectedSecrets: warnings.filter(({ code }) => code === "suspected_secret").length,
  };
}

async function describePackage(skillPackage: SkillPackage): Promise<{
  bytes: Uint8Array;
  descriptor: SkillPackageDescriptor;
}> {
  const bytes = textEncoder.encode(canonicalPackage(skillPackage));
  const packageDigest = (await digest(bytes)).hex;

  return {
    bytes,
    descriptor: {
      digest: packageDigest,
      fileCount: skillPackage.files.length,
      sizeBytes: bytes.byteLength,
      warnings: packageWarnings(skillPackage),
    },
  };
}

async function requestDigest(input: PublishSkillInput | RetireSkillInput): Promise<string> {
  return (await digest(textEncoder.encode(JSON.stringify(input.target)))).base64Url;
}

function escapedNamePattern(name: string): string {
  return `%${name.toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

function denied(code: FailureCode) {
  return {
    error: {
      code,
      message: "Skill request denied." as const,
    },
    ok: false as const,
  };
}

function storageUnavailable(nextAction: "contact_operator" | "retry_same_request") {
  return {
    error: {
      code:
        nextAction === "contact_operator"
          ? ("skill_storage_corrupt" as const)
          : ("skill_storage_unavailable" as const),
      message: "Skill storage unavailable." as const,
      operation: { nextAction },
    },
    ok: false as const,
  };
}

function publishStorageFailure(error: unknown) {
  return storageUnavailable(
    error instanceof SkillStorageInvariantError ? "contact_operator" : "retry_same_request",
  );
}

export function runtimeLoadFailureFromSkill(code: GetSkillFailureCode): SkillRuntimeLoadFailure {
  switch (code) {
    case "skill_storage_corrupt":
      return { code: "storage_corrupt", ok: false };
    case "skill_storage_unavailable":
      return { code: "storage_unavailable", ok: false };
    case "idempotency_conflict":
    case "incompatible_schema":
    case "insufficient_scope":
    case "invalid_authority":
    case "invalid_request":
    case "library_capacity_exceeded":
    case "name_conflict":
    case "no_changes":
    case "owner_mismatch":
    case "package_mismatch":
    case "skill_limit_exceeded":
    case "skill_not_found":
    case "skill_retired":
    case "suspected_secret":
    case "version_conflict":
    case "version_limit_exceeded":
      return { code: "reference_unavailable", ok: false };
    default:
      throw new Error("Skill runtime loading received an unhandled failure.");
  }
}

export function deniedSkill(code: FailureCode): ReturnType<typeof denied> {
  return denied(code);
}

export class Skills {
  readonly #database: Database;
  readonly #objectStore: SkillPackageObjectStore;
  readonly #ownerKey: string | undefined;

  constructor(
    database: Database,
    objectStore: SkillPackageObjectStore,
    ownerKey: string | undefined,
  ) {
    this.#database = database;
    this.#objectStore = objectStore;
    this.#ownerKey = ownerKey;
  }

  findActiveVersionByDigest(packageDigest: string): { id: string; version: number } | null {
    const row = this.#database
      .select({ id: skillVersions.skillId, version: skillVersions.version })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.skillId, skillVersions.skillId))
      .where(and(eq(skillVersions.packageDigest, packageDigest), eq(skills.status, "active")))
      .orderBy(asc(skillVersions.skillId), asc(skillVersions.version))
      .limit(1)
      .get();

    return row ?? null;
  }

  matchesVersionDigest(id: string, version: number, packageDigest: string): boolean {
    return (
      this.#database
        .select({ id: skillVersions.skillId })
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, id),
            eq(skillVersions.version, version),
            eq(skillVersions.packageDigest, packageDigest),
          ),
        )
        .get() !== undefined
    );
  }

  async publish(authority: OwnerAuthority, input: unknown): Promise<PublishSkillResult> {
    const request = publishSkillInputSchema.safeParse(input);

    if (!request.success || this.#ownerKey === undefined) {
      return denied("invalid_request");
    }

    const skillPackage = request.data.target.package;
    const prepared = await describePackage(skillPackage);

    if (request.data.mode === "preview") {
      const candidate = this.#validatePublish(request.data, prepared.descriptor);

      if (!candidate.ok) {
        return candidate;
      }

      return publishSkillResultSchema.parse({
        applied: false,
        ok: true,
        package: prepared.descriptor,
        version: candidate.version,
      });
    }

    if (prepared.descriptor.warnings.some(({ code }) => code === "suspected_secret")) {
      return denied("suspected_secret");
    }

    const idempotencyKey = request.data.idempotencyKey;

    if (idempotencyKey === undefined) {
      return denied("invalid_request");
    }

    const mutationDigest = await requestDigest(request.data);
    const replay = this.#publishReplay(authority, idempotencyKey, mutationDigest);

    if (replay !== null) {
      return replay;
    }

    const candidate = this.#validatePublish(request.data, prepared.descriptor);

    if (!candidate.ok) {
      return candidate;
    }

    const objectKey = `skills/${this.#ownerKey}/${prepared.descriptor.digest}.json`;
    const reservation = this.#reserveObject(prepared.descriptor, objectKey);

    if (!reservation.ok) {
      return publishSkillResultSchema.parse(reservation);
    }

    let stored: Awaited<ReturnType<SkillPackageObjectStore["put"]>>;

    try {
      stored = await this.#objectStore.put(objectKey, prepared.bytes, prepared.descriptor.digest);
    } catch {
      return publishSkillResultSchema.parse(storageUnavailable("retry_same_request"));
    }

    if (stored === "conflict") {
      return publishSkillResultSchema.parse(storageUnavailable("contact_operator"));
    }

    try {
      return this.#database.transaction((transaction) => {
        const concurrentReplay = this.#publishReplay(
          authority,
          idempotencyKey,
          mutationDigest,
          transaction,
        );

        if (concurrentReplay !== null) {
          return concurrentReplay;
        }

        const revalidated = this.#validatePublish(request.data, prepared.descriptor, transaction);

        if (!revalidated.ok) {
          return revalidated;
        }

        const committedAt = Date.now();

        transaction
          .update(skillObjects)
          .set({ committedAt, status: "committed" })
          .where(eq(skillObjects.packageDigest, prepared.descriptor.digest))
          .run();

        if (revalidated.noChange) {
          if (stored !== "created") {
            return denied("no_changes");
          }

          if (request.data.target.id === undefined) {
            throw new SkillStorageInvariantError();
          }

          const current = this.#summary(request.data.target.id, transaction);

          if (current === null) {
            throw new SkillStorageInvariantError();
          }

          transaction
            .insert(skillMutations)
            .values({
              clientId: authority.clientId,
              idempotencyKey,
              operation: "publish",
              requestDigest: mutationDigest,
              skillId: current.id,
              version: revalidated.version,
            })
            .run();

          transaction
            .insert(auditEvents)
            .values({
              action: "skill.repaired",
              clientId: authority.clientId,
              occurredAt: committedAt,
              subjectId: current.id,
            })
            .run();

          return publishSkillResultSchema.parse({
            applied: true,
            ok: true,
            package: prepared.descriptor,
            skill: current,
            version: revalidated.version,
          });
        }

        const skillId = request.data.target.id ?? `skill_${crypto.randomUUID()}`;
        const publishedAt = committedAt;

        if (request.data.target.id === undefined) {
          transaction
            .insert(skills)
            .values({
              createdAt: publishedAt,
              currentVersion: revalidated.version,
              name: skillPackage.name,
              skillId,
              status: "active",
              updatedAt: publishedAt,
            })
            .run();
        } else {
          transaction
            .update(skills)
            .set({
              currentVersion: revalidated.version,
              name: skillPackage.name,
              updatedAt: publishedAt,
            })
            .where(eq(skills.skillId, skillId))
            .run();
        }

        transaction
          .insert(skillVersions)
          .values({
            createdAt: publishedAt,
            description: skillPackage.description,
            fileCount: prepared.descriptor.fileCount,
            name: skillPackage.name,
            objectKey,
            packageDigest: prepared.descriptor.digest,
            provenance: skillPackage.provenance,
            sizeBytes: prepared.descriptor.sizeBytes,
            skillId,
            version: revalidated.version,
            warnings: prepared.descriptor.warnings,
          })
          .run();
        transaction
          .insert(skillMutations)
          .values({
            clientId: authority.clientId,
            idempotencyKey,
            operation: "publish",
            requestDigest: mutationDigest,
            skillId,
            version: revalidated.version,
          })
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "skill.published",
            clientId: authority.clientId,
            occurredAt: publishedAt,
            subjectId: skillId,
          })
          .run();

        const summary = this.#summary(skillId, transaction);

        if (summary === null) {
          throw new SkillStorageInvariantError();
        }

        return publishSkillResultSchema.parse({
          applied: true,
          ok: true,
          package: prepared.descriptor,
          skill: summary,
          version: revalidated.version,
        });
      });
    } catch (error) {
      return publishSkillResultSchema.parse(publishStorageFailure(error));
    }
  }

  list(input: unknown): ListSkillsResult {
    const request = listSkillsInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const rows = this.#database
      .select({
        createdAt: skills.createdAt,
        currentVersion: skills.currentVersion,
        description: skillVersions.description,
        fileCount: skillVersions.fileCount,
        name: skillVersions.name,
        packageDigest: skillVersions.packageDigest,
        sizeBytes: skillVersions.sizeBytes,
        skillId: skills.skillId,
        status: skills.status,
        updatedAt: skills.updatedAt,
        versionCount:
          sql<number>`(SELECT COUNT(*) FROM skill_versions AS counted_versions WHERE counted_versions.skill_id = ${skills.skillId})`.mapWith(
            Number,
          ),
        warnings: skillVersions.warnings,
      })
      .from(skills)
      .innerJoin(
        skillVersions,
        and(
          eq(skillVersions.skillId, skills.skillId),
          eq(skillVersions.version, skills.currentVersion),
        ),
      )
      .where(
        and(
          request.data.target.cursor === undefined
            ? undefined
            : gt(skills.skillId, request.data.target.cursor),
          request.data.target.name === undefined
            ? undefined
            : sql`lower(${skillVersions.name}) LIKE ${escapedNamePattern(
                request.data.target.name,
              )} ESCAPE '!'`,
          request.data.target.status === undefined
            ? undefined
            : eq(skills.status, request.data.target.status),
        ),
      )
      .orderBy(asc(skills.skillId))
      .limit(request.data.target.limit + 1)
      .all();
    const hasMore = rows.length > request.data.target.limit;
    const page = rows.slice(0, request.data.target.limit).map((row) => this.#summaryFromRow(row));

    return listSkillsResultSchema.parse({
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      ok: true,
      skills: page,
    });
  }

  async get(input: unknown): Promise<GetSkillResult> {
    const request = getSkillInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const summary = this.#summary(request.data.target.id);

    if (summary === null) {
      return denied("skill_not_found");
    }

    const versionNumber = request.data.target.version ?? summary.currentVersion;
    const row = this.#database
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, summary.id), eq(skillVersions.version, versionNumber)))
      .get();

    if (row === undefined) {
      return denied("skill_not_found");
    }

    let stored: StoredSkillPackage | null;

    try {
      stored = await this.#objectStore.get(row.objectKey);
    } catch {
      return getSkillResultSchema.parse(storageUnavailable("retry_same_request"));
    }

    if (stored === null || stored.digest !== row.packageDigest) {
      return getSkillResultSchema.parse(storageUnavailable("contact_operator"));
    }

    let parsedPackage;

    try {
      parsedPackage = skillPackageSchema.safeParse(JSON.parse(textDecoder.decode(stored.bytes)));
    } catch {
      parsedPackage = { success: false } as const;
    }

    const described = parsedPackage.success ? await describePackage(parsedPackage.data) : undefined;

    if (
      !parsedPackage.success ||
      described === undefined ||
      described.descriptor.digest !== row.packageDigest ||
      described.descriptor.fileCount !== row.fileCount ||
      described.descriptor.sizeBytes !== row.sizeBytes ||
      JSON.stringify(described.descriptor.warnings) !== JSON.stringify(row.warnings) ||
      parsedPackage.data.name !== row.name ||
      parsedPackage.data.description !== row.description ||
      JSON.stringify(parsedPackage.data.provenance) !== JSON.stringify(row.provenance)
    ) {
      return getSkillResultSchema.parse(storageUnavailable("contact_operator"));
    }

    return getSkillResultSchema.parse({
      ok: true,
      skill: summary,
      version: skillVersionRecordSchema.parse({
        contentTrust: "untrusted",
        createdAt: new Date(row.createdAt).toISOString(),
        description: row.description,
        files: parsedPackage.data.files,
        id: row.skillId,
        name: row.name,
        package: {
          digest: row.packageDigest,
          fileCount: row.fileCount,
          sizeBytes: row.sizeBytes,
          warnings: row.warnings,
        },
        provenance: row.provenance,
        version: row.version,
      }),
    });
  }

  runtimeProvenance(
    references: AgentRuntimePlan["skillReferences"],
    database: Database = this.#database,
    requireActive = false,
  ): AdmittedSkillProvenance[] | undefined {
    const provenance: AdmittedSkillProvenance[] = [];

    for (const reference of references) {
      const row = database
        .select({
          digest: skillVersions.packageDigest,
          id: skillVersions.skillId,
          name: skillVersions.name,
          status: skills.status,
          version: skillVersions.version,
        })
        .from(skillVersions)
        .innerJoin(skills, eq(skills.skillId, skillVersions.skillId))
        .where(
          and(
            eq(skillVersions.skillId, reference.id),
            eq(skillVersions.version, reference.version),
          ),
        )
        .get();

      if (row === undefined || (requireActive && row.status !== "active")) {
        return undefined;
      }

      provenance.push(
        admittedSkillProvenanceSchema.parse({
          digest: row.digest,
          id: row.id,
          name: row.name,
          version: row.version,
        }),
      );
    }

    return provenance;
  }

  async loadRuntimeInstructions(
    references: AgentRuntimePlan["skillReferences"],
  ): Promise<SkillRuntimeLoadResult> {
    const instructions: AdmittedSkillInstructions[] = [];

    for (const reference of references) {
      const result = await this.get({
        target: {
          id: reference.id,
          kind: "skill-package",
          version: reference.version,
        },
      });

      if (!result.ok) {
        return runtimeLoadFailureFromSkill(result.error.code);
      }

      const skillFile = result.version.files.find(({ path }) => path === "SKILL.md");

      if (skillFile === undefined) {
        return { code: "storage_corrupt", ok: false };
      }

      instructions.push({
        contentTrust: "untrusted",
        digest: result.version.package.digest,
        id: result.version.id,
        instructions: skillFile.content,
        name: result.version.name,
        version: result.version.version,
      });
    }

    if (crewAgentSkillContext(instructions).length > MAXIMUM_AGENT_SKILL_CONTEXT_CHARACTERS) {
      return { code: "instructions_oversized", ok: false };
    }

    return { instructions, ok: true };
  }

  async retire(authority: OwnerAuthority, input: unknown): Promise<RetireSkillResult> {
    const request = retireSkillInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const mutationDigest =
      request.data.mode === "apply" ? await requestDigest(request.data) : undefined;
    const retiredAt = Date.now();

    try {
      return this.#database.transaction((transaction) => {
        if (request.data.mode === "apply") {
          const idempotencyKey = request.data.idempotencyKey;

          if (idempotencyKey === undefined || mutationDigest === undefined) {
            return denied("invalid_request");
          }

          const replay = transaction
            .select({
              operation: skillMutations.operation,
              requestDigest: skillMutations.requestDigest,
              skillId: skillMutations.skillId,
            })
            .from(skillMutations)
            .where(
              and(
                eq(skillMutations.clientId, authority.clientId),
                eq(skillMutations.idempotencyKey, idempotencyKey),
              ),
            )
            .get();

          if (replay !== undefined) {
            if (replay.requestDigest !== mutationDigest || replay.operation !== "retire") {
              return denied("idempotency_conflict");
            }

            const replayedSkill = this.#summary(replay.skillId, transaction);

            if (replayedSkill === null) {
              return denied("incompatible_schema");
            }

            return retireSkillResultSchema.parse({
              applied: false,
              ok: true,
              skill: replayedSkill,
            });
          }
        }

        const current = this.#summary(request.data.target.id, transaction);

        if (current === null) {
          return denied("skill_not_found");
        }

        if (current.currentVersion !== request.data.target.expectedVersion) {
          return denied("version_conflict");
        }

        if (current.status === "retired") {
          return denied("skill_retired");
        }

        const retired = skillSummarySchema.parse({
          ...current,
          status: "retired",
          updatedAt: new Date(retiredAt).toISOString(),
        });

        if (request.data.mode === "preview") {
          return retireSkillResultSchema.parse({
            applied: false,
            ok: true,
            skill: retired,
          });
        }

        const idempotencyKey = request.data.idempotencyKey;

        if (idempotencyKey === undefined || mutationDigest === undefined) {
          return denied("invalid_request");
        }

        transaction
          .update(skills)
          .set({ retiredAt, status: "retired", updatedAt: retiredAt })
          .where(eq(skills.skillId, current.id))
          .run();
        transaction
          .insert(skillMutations)
          .values({
            clientId: authority.clientId,
            idempotencyKey,
            operation: "retire",
            requestDigest: mutationDigest,
            skillId: current.id,
            version: current.currentVersion,
          })
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "skill.retired",
            clientId: authority.clientId,
            occurredAt: retiredAt,
            subjectId: current.id,
          })
          .run();

        return retireSkillResultSchema.parse({
          applied: true,
          ok: true,
          skill: retired,
        });
      });
    } catch {
      return retireSkillResultSchema.parse(storageUnavailable("retry_same_request"));
    }
  }

  usage(): {
    active: number;
    pendingObjects: number;
    storedBytes: number;
    total: number;
    versions: number;
  } {
    const skillCounts = this.#database
      .select({
        active: count(sql`CASE WHEN ${skills.status} = 'active' THEN 1 END`),
        total: count(),
      })
      .from(skills)
      .get();
    const objectCounts = this.#database
      .select({
        pendingObjects: count(sql`CASE WHEN ${skillObjects.status} = 'pending' THEN 1 END`),
        storedBytes: sum(skillObjects.sizeBytes).mapWith(Number),
      })
      .from(skillObjects)
      .get();
    const versionCounts = this.#database
      .select({
        versions: count(),
      })
      .from(skillVersions)
      .get();

    return {
      active: skillCounts?.active ?? 0,
      pendingObjects: objectCounts?.pendingObjects ?? 0,
      storedBytes: objectCounts?.storedBytes ?? 0,
      total: skillCounts?.total ?? 0,
      versions: versionCounts?.versions ?? 0,
    };
  }

  #publishReplay(
    authority: OwnerAuthority,
    idempotencyKey: string,
    mutationDigest: string,
    database: Database = this.#database,
  ): PublishSkillResult | null {
    const replay = database
      .select({
        operation: skillMutations.operation,
        packageDigest: skillVersions.packageDigest,
        requestDigest: skillMutations.requestDigest,
        skillId: skillMutations.skillId,
        version: skillMutations.version,
      })
      .from(skillMutations)
      .innerJoin(
        skillVersions,
        and(
          eq(skillVersions.skillId, skillMutations.skillId),
          eq(skillVersions.version, skillMutations.version),
        ),
      )
      .where(
        and(
          eq(skillMutations.clientId, authority.clientId),
          eq(skillMutations.idempotencyKey, idempotencyKey),
        ),
      )
      .get();

    if (replay === undefined) {
      return null;
    }

    if (replay.requestDigest !== mutationDigest || replay.operation !== "publish") {
      return publishSkillResultSchema.parse(denied("idempotency_conflict"));
    }

    const version = database
      .select({
        fileCount: skillVersions.fileCount,
        sizeBytes: skillVersions.sizeBytes,
        warnings: skillVersions.warnings,
      })
      .from(skillVersions)
      .where(
        and(eq(skillVersions.skillId, replay.skillId), eq(skillVersions.version, replay.version)),
      )
      .get();
    const summary = this.#summary(replay.skillId, database);

    if (version === undefined || summary === null) {
      return publishSkillResultSchema.parse(denied("incompatible_schema"));
    }

    return publishSkillResultSchema.parse({
      applied: false,
      ok: true,
      package: {
        digest: replay.packageDigest,
        fileCount: version.fileCount,
        sizeBytes: version.sizeBytes,
        warnings: version.warnings,
      },
      skill: summary,
      version: replay.version,
    });
  }

  #summary(skillId: string, database: Database = this.#database): SkillSummary | null {
    const row = database
      .select({
        createdAt: skills.createdAt,
        currentVersion: skills.currentVersion,
        description: skillVersions.description,
        fileCount: skillVersions.fileCount,
        name: skillVersions.name,
        packageDigest: skillVersions.packageDigest,
        sizeBytes: skillVersions.sizeBytes,
        skillId: skills.skillId,
        status: skills.status,
        updatedAt: skills.updatedAt,
        versionCount:
          sql<number>`(SELECT COUNT(*) FROM skill_versions AS counted_versions WHERE counted_versions.skill_id = ${skills.skillId})`.mapWith(
            Number,
          ),
        warnings: skillVersions.warnings,
      })
      .from(skills)
      .innerJoin(
        skillVersions,
        and(
          eq(skillVersions.skillId, skills.skillId),
          eq(skillVersions.version, skills.currentVersion),
        ),
      )
      .where(eq(skills.skillId, skillId))
      .get();

    return row === undefined ? null : this.#summaryFromRow(row);
  }

  #summaryFromRow(row: StoredSummaryRow): SkillSummary {
    return skillSummarySchema.parse({
      createdAt: new Date(row.createdAt).toISOString(),
      currentVersion: row.currentVersion,
      description: row.description,
      id: row.skillId,
      name: row.name,
      package: {
        digest: row.packageDigest,
        fileCount: row.fileCount,
        sizeBytes: row.sizeBytes,
        warningCounts: warningCounts(row.warnings),
      },
      status: row.status,
      updatedAt: new Date(row.updatedAt).toISOString(),
      versionCount: row.versionCount,
    });
  }

  #validatePublish(
    input: PublishSkillInput,
    descriptor: SkillPackageDescriptor,
    database: Database = this.#database,
  ): PublishCandidate | ReturnType<typeof denied> {
    const storedBytes =
      database
        .select({ value: sum(skillObjects.sizeBytes).mapWith(Number) })
        .from(skillObjects)
        .get()?.value ?? 0;
    const objectExists =
      database
        .select({ packageDigest: skillObjects.packageDigest })
        .from(skillObjects)
        .where(eq(skillObjects.packageDigest, descriptor.digest))
        .get() !== undefined;

    if (!objectExists && storedBytes + descriptor.sizeBytes > MAXIMUM_SKILL_LIBRARY_BYTES) {
      return denied("library_capacity_exceeded");
    }

    const targetId = input.target.id;

    if (targetId === undefined) {
      const skillCount = database.select({ value: count() }).from(skills).get()?.value ?? 0;

      if (skillCount >= MAXIMUM_SKILLS) {
        return denied("skill_limit_exceeded");
      }

      const nameConflict = database
        .select({ skillId: skills.skillId })
        .from(skills)
        .where(and(eq(skills.name, input.target.package.name), eq(skills.status, "active")))
        .get();

      return nameConflict === undefined
        ? { noChange: false, ok: true, version: 1 }
        : denied("name_conflict");
    }

    const current = this.#summary(targetId, database);

    if (current === null) {
      return denied("skill_not_found");
    }

    if (input.target.repairVersion !== undefined) {
      const version = database
        .select()
        .from(skillVersions)
        .where(
          and(
            eq(skillVersions.skillId, targetId),
            eq(skillVersions.version, input.target.repairVersion),
          ),
        )
        .get();

      if (version === undefined) {
        return denied("skill_not_found");
      }

      if (
        version.packageDigest !== descriptor.digest ||
        version.fileCount !== descriptor.fileCount ||
        version.sizeBytes !== descriptor.sizeBytes ||
        JSON.stringify(version.warnings) !== JSON.stringify(descriptor.warnings) ||
        version.name !== input.target.package.name ||
        version.description !== input.target.package.description ||
        JSON.stringify(version.provenance) !== JSON.stringify(input.target.package.provenance)
      ) {
        return denied("package_mismatch");
      }

      return {
        noChange: true,
        ok: true,
        version: input.target.repairVersion,
      };
    }

    if (current.status === "retired") {
      return denied("skill_retired");
    }

    if (current.currentVersion !== input.target.expectedVersion) {
      return denied("version_conflict");
    }

    if (current.package.digest === descriptor.digest) {
      return input.mode === "preview"
        ? denied("no_changes")
        : { noChange: true, ok: true, version: current.currentVersion };
    }

    if (current.versionCount >= MAXIMUM_SKILL_VERSIONS) {
      return denied("version_limit_exceeded");
    }

    const nameConflict = database
      .select({ skillId: skills.skillId })
      .from(skills)
      .where(
        and(
          eq(skills.name, input.target.package.name),
          eq(skills.status, "active"),
          sql`${skills.skillId} <> ${targetId}`,
        ),
      )
      .get();

    return nameConflict === undefined
      ? {
          noChange: false,
          ok: true,
          version: current.currentVersion + 1,
        }
      : denied("name_conflict");
  }

  #reserveObject(
    descriptor: SkillPackageDescriptor,
    objectKey: string,
  ): { ok: true } | ReturnType<typeof denied> | ReturnType<typeof storageUnavailable> {
    try {
      return this.#database.transaction((transaction) => {
        const existing = transaction
          .select()
          .from(skillObjects)
          .where(eq(skillObjects.packageDigest, descriptor.digest))
          .get();

        if (existing !== undefined) {
          return existing.objectKey === objectKey && existing.sizeBytes === descriptor.sizeBytes
            ? { ok: true as const }
            : denied("incompatible_schema");
        }

        const storedBytes =
          transaction
            .select({ value: sum(skillObjects.sizeBytes).mapWith(Number) })
            .from(skillObjects)
            .get()?.value ?? 0;

        if (storedBytes + descriptor.sizeBytes > MAXIMUM_SKILL_LIBRARY_BYTES) {
          return denied("library_capacity_exceeded");
        }

        transaction
          .insert(skillObjects)
          .values({
            createdAt: Date.now(),
            objectKey,
            packageDigest: descriptor.digest,
            sizeBytes: descriptor.sizeBytes,
            status: "pending",
          })
          .run();

        return { ok: true as const };
      });
    } catch {
      return storageUnavailable("retry_same_request");
    }
  }
}
