import {
  MAXIMUM_MODEL_CATALOG_REVISIONS,
  MAXIMUM_MODEL_DISCOVERY_ITEMS,
  configureModelCatalogInputSchema,
  configureModelCatalogResultSchema,
  crewhelmStarterModelCatalog,
  getModelCatalogInputSchema,
  getModelCatalogResultSchema,
  modelCatalogDataSchema,
  modelCatalogSchema,
  type ConfigureModelCatalogInput,
  type ConfigureModelCatalogResult,
  type GetModelCatalogResult,
  type ModelCatalog,
  type ModelCatalogData,
  type OwnerAuthority,
} from "@crewhelm/contracts";
import { and, count, eq, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  agentRevisions,
  agents,
  auditEvents,
  modelCatalogRevisions,
  modelCatalogs,
  modelCatalogUpdates,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Failure = Extract<ConfigureModelCatalogResult, { ok: false }>;
type CatalogLookup = { catalog: ModelCatalog; status: "available" } | { status: "unavailable" };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestRequest(input: ConfigureModelCatalogInput): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        change: input.change,
        expectedRevision: input.expectedRevision,
        target: input.target,
      }),
    ),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export function deniedModelCatalog(code: Failure["error"]["code"]): Failure {
  return { error: { code, message: "Model catalog request denied." }, ok: false };
}

function nextCatalog(
  current: ModelCatalogData,
  change: ConfigureModelCatalogInput["change"],
): ModelCatalogData | Failure {
  switch (change.kind) {
    case "add": {
      if (current.enabledModels.includes(change.modelId)) {
        return deniedModelCatalog("model_already_enabled");
      }
      const parsed = modelCatalogDataSchema.safeParse({
        ...current,
        enabledModels: [...current.enabledModels, change.modelId].toSorted(),
      });
      return parsed.success ? parsed.data : deniedModelCatalog("invalid_request");
    }
    case "remove": {
      if (!current.enabledModels.includes(change.modelId)) {
        return deniedModelCatalog("model_disabled");
      }
      if (current.enabledModels.length === 1) return deniedModelCatalog("last_model");
      if (
        current.defaultModel === change.modelId &&
        change.replacementDefaultModelId === undefined
      ) {
        return deniedModelCatalog("replacement_default_required");
      }
      const enabledModels = current.enabledModels.filter((model) => model !== change.modelId);
      const defaultModel =
        current.defaultModel === change.modelId
          ? change.replacementDefaultModelId
          : current.defaultModel;
      const parsed = modelCatalogDataSchema.safeParse({ defaultModel, enabledModels });
      return parsed.success ? parsed.data : deniedModelCatalog("invalid_request");
    }
    case "set-default": {
      if (!current.enabledModels.includes(change.modelId)) {
        return deniedModelCatalog("model_disabled");
      }
      if (current.defaultModel === change.modelId) return deniedModelCatalog("no_changes");
      return { ...current, defaultModel: change.modelId };
    }
  }

  change satisfies never;
  throw new Error("Invariant violated: unsupported model catalog change.");
}

export class ModelCatalogs {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  currentData(): ModelCatalogData {
    return this.current().data;
  }

  current(): ModelCatalog {
    const lookup = this.#lookupCurrent();
    if (lookup.status === "unavailable") {
      throw new Error("Model catalog invariant violated: no usable current revision.");
    }
    return lookup.catalog;
  }

  get(input: unknown): GetModelCatalogResult {
    if (!getModelCatalogInputSchema.safeParse(input).success) {
      return deniedModelCatalog("invalid_request");
    }
    const lookup = this.#lookupCurrent();
    return lookup.status === "available"
      ? getModelCatalogResultSchema.parse({ catalog: lookup.catalog, ok: true })
      : deniedModelCatalog("incompatible_schema");
  }

