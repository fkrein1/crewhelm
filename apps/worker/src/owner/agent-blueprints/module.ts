import {
  MAXIMUM_AGENT_BLUEPRINT_LIBRARY_BYTES,
  MAXIMUM_AGENT_BLUEPRINTS,
  MAXIMUM_AGENT_BLUEPRINT_VERSIONS,
  agentBlueprintPackageDescriptorSchema,
  agentBlueprintPackageSchema,
  agentBlueprintPreviewSchema,
  agentBlueprintSummarySchema,
  agentBlueprintVersionRecordSchema,
  agentInstructionsSchema,
  agentNameSchema,
  getAgentBlueprintInputSchema,
  getAgentBlueprintResultSchema,
  instantiateAgentBlueprintInputSchema,
  instantiateAgentBlueprintResultSchema,
  listAgentBlueprintsInputSchema,
  listAgentBlueprintsResultSchema,
  publishAgentBlueprintInputSchema,
  publishAgentBlueprintResultSchema,
  retireAgentBlueprintInputSchema,
  retireAgentBlueprintResultSchema,
  type AgentBlueprintPackage,
  type AgentBlueprintPreview,
  type AgentBlueprintSummary,
  type CreateAgentResult,
  type GetAgentBlueprintResult,
  type InstantiateAgentBlueprintInput,
  type InstantiateAgentBlueprintResult,
  type ListAgentBlueprintsResult,
  type OwnerAuthority,
  type PublishAgentBlueprintInput,
  type PublishAgentBlueprintResult,
  type RetireAgentBlueprintInput,
  type RetireAgentBlueprintResult,
} from "@crewhelm/contracts";
import { and, asc, count, eq, gt, sql, sum } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentBlueprintMutations,
  agentBlueprintVersions,
  agentBlueprints,
  auditEvents,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";
import type { AgentRegistry } from "../agents/index.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type FailureCode = Extract<InstantiateAgentBlueprintResult, { ok: false }>["error"]["code"];
type AgentCreationFailureCode = Extract<CreateAgentResult, { ok: false }>["error"]["code"];
type AgentBlueprintParameter = AgentBlueprintPackage["parameters"][number];
type StoredSummaryRow = {
  blueprintId: string;
  createdAt: number;
  currentVersion: number;
  name: string;
  package: AgentBlueprintPackage;
  packageDigest: string;
  sizeBytes: number;
  status: "active" | "retired";
  updatedAt: number;
  versionCount: number;
};

const textEncoder = new TextEncoder();
const parameterToken = /\{\{([a-z][a-z0-9-]{0,39})\}\}/g;

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

async function digest(value: string): Promise<{ base64Url: string; hex: string }> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));

  return { base64Url: encodeBase64Url(bytes), hex: encodeHex(bytes) };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }

  return value;
}

function canonicalPackage(agentBlueprint: AgentBlueprintPackage): string {
  return JSON.stringify(canonicalValue(agentBlueprint));
}

async function describePackage(agentBlueprint: AgentBlueprintPackage) {
  const canonical = canonicalPackage(agentBlueprint);
  const packageDigest = await digest(canonical);

  return agentBlueprintPackageDescriptorSchema.parse({
    digest: packageDigest.hex,
    sizeBytes: textEncoder.encode(canonical).byteLength,
  });
}

async function requestDigest(
  input: PublishAgentBlueprintInput | RetireAgentBlueprintInput,
): Promise<string> {
  return (await digest(JSON.stringify(canonicalValue(input.target)))).base64Url;
}

function denied(code: FailureCode) {
  return {
    error: {
      code,
      message: "Agent blueprint request denied." as const,
    },
    ok: false as const,
  };
}

