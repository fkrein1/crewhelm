import {
  DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
  DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  DEFAULT_RUNNABLE_AGENT_MODEL,
  MAXIMUM_FLEET_CONFIGURATION_REVISIONS,
  RUNNABLE_AGENT_MODELS,
  configureFleetConfigurationInputSchema,
  configureFleetConfigurationResultSchema,
  defaultFleetCapacity,
  defaultFleetExecutionLimits,
  defaultFleetRetention,
  fleetConfigurationDataSchema,
  fleetConfigurationSchema,
  getFleetConfigurationInputSchema,
  getFleetConfigurationResultSchema,
  type ConfigureFleetConfigurationInput,
  type ConfigureFleetConfigurationResult,
  type FleetConfiguration,
  type FleetConfigurationData,
  type FleetConfigurationPatch,
  type GetFleetConfigurationResult,
  type OwnerAuthority,
  type RunnableAgentModel,
} from "@crewhelm/contracts";
import { and, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  auditEvents,
  fleetConfigurationRevisions,
  fleetConfigurations,
  fleetConfigurationUpdates,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Failure = Extract<ConfigureFleetConfigurationResult, { ok: false }>;
type ConfigurationLookup =
  | { configuration: FleetConfiguration; status: "available" }
  | { status: "unavailable" };

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestConfigurationRequest(
  input: ConfigureFleetConfigurationInput,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        expectedRevision: input.expectedRevision,
        patch: input.patch,
        target: input.target,
      }),
    ),
  );

  return encodeBase64Url(new Uint8Array(digest));
}

function mergeConfiguration(
  current: FleetConfigurationData,
  patch: FleetConfigurationPatch,
): FleetConfigurationData | null {
  const candidate = fleetConfigurationDataSchema.safeParse({
    capacity: { ...current.capacity, ...patch.capacity },
    execution: { ...current.execution, ...patch.execution },
    integrations: { ...current.integrations, ...patch.integrations },
    models: { ...current.models, ...patch.models },
    retention: { ...current.retention, ...patch.retention },
    schedules: { ...current.schedules, ...patch.schedules },
  });

  return candidate.success ? candidate.data : null;
}

export function deniedFleetConfiguration(code: Failure["error"]["code"]): Failure {
  return {
    error: {
      code,
      message: "Fleet configuration request denied.",
    },
    ok: false,
  };
}

export class FleetConfigurations {
  readonly #database: Database;
  readonly #initialDefaultModel: RunnableAgentModel;

  constructor(
    database: Database,
    initialDefaultModel: RunnableAgentModel = DEFAULT_RUNNABLE_AGENT_MODEL,
  ) {
    this.#database = database;
    this.#initialDefaultModel = initialDefaultModel;
  }

  currentData(): FleetConfigurationData {
    return this.current().data;
  }

  current(): FleetConfiguration {
    const result = this.#lookupCurrent();

    if (result.status === "unavailable") {
      throw new Error("Fleet configuration invariant violated: no usable current revision.");
    }

    return result.configuration;
  }

  get(input: unknown): GetFleetConfigurationResult {
    if (!getFleetConfigurationInputSchema.safeParse(input).success) {
      return deniedFleetConfiguration("invalid_request");
    }

    const result = this.#lookupCurrent();

    if (result.status === "unavailable") {
      return deniedFleetConfiguration("incompatible_schema");
    }

    return getFleetConfigurationResultSchema.parse({
      configuration: result.configuration,
      ok: true,
    });
  }