  async configure(authority: OwnerAuthority, input: unknown): Promise<ConfigureModelCatalogResult> {
    const request = configureModelCatalogInputSchema.safeParse(input);
    if (!request.success) return deniedModelCatalog("invalid_request");
    const requestDigest = request.data.mode === "apply" ? await digestRequest(request.data) : null;
    const configuredAt = Date.now();

    return this.#database.transaction((transaction) => {
      this.#ensureDefault(transaction, configuredAt);

      if (request.data.mode === "apply") {
        const idempotencyKey = request.data.idempotencyKey;
        if (idempotencyKey === undefined) return deniedModelCatalog("invalid_request");
        const replay = transaction
          .select({
            catalog: modelCatalogRevisions.catalog,
            createdAt: modelCatalogRevisions.createdAt,
            requestDigest: modelCatalogUpdates.requestDigest,
            revision: modelCatalogRevisions.revision,
          })
          .from(modelCatalogUpdates)
          .innerJoin(
            modelCatalogRevisions,
            eq(modelCatalogRevisions.revision, modelCatalogUpdates.revision),
          )
          .where(
            and(
              eq(modelCatalogUpdates.clientId, authority.clientId),
              eq(modelCatalogUpdates.idempotencyKey, idempotencyKey),
            ),
          )
          .get();
        if (replay !== undefined) {
          if (replay.requestDigest !== requestDigest) {
            return deniedModelCatalog("idempotency_conflict");
          }
          const catalog = this.#catalogFromRow(replay);
          return catalog.status === "available"
            ? configureModelCatalogResultSchema.parse({
                applied: false,
                catalog: catalog.catalog,
                impact: this.#impact(transaction, request.data.change),
                ok: true,
              })
            : deniedModelCatalog("incompatible_schema");
        }
      }

      const current = this.#findCurrent(transaction);
      if (current.status === "unavailable") return deniedModelCatalog("incompatible_schema");
      if (current.catalog.revision !== request.data.expectedRevision) {
        return deniedModelCatalog("revision_conflict");
      }
      const next = nextCatalog(current.catalog.data, request.data.change);
      if ("ok" in next) return next;
      const impact = this.#impact(transaction, request.data.change);
      const catalog = modelCatalogSchema.parse({
        configuredAt: new Date(configuredAt).toISOString(),
        data: next,
        revision: current.catalog.revision + 1,
      });
      if (request.data.mode === "preview") {
        return configureModelCatalogResultSchema.parse({
          applied: false,
          catalog,
          impact,
          ok: true,
        });
      }
      if (request.data.idempotencyKey === undefined || requestDigest === null) {
        return deniedModelCatalog("invalid_request");
      }
      if (current.catalog.revision >= MAXIMUM_MODEL_CATALOG_REVISIONS) {
        return deniedModelCatalog("revision_limit_exceeded");
      }
      transaction
        .insert(modelCatalogRevisions)
        .values({ catalog: next, createdAt: configuredAt, revision: catalog.revision })
        .run();
      transaction
        .update(modelCatalogs)
        .set({ currentRevision: catalog.revision })
        .where(eq(modelCatalogs.singleton, 1))
        .run();
      transaction
        .insert(modelCatalogUpdates)
        .values({
          clientId: authority.clientId,
          idempotencyKey: request.data.idempotencyKey,
          requestDigest,
          revision: catalog.revision,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: `model_catalog.${request.data.change.kind}`,
          clientId: authority.clientId,
          occurredAt: configuredAt,
          subjectId: request.data.change.modelId,
        })
        .run();
      return configureModelCatalogResultSchema.parse({ applied: true, catalog, impact, ok: true });
    });
  }

  #impact(database: Transaction, change: ConfigureModelCatalogInput["change"]) {
    if (change.kind !== "remove") {
      return { affectedAgents: [], affectedAgentsTotal: 0, truncated: false };
    }
    const where = sql<boolean>`
      ${agentRevisions.model} = ${change.modelId}
      OR EXISTS (
        SELECT 1
        FROM json_tree(${agentRevisions.capabilities}) AS configured_model
        WHERE configured_model.type = 'text'
          AND configured_model.value = ${change.modelId}
      )
    `;
    const affectedAgentsTotal =
      database
        .select({ value: count() })
        .from(agents)
        .innerJoin(
          agentRevisions,
          and(
            eq(agentRevisions.agentId, agents.agentId),
            eq(agentRevisions.revision, agents.currentRevision),
          ),
        )
        .where(where)
        .get()?.value ?? 0;
    const affectedAgents = database
      .select({
        id: agents.agentId,
        model: agentRevisions.model,
        name: agentRevisions.name,
        revision: agents.currentRevision,
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
      .where(where)
      .orderBy(agents.agentId)
      .limit(MAXIMUM_MODEL_DISCOVERY_ITEMS)
      .all();
    return {
      affectedAgents,
      affectedAgentsTotal,
      truncated: affectedAgentsTotal > affectedAgents.length,
    };
  }

  #lookupCurrent(): CatalogLookup {
    return this.#database.transaction((transaction) => {
      this.#ensureDefault(transaction, Date.now());
      return this.#findCurrent(transaction);
    });
  }

  #findCurrent(database: Transaction): CatalogLookup {
    const row = database
      .select({
        catalog: modelCatalogRevisions.catalog,
        createdAt: modelCatalogRevisions.createdAt,
        revision: modelCatalogRevisions.revision,
      })
      .from(modelCatalogs)
      .innerJoin(
        modelCatalogRevisions,
        eq(modelCatalogRevisions.revision, modelCatalogs.currentRevision),
      )
      .where(eq(modelCatalogs.singleton, 1))
      .get();
    return row === undefined ? { status: "unavailable" } : this.#catalogFromRow(row);
  }

  #ensureDefault(database: Transaction, createdAt: number): void {
    if (
      database
        .select({ singleton: modelCatalogs.singleton })
        .from(modelCatalogs)
        .where(eq(modelCatalogs.singleton, 1))
        .get() !== undefined
    ) {
      return;
    }
    database
      .insert(modelCatalogRevisions)
      .values({ catalog: crewhelmStarterModelCatalog, createdAt, revision: 1 })
      .onConflictDoNothing()
      .run();
    database
      .insert(modelCatalogs)
      .values({ currentRevision: 1, singleton: 1 })
      .onConflictDoNothing()
      .run();
  }

  #catalogFromRow(row: {
    catalog: ModelCatalogData;
    createdAt: number;
    revision: number;
  }): CatalogLookup {
    const configuredAt = new Date(row.createdAt);
    if (Number.isNaN(configuredAt.valueOf())) return { status: "unavailable" };
    const catalog = modelCatalogSchema.safeParse({
      configuredAt: configuredAt.toISOString(),
      data: row.catalog,
      revision: row.revision,
    });
    return catalog.success
      ? { catalog: catalog.data, status: "available" }
      : { status: "unavailable" };
  }
}