function agentCreationFailureCode(code: AgentCreationFailureCode): FailureCode {
  switch (code) {
    case "agent_limit_exceeded":
      return "agent_limit_exceeded";
    case "idempotency_conflict":
      return "idempotency_conflict";
    case "agent_not_found":
    case "agent_revision_limit_exceeded":
    case "agent_unavailable":
    case "incompatible_schema":
    case "insufficient_scope":
    case "invalid_authority":
    case "invalid_request":
    case "no_changes":
    case "owner_mismatch":
    case "revision_conflict":
      return "invalid_request";
  }

  code satisfies never;
  throw new Error("Invariant violated: unsupported Agent creation failure.");
}

function validParameterValue(
  parameter: AgentBlueprintParameter,
  value: unknown,
): value is string | number | boolean {
  switch (parameter.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        (parameter.minimum === undefined || value >= parameter.minimum) &&
        (parameter.maximum === undefined || value <= parameter.maximum)
      );
    case "string":
      return typeof value === "string";
  }

  parameter satisfies never;
  return false;
}

export function deniedAgentBlueprint(code: FailureCode): ReturnType<typeof denied> {
  return denied(code);
}

function escapedNamePattern(name: string): string {
  return `%${name.toLowerCase().replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
}

export class AgentBlueprints {
  readonly #agents: AgentRegistry;
  readonly #database: Database;

  constructor(database: Database, agents: AgentRegistry) {
    this.#agents = agents;
    this.#database = database;
  }

  async publish(authority: OwnerAuthority, input: unknown): Promise<PublishAgentBlueprintResult> {
    const request = publishAgentBlueprintInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const descriptor = await describePackage(request.data.target.package);

    if (request.data.mode === "preview") {
      const candidate = this.#publishCandidate(request.data, descriptor);

      if (!candidate.ok) {
        return candidate;
      }

      return publishAgentBlueprintResultSchema.parse({
        applied: false,
        ok: true,
        package: descriptor,
        version: candidate.version,
      });
    }

    const idempotencyKey = request.data.idempotencyKey;

    if (idempotencyKey === undefined) {
      return denied("invalid_request");
    }

    const mutationDigest = await requestDigest(request.data);

    return this.#database.transaction((transaction) => {
      const replay = transaction
        .select({
          blueprintId: agentBlueprintMutations.blueprintId,
          operation: agentBlueprintMutations.operation,
          requestDigest: agentBlueprintMutations.requestDigest,
          version: agentBlueprintMutations.version,
        })
        .from(agentBlueprintMutations)
        .where(
          and(
            eq(agentBlueprintMutations.clientId, authority.clientId),
            eq(agentBlueprintMutations.idempotencyKey, idempotencyKey),
          ),
        )
        .get();

      if (replay !== undefined) {
        if (replay.operation !== "publish" || replay.requestDigest !== mutationDigest) {
          return denied("idempotency_conflict");
        }

        const blueprint = this.#summary(replay.blueprintId, transaction);
        const version = transaction
          .select({
            packageDigest: agentBlueprintVersions.packageDigest,
            sizeBytes: agentBlueprintVersions.sizeBytes,
          })
          .from(agentBlueprintVersions)
          .where(
            and(
              eq(agentBlueprintVersions.blueprintId, replay.blueprintId),
              eq(agentBlueprintVersions.version, replay.version),
            ),
          )
          .get();

        if (blueprint === null || version === undefined) {
          return denied("incompatible_schema");
        }

        return publishAgentBlueprintResultSchema.parse({
          applied: false,
          blueprint,
          ok: true,
          package: {
            digest: version.packageDigest,
            sizeBytes: version.sizeBytes,
          },
          version: replay.version,
        });
      }

      const revalidated = this.#publishCandidate(request.data, descriptor, transaction);

      if (!revalidated.ok) {
        return revalidated;
      }

      const blueprintId = request.data.target.id ?? `blueprint_${crypto.randomUUID()}`;
      const createdAt = Date.now();

      if (request.data.target.id === undefined) {
        transaction
          .insert(agentBlueprints)
          .values({
            blueprintId,
            createdAt,
            currentVersion: revalidated.version,
            name: request.data.target.package.name,
            status: "active",
            updatedAt: createdAt,
          })
          .run();
      } else {
        transaction
          .update(agentBlueprints)
          .set({
            currentVersion: revalidated.version,
            name: request.data.target.package.name,
            updatedAt: createdAt,
          })
          .where(eq(agentBlueprints.blueprintId, blueprintId))
          .run();
      }

      transaction
        .insert(agentBlueprintVersions)
        .values({
          blueprintId,
          createdAt,
          package: request.data.target.package,
          packageDigest: descriptor.digest,
          sizeBytes: descriptor.sizeBytes,
          version: revalidated.version,
        })
        .run();
      transaction
        .insert(agentBlueprintMutations)
        .values({
          blueprintId,
          clientId: authority.clientId,
          idempotencyKey,
          operation: "publish",
          requestDigest: mutationDigest,
          version: revalidated.version,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent_blueprint.published",
          clientId: authority.clientId,
          occurredAt: createdAt,
          subjectId: blueprintId,
        })
        .run();

      const blueprint = this.#summary(blueprintId, transaction);

      if (blueprint === null) {
        throw new Error("Invariant violated: published Agent blueprint is unavailable.");
      }

      return publishAgentBlueprintResultSchema.parse({
        applied: true,
        blueprint,
        ok: true,
        package: descriptor,
        version: revalidated.version,
      });
    });
  }

  list(input: unknown): ListAgentBlueprintsResult {
    const request = listAgentBlueprintsInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const rows = this.#database
      .select({
        blueprintId: agentBlueprints.blueprintId,
        createdAt: agentBlueprints.createdAt,
        currentVersion: agentBlueprints.currentVersion,
        name: agentBlueprints.name,
        package: agentBlueprintVersions.package,
        packageDigest: agentBlueprintVersions.packageDigest,
        sizeBytes: agentBlueprintVersions.sizeBytes,
        status: agentBlueprints.status,
        updatedAt: agentBlueprints.updatedAt,
        versionCount:
          sql<number>`(SELECT COUNT(*) FROM agent_blueprint_versions AS counted_versions WHERE counted_versions.blueprint_id = ${agentBlueprints.blueprintId})`.mapWith(
            Number,
          ),
      })
      .from(agentBlueprints)
      .innerJoin(
        agentBlueprintVersions,
        and(
          eq(agentBlueprintVersions.blueprintId, agentBlueprints.blueprintId),
          eq(agentBlueprintVersions.version, agentBlueprints.currentVersion),
        ),
      )
      .where(
        and(
          request.data.target.cursor === undefined
            ? undefined
            : gt(agentBlueprints.blueprintId, request.data.target.cursor),
          request.data.target.name === undefined
            ? undefined
            : sql`lower(${agentBlueprints.name}) LIKE ${escapedNamePattern(
                request.data.target.name,
              )} ESCAPE '!'`,
          request.data.target.status === undefined
            ? undefined
            : eq(agentBlueprints.status, request.data.target.status),
          request.data.target.tag === undefined
            ? undefined
            : sql`EXISTS (
                SELECT 1 FROM json_each(${agentBlueprintVersions.package}, '$.tags')
                WHERE value = ${request.data.target.tag}
              )`,
        ),
      )
      .orderBy(asc(agentBlueprints.blueprintId))
      .limit(request.data.target.limit + 1)
      .all();
    const hasMore = rows.length > request.data.target.limit;
    const blueprints = rows
      .slice(0, request.data.target.limit)
      .map((row) => this.#summaryFromRow(row));

    return listAgentBlueprintsResultSchema.parse({
      blueprints,
      nextCursor: hasMore ? (blueprints.at(-1)?.id ?? null) : null,
      ok: true,
    });
  }

  get(input: unknown): GetAgentBlueprintResult {
    const request = getAgentBlueprintInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const blueprint = this.#summary(request.data.target.id);

    if (blueprint === null) {
      return denied("blueprint_not_found");
    }

    const versionNumber = request.data.target.version ?? blueprint.currentVersion;
    const row = this.#database
      .select()
      .from(agentBlueprintVersions)
      .where(
        and(
          eq(agentBlueprintVersions.blueprintId, blueprint.id),
          eq(agentBlueprintVersions.version, versionNumber),
        ),
      )
      .get();
    const parsedPackage = agentBlueprintPackageSchema.safeParse(row?.package);

    if (row === undefined || !parsedPackage.success) {
      return denied(row === undefined ? "blueprint_not_found" : "incompatible_schema");
    }

    return getAgentBlueprintResultSchema.parse({
      blueprint,
      ok: true,
      version: agentBlueprintVersionRecordSchema.parse({
        contentTrust: "untrusted",
        createdAt: new Date(row.createdAt).toISOString(),
        id: row.blueprintId,
        metadataTrust: "unverified",
        package: parsedPackage.data,
        packageDescriptor: {
          digest: row.packageDigest,
          sizeBytes: row.sizeBytes,
        },
        version: row.version,
      }),
    });
  }

  async instantiate(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<InstantiateAgentBlueprintResult> {
    const request = instantiateAgentBlueprintInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const resolved = await this.#resolve(request.data);

    if (!resolved.ok) {
      return resolved;
    }

    if (request.data.mode === "preview") {
      return instantiateAgentBlueprintResultSchema.parse({
        created: false,
        ok: true,
        preview: resolved.preview,
      });
    }

    if (!resolved.preview.ready) {
      return denied("prerequisite_unavailable");
    }

    const idempotencyKey = request.data.idempotencyKey;

    if (idempotencyKey === undefined) {
      return denied("invalid_request");
    }

    const created = await this.#agents.create(
      authority,
      {
        ...resolved.preview.agent,
        idempotencyKey,
      },
      resolved.preview.provenance,
    );

    if (!created.ok) {
      return denied(agentCreationFailureCode(created.error.code));
    }

    return instantiateAgentBlueprintResultSchema.parse({
      agent: created.agent,
      created: created.created,
      ok: true,
      preview: resolved.preview,
    });
  }

  async retire(authority: OwnerAuthority, input: unknown): Promise<RetireAgentBlueprintResult> {
    const request = retireAgentBlueprintInputSchema.safeParse(input);

    if (!request.success) {
      return denied("invalid_request");
    }

    const mutationDigest =
      request.data.mode === "apply" ? await requestDigest(request.data) : undefined;

    return this.#database.transaction((transaction) => {
      const idempotencyKey = request.data.idempotencyKey;

      if (request.data.mode === "apply") {
        if (idempotencyKey === undefined || mutationDigest === undefined) {
          return denied("invalid_request");
        }

        const replay = transaction
          .select()
          .from(agentBlueprintMutations)
          .where(
            and(
              eq(agentBlueprintMutations.clientId, authority.clientId),
              eq(agentBlueprintMutations.idempotencyKey, idempotencyKey),
            ),
          )
          .get();

        if (replay !== undefined) {
          if (replay.operation !== "retire" || replay.requestDigest !== mutationDigest) {
            return denied("idempotency_conflict");
          }

          const blueprint = this.#summary(replay.blueprintId, transaction);

          return blueprint === null
            ? denied("incompatible_schema")
            : retireAgentBlueprintResultSchema.parse({
                applied: false,
                blueprint,
                ok: true,
              });
        }
      }

      const current = this.#summary(request.data.target.id, transaction);

      if (current === null) {
        return denied("blueprint_not_found");
      }

      if (current.currentVersion !== request.data.target.expectedVersion) {
        return denied("version_conflict");
      }

      if (current.status === "retired") {
        return denied("blueprint_retired");
      }

      const retiredAt = Date.now();
      const retired = agentBlueprintSummarySchema.parse({
        ...current,
        status: "retired",
        updatedAt: new Date(retiredAt).toISOString(),
      });

      if (request.data.mode === "preview") {
        return retireAgentBlueprintResultSchema.parse({
          applied: false,
          blueprint: retired,
          ok: true,
        });
      }

      if (idempotencyKey === undefined || mutationDigest === undefined) {
        return denied("invalid_request");
      }

      transaction
        .update(agentBlueprints)
        .set({ retiredAt, status: "retired", updatedAt: retiredAt })
        .where(eq(agentBlueprints.blueprintId, current.id))
        .run();
      transaction
        .insert(agentBlueprintMutations)
        .values({
          blueprintId: current.id,
          clientId: authority.clientId,
          idempotencyKey,
          operation: "retire",
          requestDigest: mutationDigest,
          version: current.currentVersion,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "agent_blueprint.retired",
          clientId: authority.clientId,
          occurredAt: retiredAt,
          subjectId: current.id,
        })
        .run();

      return retireAgentBlueprintResultSchema.parse({
        applied: true,
        blueprint: retired,
        ok: true,
      });
    });
  }

  async #resolve(
    input: InstantiateAgentBlueprintInput,
  ): Promise<{ ok: true; preview: AgentBlueprintPreview } | ReturnType<typeof denied>> {
    const result = this.get({
      target: {
        id: input.target.id,
        kind: "agent-blueprint-package",
        ...(input.target.version === undefined ? {} : { version: input.target.version }),
      },
    });

    if (!result.ok) {
      return denied(result.error.code);
    }

    if (input.mode === "apply" && result.blueprint.status !== "active") {
      return denied("blueprint_retired");
    }

    const values: Record<string, string | number | boolean> = {};
    const supplied = input.target.parameters;

    if (
      Object.keys(supplied).some(
        (name) => !result.version.package.parameters.some((parameter) => parameter.name === name),
      )
    ) {
      return denied("invalid_request");
    }

    for (const parameter of result.version.package.parameters) {
      const value = supplied[parameter.name] ?? parameter.default;

      if (!validParameterValue(parameter, value)) {
        return denied("invalid_request");
      }

      values[parameter.name] = value;
    }

    const render = (value: string) =>
      value.replace(parameterToken, (_, name: string) => String(values[name]));
    const name = agentNameSchema.safeParse(render(result.version.package.agent.name));
    const instructions = agentInstructionsSchema.safeParse(
      render(result.version.package.agent.instructions),
    );

    if (!name.success || !instructions.success) {
      return denied("invalid_request");
    }

    const resolved = this.#agents.resolveDefinition({
      ...result.version.package.agent,
      instructions: instructions.data,
      name: name.data,
    });

    if (!resolved.ok) {
      return denied("invalid_request");
    }

    const prerequisites: AgentBlueprintPreview["prerequisites"] = [
      ...resolved.prerequisites,
      ...resolved.skills.map((skill) => ({
        description: "Exact active Skill version required by this Agent blueprint.",
        id: `${skill.id}:${skill.version}`,
        kind: "skill" as const,
        state: skill.state,
      })),
    ];

    const parameterDigest = await digest(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(values).toSorted(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    );
    const executionLimits = resolved.agent.executionLimits;
    const preview = agentBlueprintPreviewSchema.parse({
      agent: resolved.agent,
      authority: {
        createsGrants: false,
        requestedGrants: prerequisites.flatMap((prerequisite) =>
          prerequisite.kind === "grant"
            ? [{ description: prerequisite.description, id: prerequisite.id }]
            : [],
        ),
      },
      budget: {
        ...executionLimits,
        maxModelCalls: Math.min(
          100,
          executionLimits.maxTurns * (1 + resolved.runtimePlan.inference.fallbackModels.length),
        ),
        pricing: "provider-metered",
      },
      prerequisites,
      profile: resolved.runtimePlan.inference,
      provenance: {
        digest: result.version.packageDescriptor.digest,
        id: result.version.id,
        parameterDigest: parameterDigest.hex,
        version: result.version.version,
      },
      ready: prerequisites.every(({ state }) => state === "available"),
    });

    return { ok: true, preview };
  }

  #publishCandidate(
    input: PublishAgentBlueprintInput,
    descriptor: { digest: string; sizeBytes: number },
    database: Database = this.#database,
  ): { ok: true; version: number } | ReturnType<typeof denied> {
    const resolved = this.#agents.resolveDefinition(input.target.package.agent);

    if (!resolved.ok) {
      return denied("invalid_request");
    }

    const prerequisiteCount = resolved.prerequisites.length + resolved.skills.length;

    if (prerequisiteCount > 32) {
      return denied("invalid_request");
    }

    if (input.target.id === undefined) {
      const blueprintCount =
        database.select({ value: count() }).from(agentBlueprints).get()?.value ?? 0;

      if (blueprintCount >= MAXIMUM_AGENT_BLUEPRINTS) {
        return denied("blueprint_limit_exceeded");
      }
    } else {
      const current = this.#summary(input.target.id, database);

      if (current === null) {
        return denied("blueprint_not_found");
      }

      if (current.status !== "active") {
        return denied("blueprint_retired");
      }

      if (current.currentVersion !== input.target.expectedVersion) {
        return denied("version_conflict");
      }

      if (current.currentVersion >= MAXIMUM_AGENT_BLUEPRINT_VERSIONS) {
        return denied("version_limit_exceeded");
      }

      if (current.package.digest === descriptor.digest) {
        return denied("no_changes");
      }
    }

    const conflictingName = database
      .select({ blueprintId: agentBlueprints.blueprintId })
      .from(agentBlueprints)
      .where(
        and(
          eq(agentBlueprints.name, input.target.package.name),
          eq(agentBlueprints.status, "active"),
        ),
      )
      .get();

    if (conflictingName !== undefined && conflictingName.blueprintId !== input.target.id) {
      return denied("name_conflict");
    }

    const storedBytes =
      database
        .select({ value: sum(agentBlueprintVersions.sizeBytes).mapWith(Number) })
        .from(agentBlueprintVersions)
        .get()?.value ?? 0;

    if (storedBytes + descriptor.sizeBytes > MAXIMUM_AGENT_BLUEPRINT_LIBRARY_BYTES) {
      return denied("library_capacity_exceeded");
    }

    return {
      ok: true,
      version: input.target.expectedVersion === undefined ? 1 : input.target.expectedVersion + 1,
    };
  }

  #summary(blueprintId: string, database: Database = this.#database): AgentBlueprintSummary | null {
    const row = database
      .select({
        blueprintId: agentBlueprints.blueprintId,
        createdAt: agentBlueprints.createdAt,
        currentVersion: agentBlueprints.currentVersion,
        name: agentBlueprints.name,
        package: agentBlueprintVersions.package,
        packageDigest: agentBlueprintVersions.packageDigest,
        sizeBytes: agentBlueprintVersions.sizeBytes,
        status: agentBlueprints.status,
        updatedAt: agentBlueprints.updatedAt,
        versionCount:
          sql<number>`(SELECT COUNT(*) FROM agent_blueprint_versions AS counted_versions WHERE counted_versions.blueprint_id = ${agentBlueprints.blueprintId})`.mapWith(
            Number,
          ),
      })
      .from(agentBlueprints)
      .innerJoin(
        agentBlueprintVersions,
        and(
          eq(agentBlueprintVersions.blueprintId, agentBlueprints.blueprintId),
          eq(agentBlueprintVersions.version, agentBlueprints.currentVersion),
        ),
      )
      .where(eq(agentBlueprints.blueprintId, blueprintId))
      .get();

    return row === undefined ? null : this.#summaryFromRow(row);
  }

  #summaryFromRow(row: StoredSummaryRow): AgentBlueprintSummary {
    return agentBlueprintSummarySchema.parse({
      createdAt: new Date(row.createdAt).toISOString(),
      currentVersion: row.currentVersion,
      description: row.package.description,
      id: row.blueprintId,
      name: row.name,
      package: {
        digest: row.packageDigest,
        sizeBytes: row.sizeBytes,
      },
      publisher: row.package.publisher,
      status: row.status,
      tags: row.package.tags,
      updatedAt: new Date(row.updatedAt).toISOString(),
      versionCount: row.versionCount,
    });
  }
}