  async configure(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ConfigureFleetConfigurationResult> {
    const request = configureFleetConfigurationInputSchema.safeParse(input);

    if (!request.success) {
      return deniedFleetConfiguration("invalid_request");
    }

    const requestDigest =
      request.data.mode === "apply" ? await digestConfigurationRequest(request.data) : null;
    const configuredAt = Date.now();

    return this.#database.transaction((transaction) => {
      this.#ensureDefault(transaction, configuredAt);

      if (request.data.mode === "apply") {
        const idempotencyKey = request.data.idempotencyKey;

        if (idempotencyKey === undefined) {
          return deniedFleetConfiguration("invalid_request");
        }

        const replay = transaction
          .select({
            configuration: fleetConfigurationRevisions.configuration,
            createdAt: fleetConfigurationRevisions.createdAt,
            requestDigest: fleetConfigurationUpdates.requestDigest,
            revision: fleetConfigurationRevisions.revision,
          })
          .from(fleetConfigurationUpdates)
          .innerJoin(
            fleetConfigurationRevisions,
            eq(fleetConfigurationRevisions.revision, fleetConfigurationUpdates.revision),
          )
          .where(
            and(
              eq(fleetConfigurationUpdates.clientId, authority.clientId),
              eq(fleetConfigurationUpdates.idempotencyKey, idempotencyKey),
            ),
          )
          .get();

        if (replay !== undefined) {
          if (replay.requestDigest !== requestDigest) {
            return deniedFleetConfiguration("idempotency_conflict");
          }

          const replayConfiguration = this.#configurationFromRow(replay);

          if (replayConfiguration.status === "unavailable") {
            return deniedFleetConfiguration("incompatible_schema");
          }

          return configureFleetConfigurationResultSchema.parse({
            applied: false,
            configuration: replayConfiguration.configuration,
            ok: true,
          });
        }
      }

      const currentLookup = this.#findCurrent(transaction);

      if (currentLookup.status === "unavailable") {
        return deniedFleetConfiguration("incompatible_schema");
      }
      const current = currentLookup.configuration;

      if (current.revision !== request.data.expectedRevision) {
        return deniedFleetConfiguration("revision_conflict");
      }

      const nextData = mergeConfiguration(current.data, request.data.patch);

      if (nextData === null) {
        return deniedFleetConfiguration("invalid_request");
      }

      if (JSON.stringify(nextData) === JSON.stringify(current.data)) {
        return deniedFleetConfiguration("no_changes");
      }

      if (request.data.mode === "preview") {
        return configureFleetConfigurationResultSchema.parse({
          applied: false,
          configuration: {
            configuredAt: new Date(configuredAt).toISOString(),
            data: nextData,
            revision: current.revision + 1,
          },
          ok: true,
        });
      }

      const idempotencyKey = request.data.idempotencyKey;

      if (idempotencyKey === undefined || requestDigest === null) {
        return deniedFleetConfiguration("invalid_request");
      }

      if (current.revision >= MAXIMUM_FLEET_CONFIGURATION_REVISIONS) {
        return deniedFleetConfiguration("revision_limit_exceeded");
      }

      const revision = current.revision + 1;

      transaction
        .insert(fleetConfigurationRevisions)
        .values({ configuration: nextData, createdAt: configuredAt, revision })
        .run();
      transaction
        .update(fleetConfigurations)
        .set({ currentRevision: revision })
        .where(eq(fleetConfigurations.singleton, 1))
        .run();
      transaction
        .insert(fleetConfigurationUpdates)
        .values({
          clientId: authority.clientId,
          idempotencyKey,
          requestDigest,
          revision,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "fleet_configuration.updated",
          clientId: authority.clientId,
          occurredAt: configuredAt,
          subjectId: `fleet_configuration:${revision}`,
        })
        .run();

      return configureFleetConfigurationResultSchema.parse({
        applied: true,
        configuration: {
          configuredAt: new Date(configuredAt).toISOString(),
          data: nextData,
          revision,
        },
        ok: true,
      });
    });
  }

  #lookupCurrent(): ConfigurationLookup {
    const currentTime = Date.now();

    return this.#database.transaction((transaction) => {
      this.#ensureDefault(transaction, currentTime);
      return this.#findCurrent(transaction);
    });
  }

  #findCurrent(database: Transaction): ConfigurationLookup {
    const row = database
      .select({
        configuration: fleetConfigurationRevisions.configuration,
        createdAt: fleetConfigurationRevisions.createdAt,
        revision: fleetConfigurationRevisions.revision,
      })
      .from(fleetConfigurations)
      .innerJoin(
        fleetConfigurationRevisions,
        eq(fleetConfigurationRevisions.revision, fleetConfigurations.currentRevision),
      )
      .where(eq(fleetConfigurations.singleton, 1))
      .get();

    return row === undefined ? { status: "unavailable" } : this.#configurationFromRow(row);
  }

  #defaultData(): FleetConfigurationData {
    return fleetConfigurationDataSchema.parse({
      capacity: defaultFleetCapacity,
      execution: defaultFleetExecutionLimits,
      integrations: {
        callsPerDay: DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
        callsPerThirtyDays: DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
        duplicateToolCallLimit: DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
        maxCallsPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
        maxCallsPerToolPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
        maxConcurrencyPerGrant: DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
      },
      models: {
        allowed: [...RUNNABLE_AGENT_MODELS].toSorted(),
        default: this.#initialDefaultModel,
      },
      retention: defaultFleetRetention,
      schedules: {
        minimumIntervalSeconds: DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
      },
    });
  }

  #ensureDefault(database: Transaction, createdAt: number): void {
    if (
      database
        .select({ singleton: fleetConfigurations.singleton })
        .from(fleetConfigurations)
        .where(eq(fleetConfigurations.singleton, 1))
        .get() !== undefined
    ) {
      return;
    }

    database
      .insert(fleetConfigurationRevisions)
      .values({ configuration: this.#defaultData(), createdAt, revision: 1 })
      .onConflictDoNothing()
      .run();
    database
      .insert(fleetConfigurations)
      .values({ currentRevision: 1, singleton: 1 })
      .onConflictDoNothing()
      .run();
  }

  #configurationFromRow(row: {
    configuration: FleetConfigurationData;
    createdAt: number;
    revision: number;
  }): ConfigurationLookup {
    const configuredAt = new Date(row.createdAt);

    if (Number.isNaN(configuredAt.valueOf())) {
      return { status: "unavailable" };
    }

    const configuration = fleetConfigurationSchema.safeParse({
      configuredAt: configuredAt.toISOString(),
      data: row.configuration,
      revision: row.revision,
    });

    return configuration.success
      ? { configuration: configuration.data, status: "available" }
      : { status: "unavailable" };
  }
}
