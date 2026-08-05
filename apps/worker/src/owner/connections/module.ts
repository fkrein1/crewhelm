import {
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  INTEGRATION_ENABLEMENT_UNKNOWN_RECOVERY_MS,
  MAXIMUM_INTEGRATION_ENABLEMENT_REQUESTS_PER_OWNER,
  MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER,
  MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER,
  completeConnectionLinkInputSchema,
  completeIntegrationEnablementInputSchema,
  activateVerifiedAuthorizationReturnInputSchema,
  activateVerifiedConnectionInputSchema,
  connectionAuthorizationTokenSchema,
  composioConnectionSummarySchema,
  connectionSummarySchema,
  createConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  enableIntegrationInputSchema,
  enableIntegrationResultSchema,
  inspectConnectionInputSchema,
  inspectConnectionResultSchema,
  integrationAuthConfigListInputSchema,
  integrationAuthConfigListResultSchema,
  listConnectionsInputSchema,
  listConnectionsResultSchema,
  recordConnectionAuthorizationReturnInputSchema,
  recordConnectionAuthorizationReturnResultSchema,
  recordProviderAuthConfigInputSchema,
  recordProviderAuthConfigResultSchema,
  providerAuthSchemeSchema,
  reserveIntegrationEnablementResultSchema,
  reserveConnectionLinkResultSchema,
  type ConnectionSummary,
  type ComposioConnectionSummary,
  type ActivateVerifiedConnectionInput,
  type CreateConnectionLinkInput,
  type CreateConnectionLinkResult,
  type EnableIntegrationInput,
  type EnableIntegrationResult,
  type FleetConfigurationData,
  type InspectConnectionResult,
  type IntegrationAuthConfigListResult,
  type ListConnectionsResult,
  type OwnerAuthority,
  type RecordConnectionAuthorizationReturnInput,
  type RecordConnectionAuthorizationReturnResult,
  type RecordProviderAuthConfigResult,
  type ReserveIntegrationEnablementResult,
  type ReserveConnectionLinkResult,
} from "@crewhelm/contracts";
import { and, asc, count, desc, eq, gt, inArray, lte, min, sql } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";
import { alias } from "drizzle-orm/sqlite-core";

import { recordConnectionLinkCompletion } from "../../observability/integrations.js";
import {
  auditEvents,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  integrationEnablementRequests,
  providerAuthConfigs,
  providerAuthSetupRequests,
  remoteMcpConnections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type DatabaseWriter = Pick<Database, "update">;
type ConnectionLinkFailure = Extract<CreateConnectionLinkResult, { ok: false }>;
type ConnectionReadFailure = Extract<ListConnectionsResult, { ok: false }>;
type ConnectionInspectFailure = Extract<InspectConnectionResult, { ok: false }>;
type ConnectionAuthorizationReturnFailure = Extract<
  RecordConnectionAuthorizationReturnResult,
  { ok: false }
>;
type IntegrationEnablementFailure = Extract<EnableIntegrationResult, { ok: false }>;
type ProviderAuthConfigFailure = Extract<RecordProviderAuthConfigResult, { ok: false }>;
type ConnectionNextAction = Extract<InspectConnectionResult, { ok: true }>["nextAction"];
type VerifiedConnectionActivationResult =
  | { kind: "activated" }
  | {
      kind: "rejected";
      reason:
        | "authorization_not_returned"
        | "concurrent_change"
        | "connection_not_found"
        | "connection_unavailable"
        | "integration_mismatch"
        | "provider_connection_mismatch";
    };
type StoredConnectionLinkRow = {
  connectionId: string | null;
  expiresAt: number | null;
  redirectUrl: string | null;
};
type StoredConnectionSummaryRow = {
  accountLabel: string | null;
  authConfigId: string;
  authorizationOutcome: ConnectionSummary["authorizationOutcome"];
  connectionId: string;
  createdAt: number;
  integrationSlug: string | null;
  providerConnectionId: string;
  status: ConnectionSummary["status"];
};

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function digestCanonicalRequest(canonicalRequest: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));

  return encodeBase64Url(new Uint8Array(digest));
}

function createConnectionAuthorizationToken(): string {
  return connectionAuthorizationTokenSchema.parse(
    encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  );
}

async function digestConnectionLink(input: CreateConnectionLinkInput): Promise<string> {
  return digestCanonicalRequest(JSON.stringify({ authConfigId: input.authConfigId }));
}

async function digestIntegrationEnablement(input: EnableIntegrationInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      authConfigId: input.authConfigId ?? null,
      integrationSlug: input.integrationSlug,
    }),
  );
}

function isCanonicalComposioConnectUrl(value: string): boolean {
  const url = new URL(value);

  return (
    url.origin === COMPOSIO_CONNECT_ORIGIN &&
    /^\/link\/[A-Za-z0-9._~-]{4,512}$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === ""
  );
}

function unexpectedConnectionState(state: never): never {
  throw new TypeError(`Unexpected connection state: ${String(state)}`);
}

function authorizationReturnOutcome(
  status: RecordConnectionAuthorizationReturnInput["status"],
): "failed" | "returned" {
  switch (status) {
    case "failed":
      return "failed";
    case "success":
      return "returned";
  }

  return unexpectedConnectionState(status);
}

function nextConnectionAction(summary: ComposioConnectionSummary): ConnectionNextAction {
  switch (summary.status) {
    case "revoked":
      return "reconnect";
    case "unavailable":
      return "review_authorization";
    case "active":
    case "initiated":
      break;
  }

  switch (summary.authorizationOutcome) {
    case "failed":
      return "review_authorization";
    case "pending":
      return "wait";
    case "expired":
    case "returned":
    case "untracked":
      return "none";
  }

  return unexpectedConnectionState(summary.authorizationOutcome);
}

function nextRemoteConnectionAction(status: ConnectionSummary["status"]): ConnectionNextAction {
  switch (status) {
    case "active":
      return "none";
    case "initiated":
      return "wait";
    case "revoked":
      return "reconnect";
    case "unavailable":
      return "review_authorization";
  }

  return unexpectedConnectionState(status);
}

export function deniedConnectionLink(
  code: ConnectionLinkFailure["error"]["code"],
  operation?: ConnectionLinkFailure["error"]["operation"],
): ConnectionLinkFailure {
  return {
    error: {
      code,
      message: "Connection link request denied.",
      ...(operation === undefined ? {} : { operation }),
    },
    ok: false,
  };
}

export function deniedConnectionRead(
  code: ConnectionReadFailure["error"]["code"],
): ConnectionReadFailure {
  return {
    error: { code, message: "Connection request denied." },
    ok: false,
  };
}

export function deniedConnectionInspect(
  code: ConnectionInspectFailure["error"]["code"],
): ConnectionInspectFailure {
  return {
    error: { code, message: "Connection request denied." },
    ok: false,
  };
}

export function deniedConnectionAuthorizationReturn(): ConnectionAuthorizationReturnFailure {
  return {
    error: { code: "invalid_return", message: "Connection authorization return denied." },
    ok: false,
  };
}

export function deniedIntegrationEnablement(
  code: IntegrationEnablementFailure["error"]["code"],
  operation?: IntegrationEnablementFailure["error"]["operation"],
): IntegrationEnablementFailure {
  return {
    error: {
      code,
      message: "Integration enablement request denied.",
      ...(operation === undefined ? {} : { operation }),
    },
    ok: false,
  };
}

export function deniedProviderAuthConfig(
  code: ProviderAuthConfigFailure["error"]["code"],
): ProviderAuthConfigFailure {
  return {
    error: {
      code,
      message: "Provider authentication configuration request denied.",
    },
    ok: false,
  };
}

export class Connections {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: Database;
  readonly #storage: DurableObjectStorage;

  constructor(
    database: Database,
    storage: DurableObjectStorage,
    currentFleetConfiguration: () => FleetConfigurationData,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#storage = storage;
  }

  async reserveIntegrationEnablement(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ReserveIntegrationEnablementResult> {
    const request = enableIntegrationInputSchema.safeParse(input);

    if (!request.success) {
      return deniedIntegrationEnablement("invalid_request");
    }
    const requestDigest = await digestIntegrationEnablement(request.data);
    const currentTime = Date.now();
    const recoverAfter = currentTime + INTEGRATION_ENABLEMENT_UNKNOWN_RECOVERY_MS;

    await this.#scheduleCleanup(recoverAfter);

    return this.#database.transaction((transaction) => {
      this.#expireIntegrationEnablements(transaction, currentTime);
      const existing = transaction
        .select({
          authConfigId: integrationEnablementRequests.authConfigId,
          authScheme: integrationEnablementRequests.authScheme,
          integrationSlug: integrationEnablementRequests.integrationSlug,
          recoverAfter: integrationEnablementRequests.recoverAfter,
          requestDigest: integrationEnablementRequests.requestDigest,
          reservationId: integrationEnablementRequests.reservationId,
          status: integrationEnablementRequests.status,
        })
        .from(integrationEnablementRequests)
        .where(
          and(
            eq(integrationEnablementRequests.clientId, authority.clientId),
            eq(integrationEnablementRequests.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) {
          return deniedIntegrationEnablement("idempotency_conflict");
        }

        if (existing.status === "pending") {
          return deniedIntegrationEnablement("integration_enablement_outcome_unknown", {
            nextAction: "retry_same_request",
            recoverAfter: new Date(existing.recoverAfter).toISOString(),
            reservationId: existing.reservationId,
          });
        }

        if (existing.status === "completed") {
          if (existing.authConfigId === null || existing.authScheme === null) {
            return deniedIntegrationEnablement("integration_enablement_outcome_unknown", {
              nextAction: "retry_same_request",
              recoverAfter: new Date(existing.recoverAfter).toISOString(),
              reservationId: existing.reservationId,
            });
          }

          const authConfig = transaction
            .select({ source: providerAuthConfigs.source })
            .from(providerAuthConfigs)
            .where(eq(providerAuthConfigs.authConfigId, existing.authConfigId))
            .get();
          if (authConfig === undefined) return deniedIntegrationEnablement("invalid_request");

          return reserveIntegrationEnablementResultSchema.parse({
            authConfigId: existing.authConfigId,
            authScheme: existing.authScheme,
            integrationSlug: existing.integrationSlug,
            managed: authConfig.source === "composio_managed",
            ok: true,
            state: "replay",
          });
        }

        const pending = transaction
          .select({ reservationId: integrationEnablementRequests.reservationId })
          .from(integrationEnablementRequests)
          .where(
            and(
              eq(integrationEnablementRequests.integrationSlug, request.data.integrationSlug),
              eq(integrationEnablementRequests.status, "pending"),
              gt(integrationEnablementRequests.recoverAfter, currentTime),
            ),
          )
          .limit(1)
          .all()[0];

        if (pending !== undefined) {
          return deniedIntegrationEnablement("integration_enablement_in_progress");
        }

        const configCount =
          transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
        const managedReservedCount =
          transaction
            .select({ value: count() })
            .from(integrationEnablementRequests)
            .where(eq(integrationEnablementRequests.status, "pending"))
            .get()?.value ?? 0;
        const customReservedCount =
          transaction
            .select({ value: count() })
            .from(providerAuthSetupRequests)
            .where(inArray(providerAuthSetupRequests.status, ["submitting", "outcome_unknown"]))
            .get()?.value ?? 0;
        if (
          configCount + managedReservedCount + customReservedCount >=
          MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER
        ) {
          return deniedIntegrationEnablement("provider_auth_config_limit_exceeded");
        }

        transaction
          .update(integrationEnablementRequests)
          .set({ recoverAfter, status: "pending" })
          .where(
            and(
              eq(integrationEnablementRequests.clientId, authority.clientId),
              eq(integrationEnablementRequests.reservationId, existing.reservationId),
              eq(integrationEnablementRequests.status, "abandoned"),
            ),
          )
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "integration.enablement_reserved",
            clientId: authority.clientId,
            occurredAt: currentTime,
            subjectId: existing.reservationId,
          })
          .run();

        return reserveIntegrationEnablementResultSchema.parse({
          ok: true,
          recoverAfter: new Date(recoverAfter).toISOString(),
          reservationId: existing.reservationId,
          state: "dispatch",
        });
      }

      const pending = transaction
        .select({ reservationId: integrationEnablementRequests.reservationId })
        .from(integrationEnablementRequests)
        .where(
          and(
            eq(integrationEnablementRequests.integrationSlug, request.data.integrationSlug),
            eq(integrationEnablementRequests.status, "pending"),
            gt(integrationEnablementRequests.recoverAfter, currentTime),
          ),
        )
        .limit(1)
        .all()[0];

      if (pending !== undefined) {
        return deniedIntegrationEnablement("integration_enablement_in_progress");
      }

      const configCount =
        transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
      const managedReservedCount =
        transaction
          .select({ value: count() })
          .from(integrationEnablementRequests)
          .where(eq(integrationEnablementRequests.status, "pending"))
          .get()?.value ?? 0;
      const customReservedCount =
        transaction
          .select({ value: count() })
          .from(providerAuthSetupRequests)
          .where(inArray(providerAuthSetupRequests.status, ["submitting", "outcome_unknown"]))
          .get()?.value ?? 0;
      if (
        configCount + managedReservedCount + customReservedCount >=
        MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER
      ) {
        return deniedIntegrationEnablement("provider_auth_config_limit_exceeded");
      }

      const requestCount =
        transaction.select({ value: count() }).from(integrationEnablementRequests).get()?.value ??
        0;

      if (requestCount >= MAXIMUM_INTEGRATION_ENABLEMENT_REQUESTS_PER_OWNER) {
        return deniedIntegrationEnablement("integration_enablement_request_limit_exceeded");
      }

      const reservationId = `integration_enablement_${crypto.randomUUID()}`;

      transaction
        .insert(integrationEnablementRequests)
        .values({
          clientId: authority.clientId,
          createdAt: currentTime,
          idempotencyKey: request.data.idempotencyKey,
          integrationSlug: request.data.integrationSlug,
          recoverAfter,
          requestDigest,
          reservationId,
          status: "pending",
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "integration.enablement_reserved",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: reservationId,
        })
        .run();

      return reserveIntegrationEnablementResultSchema.parse({
        ok: true,
        recoverAfter: new Date(recoverAfter).toISOString(),
        reservationId,
        state: "dispatch",
      });
    });
  }

  completeIntegrationEnablement(
    authority: OwnerAuthority,
    input: unknown,
  ): EnableIntegrationResult {
    const request = completeIntegrationEnablementInputSchema.safeParse(input);

    if (!request.success) {
      return deniedIntegrationEnablement("invalid_request");
    }
    const normalizedAuthScheme = providerAuthSchemeSchema.safeParse(
      request.data.authScheme.toUpperCase(),
    );
    if (!normalizedAuthScheme.success) return deniedIntegrationEnablement("invalid_request");
    const expectedSource = request.data.managed ? "composio_managed" : "crewhelm_custom";

    return this.#database.transaction((transaction) => {
      const currentTime = Date.now();
      const displayName = request.data.name;

      this.#expireIntegrationEnablements(transaction, currentTime);
      const row = transaction
        .select({
          authConfigId: integrationEnablementRequests.authConfigId,
          authScheme: integrationEnablementRequests.authScheme,
          integrationSlug: integrationEnablementRequests.integrationSlug,
          recoverAfter: integrationEnablementRequests.recoverAfter,
          status: integrationEnablementRequests.status,
        })
        .from(integrationEnablementRequests)
        .where(
          and(
            eq(integrationEnablementRequests.clientId, authority.clientId),
            eq(integrationEnablementRequests.reservationId, request.data.reservationId),
          ),
        )
        .all()[0];

      if (row === undefined || row.integrationSlug !== request.data.integrationSlug) {
        return deniedIntegrationEnablement("invalid_request");
      }

      const storedAuthConfig = transaction
        .select()
        .from(providerAuthConfigs)
        .where(eq(providerAuthConfigs.authConfigId, request.data.authConfigId))
        .get();

      if (
        storedAuthConfig !== undefined &&
        (storedAuthConfig.integrationSlug !== request.data.integrationSlug ||
          storedAuthConfig.authScheme !== normalizedAuthScheme.data ||
          storedAuthConfig.source !== expectedSource)
      ) {
        return deniedIntegrationEnablement("invalid_request");
      }

      if (row.status === "completed") {
        if (
          storedAuthConfig === undefined ||
          row.authConfigId !== request.data.authConfigId ||
          row.authScheme !== request.data.authScheme
        ) {
          return deniedIntegrationEnablement("invalid_request");
        }

        return enableIntegrationResultSchema.parse({
          authConfigId: row.authConfigId,
          authScheme: row.authScheme,
          created: false,
          integrationSlug: row.integrationSlug,
          managed: request.data.managed,
          ok: true,
        });
      }

      if (row.status !== "pending" || currentTime >= row.recoverAfter) {
        return deniedIntegrationEnablement("integration_enablement_outcome_unknown", {
          nextAction: "retry_same_request",
          recoverAfter: new Date(row.recoverAfter).toISOString(),
          reservationId: request.data.reservationId,
        });
      }

      const authConfigCount =
        transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
      if (
        storedAuthConfig === undefined &&
        authConfigCount >= MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER
      ) {
        return deniedIntegrationEnablement("provider_auth_config_limit_exceeded");
      }

      transaction
        .update(integrationEnablementRequests)
        .set({
          authConfigId: request.data.authConfigId,
          authScheme: request.data.authScheme,
          completedAt: currentTime,
          status: "completed",
        })
        .where(
          and(
            eq(integrationEnablementRequests.clientId, authority.clientId),
            eq(integrationEnablementRequests.reservationId, request.data.reservationId),
            eq(integrationEnablementRequests.status, "pending"),
          ),
        )
        .run();
      transaction
        .insert(providerAuthConfigs)
        .values({
          authConfigId: request.data.authConfigId,
          authScheme: normalizedAuthScheme.data,
          createdAt: currentTime,
          displayName,
          integrationSlug: request.data.integrationSlug,
          source: expectedSource,
          updatedAt: currentTime,
        })
        .onConflictDoUpdate({
          set: { displayName, updatedAt: currentTime },
          target: providerAuthConfigs.authConfigId,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "integration.enabled",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: request.data.authConfigId,
        })
        .run();

      return enableIntegrationResultSchema.parse({
        authConfigId: request.data.authConfigId,
        authScheme: request.data.authScheme,
        created: request.data.created,
        integrationSlug: request.data.integrationSlug,
        managed: request.data.managed,
        ok: true,
      });
    });
  }

  recordProviderAuthConfig(
    authority: OwnerAuthority,
    input: unknown,
  ): RecordProviderAuthConfigResult {
    const request = recordProviderAuthConfigInputSchema.safeParse(input);
    if (!request.success) return deniedProviderAuthConfig("invalid_request");

    return this.#database.transaction((transaction) => {
      const existing = transaction
        .select()
        .from(providerAuthConfigs)
        .where(eq(providerAuthConfigs.authConfigId, request.data.authConfigId))
        .get();
      const currentTime = Date.now();

      if (existing !== undefined) {
        if (
          existing.integrationSlug !== request.data.integrationSlug ||
          existing.authScheme !== request.data.authScheme ||
          existing.source !== request.data.source
        ) {
          return deniedProviderAuthConfig("invalid_request");
        }

        if (existing.displayName !== request.data.name) {
          transaction
            .update(providerAuthConfigs)
            .set({ displayName: request.data.name, updatedAt: currentTime })
            .where(eq(providerAuthConfigs.authConfigId, request.data.authConfigId))
            .run();
        }

        return recordProviderAuthConfigResultSchema.parse({
          authConfig: request.data,
          created: false,
          ok: true,
        });
      }

      const countAuthConfigs =
        transaction.select({ value: count() }).from(providerAuthConfigs).get()?.value ?? 0;
      if (countAuthConfigs >= MAXIMUM_PROVIDER_AUTH_CONFIGS_PER_OWNER) {
        return deniedProviderAuthConfig("provider_auth_config_limit_exceeded");
      }
      if (request.data.source !== "composio_managed") {
        return deniedProviderAuthConfig("invalid_request");
      }

      transaction
        .insert(providerAuthConfigs)
        .values({
          authConfigId: request.data.authConfigId,
          authScheme: request.data.authScheme,
          createdAt: currentTime,
          displayName: request.data.name,
          integrationSlug: request.data.integrationSlug,
          source: request.data.source,
          updatedAt: currentTime,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "integration.auth_config_recorded",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: request.data.authConfigId,
        })
        .run();

      return recordProviderAuthConfigResultSchema.parse({
        authConfig: request.data,
        created: true,
        ok: true,
      });
    });
  }

  listProviderAuthConfigs(input: unknown): IntegrationAuthConfigListResult {
    const request = integrationAuthConfigListInputSchema.safeParse(input);
    if (!request.success) {
      return integrationAuthConfigListResultSchema.parse({
        error: {
          code: "integration_catalog_unavailable",
          message: "Integration catalog request denied.",
        },
        ok: false,
      });
    }

    const predicates = [eq(providerAuthConfigs.integrationSlug, request.data.integrationSlug)];
    if (request.data.cursor !== undefined) {
      predicates.push(gt(providerAuthConfigs.authConfigId, request.data.cursor));
    }
    const rows = this.#database
      .select()
      .from(providerAuthConfigs)
      .where(and(...predicates))
      .orderBy(asc(providerAuthConfigs.authConfigId))
      .limit(request.data.limit + 1)
      .all();
    const hasNextPage = rows.length > request.data.limit;
    const page = rows.slice(0, request.data.limit);

    return integrationAuthConfigListResultSchema.parse({
      authConfigs: page.map((row) => ({
        authConfigId: row.authConfigId,
        authScheme: row.authScheme.toLowerCase(),
        managed: row.source === "composio_managed",
        name: row.displayName,
      })),
      nextCursor: hasNextPage ? (page.at(-1)?.authConfigId ?? null) : null,
      ok: true,
    });
  }

  async reserve(authority: OwnerAuthority, input: unknown): Promise<ReserveConnectionLinkResult> {
    const request = createConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionLink("invalid_request");
    }

    const requestDigest = await digestConnectionLink(request.data);
    const authorizationToken = createConnectionAuthorizationToken();
    const authorizationTokenDigest = await digestCanonicalRequest(authorizationToken);
    const currentTime = Date.now();
    const recoverAfter = currentTime + CONNECTION_LINK_UNKNOWN_RECOVERY_MS;

    await this.#scheduleCleanup(recoverAfter);

    return this.#database.transaction((transaction) => {
      this.#expireRequests(transaction, currentTime);

      const authConfig = transaction
        .select({ authConfigId: providerAuthConfigs.authConfigId })
        .from(providerAuthConfigs)
        .where(eq(providerAuthConfigs.authConfigId, request.data.authConfigId))
        .get();
      if (authConfig === undefined) return deniedConnectionLink("invalid_request");

      const existingRequest = transaction
        .select({
          authConfigId: connectionLinkRequests.authConfigId,
          connectionId: connectionLinkRequests.connectionId,
          expiresAt: connectionLinkRequests.expiresAt,
          recoverAfter: connectionLinkRequests.recoverAfter,
          redirectUrl: connectionLinkRequests.redirectUrl,
          requestDigest: connectionLinkRequests.requestDigest,
          reservationId: connectionLinkRequests.reservationId,
          status: connectionLinkRequests.status,
        })
        .from(connectionLinkRequests)
        .where(
          and(
            eq(connectionLinkRequests.clientId, authority.clientId),
            eq(connectionLinkRequests.idempotencyKey, request.data.idempotencyKey),
          ),
        )
        .all()[0];

      if (existingRequest !== undefined) {
        if (existingRequest.requestDigest !== requestDigest) {
          return deniedConnectionLink("idempotency_conflict");
        }

        if (existingRequest.status === "expired") {
          return deniedConnectionLink("connection_link_expired");
        }

        if (existingRequest.status === "pending") {
          return deniedConnectionLink("connection_link_outcome_unknown", {
            nextAction: "retry_same_request",
            recoverAfter: new Date(existingRequest.recoverAfter).toISOString(),
            reservationId: existingRequest.reservationId,
          });
        }

        if (existingRequest.status === "completed") {
          if (existingRequest.expiresAt === null || existingRequest.expiresAt <= currentTime) {
            return deniedConnectionLink("connection_link_expired");
          }

          return reserveConnectionLinkResultSchema.parse({
            connectionLink: this.#linkFromRow(existingRequest),
            ok: true,
            state: "replay",
          });
        }

        const pendingRequest = transaction
          .select({ reservationId: connectionLinkRequests.reservationId })
          .from(connectionLinkRequests)
          .where(
            and(
              eq(connectionLinkRequests.authConfigId, existingRequest.authConfigId),
              eq(connectionLinkRequests.status, "pending"),
              gt(connectionLinkRequests.recoverAfter, currentTime),
            ),
          )
          .limit(1)
          .all()[0];

        if (pendingRequest !== undefined) {
          return deniedConnectionLink("connection_link_in_progress");
        }

        const connectionCount =
          transaction.select({ value: count() }).from(connections).get()?.value ?? 0;
        const pendingCount =
          transaction
            .select({ value: count() })
            .from(connectionLinkRequests)
            .where(
              and(
                eq(connectionLinkRequests.status, "pending"),
                gt(connectionLinkRequests.recoverAfter, currentTime),
              ),
            )
            .get()?.value ?? 0;

        if (
          connectionCount + pendingCount >=
          this.#currentFleetConfiguration().capacity.maxConnections
        ) {
          return deniedConnectionLink("connection_limit_exceeded");
        }

        transaction
          .update(connectionLinkRequests)
          .set({ recoverAfter, status: "pending" })
          .where(
            and(
              eq(connectionLinkRequests.clientId, authority.clientId),
              eq(connectionLinkRequests.reservationId, existingRequest.reservationId),
              eq(connectionLinkRequests.status, "abandoned"),
            ),
          )
          .run();
        transaction
          .update(connectionAuthorizationReturns)
          .set({
            completedAt: null,
            connectionId: null,
            createdAt: currentTime,
            expiresAt: recoverAfter,
            status: "pending",
            tokenDigest: authorizationTokenDigest,
          })
          .where(eq(connectionAuthorizationReturns.reservationId, existingRequest.reservationId))
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "connection.link_reserved",
            clientId: authority.clientId,
            occurredAt: currentTime,
            subjectId: existingRequest.reservationId,
          })
          .run();

        return reserveConnectionLinkResultSchema.parse({
          authorizationExpiresAt: new Date(recoverAfter).toISOString(),
          authorizationToken,
          ok: true,
          recoverAfter: new Date(recoverAfter).toISOString(),
          reservationId: existingRequest.reservationId,
          state: "dispatch",
        });
      }

      const pendingRequest = transaction
        .select({ reservationId: connectionLinkRequests.reservationId })
        .from(connectionLinkRequests)
        .where(
          and(
            eq(connectionLinkRequests.authConfigId, request.data.authConfigId),
            eq(connectionLinkRequests.status, "pending"),
            gt(connectionLinkRequests.recoverAfter, currentTime),
          ),
        )
        .limit(1)
        .all()[0];

      if (pendingRequest !== undefined) {
        return deniedConnectionLink("connection_link_in_progress");
      }

      const requestCount =
        transaction.select({ value: count() }).from(connectionLinkRequests).get()?.value ?? 0;

      if (requestCount >= MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER) {
        return deniedConnectionLink("connection_link_request_limit_exceeded");
      }

      const connectionCount =
        transaction.select({ value: count() }).from(connections).get()?.value ?? 0;
      const pendingCount =
        transaction
          .select({ value: count() })
          .from(connectionLinkRequests)
          .where(
            and(
              eq(connectionLinkRequests.status, "pending"),
              gt(connectionLinkRequests.recoverAfter, currentTime),
            ),
          )
          .get()?.value ?? 0;

      if (
        connectionCount + pendingCount >=
        this.#currentFleetConfiguration().capacity.maxConnections
      ) {
        return deniedConnectionLink("connection_limit_exceeded");
      }

      const reservationId = `connection_link_${crypto.randomUUID()}`;

      transaction
        .insert(connectionLinkRequests)
        .values({
          authConfigId: request.data.authConfigId,
          clientId: authority.clientId,
          createdAt: currentTime,
          idempotencyKey: request.data.idempotencyKey,
          recoverAfter,
          requestDigest,
          reservationId,
          status: "pending",
        })
        .run();
      transaction
        .insert(connectionAuthorizationReturns)
        .values({
          createdAt: currentTime,
          expiresAt: recoverAfter,
          reservationId,
          status: "pending",
          tokenDigest: authorizationTokenDigest,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.link_reserved",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: reservationId,
        })
        .run();

      return reserveConnectionLinkResultSchema.parse({
        authorizationExpiresAt: new Date(recoverAfter).toISOString(),
        authorizationToken,
        ok: true,
        recoverAfter: new Date(recoverAfter).toISOString(),
        reservationId,
        state: "dispatch",
      });
    });
  }

  async complete(authority: OwnerAuthority, input: unknown): Promise<CreateConnectionLinkResult> {
    const request = completeConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      recordConnectionLinkCompletion({ outcome: "invalid_schema" });
      return deniedConnectionLink("invalid_request");
    }

    if (!isCanonicalComposioConnectUrl(request.data.url)) {
      recordConnectionLinkCompletion({
        correlationId: request.data.reservationId,
        outcome: "invalid_url",
      });
      return deniedConnectionLink("invalid_request");
    }

    const authorizationTokenDigest = await digestCanonicalRequest(request.data.authorizationToken);
    const result = this.#database.transaction((transaction) => {
      const currentTime = Date.now();

      this.#expireRequests(transaction, currentTime);

      const row = transaction
        .select({
          authConfigId: connectionLinkRequests.authConfigId,
          authorizationStatus: connectionAuthorizationReturns.status,
          authorizationTokenDigest: connectionAuthorizationReturns.tokenDigest,
          connectionId: connectionLinkRequests.connectionId,
          expiresAt: connectionLinkRequests.expiresAt,
          providerConnectionId: connections.providerConnectionId,
          recoverAfter: connectionLinkRequests.recoverAfter,
          redirectUrl: connectionLinkRequests.redirectUrl,
          status: connectionLinkRequests.status,
        })
        .from(connectionLinkRequests)
        .leftJoin(
          connectionAuthorizationReturns,
          eq(connectionAuthorizationReturns.reservationId, connectionLinkRequests.reservationId),
        )
        .leftJoin(connections, eq(connections.connectionId, connectionLinkRequests.connectionId))
        .where(
          and(
            eq(connectionLinkRequests.clientId, authority.clientId),
            eq(connectionLinkRequests.reservationId, request.data.reservationId),
          ),
        )
        .all()[0];

      if (row === undefined || row.authorizationTokenDigest !== authorizationTokenDigest) {
        recordConnectionLinkCompletion({
          correlationId: request.data.reservationId,
          outcome: "invalid_reservation",
        });
        return deniedConnectionLink("invalid_request");
      }

      if (row.status === "expired") {
        return deniedConnectionLink("connection_link_expired");
      }

      if (row.status === "completed") {
        if (
          row.providerConnectionId !== request.data.providerConnectionId ||
          row.redirectUrl !== request.data.url ||
          row.expiresAt !== Date.parse(request.data.expiresAt)
        ) {
          recordConnectionLinkCompletion({
            correlationId: request.data.reservationId,
            outcome: "invalid_reservation",
          });
          return deniedConnectionLink("invalid_request");
        }

        recordConnectionLinkCompletion({
          correlationId: request.data.reservationId,
          outcome: "replayed",
        });
        return createConnectionLinkResultSchema.parse({
          connectionLink: this.#linkFromRow(row),
          created: false,
          ok: true,
        });
      }

      const recoverAfter = row.recoverAfter;
      const expiresAt = Date.parse(request.data.expiresAt);

      if (
        row.status !== "pending" ||
        row.authorizationStatus !== "pending" ||
        currentTime >= recoverAfter ||
        expiresAt <= currentTime ||
        expiresAt > recoverAfter
      ) {
        recordConnectionLinkCompletion({
          correlationId: request.data.reservationId,
          outcome: "invalid_state",
        });
        return deniedConnectionLink("connection_link_outcome_unknown", {
          nextAction: "retry_same_request",
          recoverAfter: new Date(recoverAfter).toISOString(),
          reservationId: request.data.reservationId,
        });
      }

      const existingConnection = transaction
        .select({
          authConfigId: connections.authConfigId,
          connectionId: connections.connectionId,
        })
        .from(connections)
        .where(eq(connections.providerConnectionId, request.data.providerConnectionId))
        .all()[0];
      let connectionId: string;

      if (existingConnection === undefined) {
        connectionId = `connection_${crypto.randomUUID()}`;
        transaction
          .insert(connections)
          .values({
            authConfigId: row.authConfigId,
            connectionId,
            createdAt: currentTime,
            provider: "composio",
            providerConnectionId: request.data.providerConnectionId,
            status: "initiated",
          })
          .run();
      } else {
        if (existingConnection.authConfigId !== row.authConfigId) {
          return deniedConnectionLink("connection_link_outcome_unknown", {
            nextAction: "retry_same_request",
            recoverAfter: new Date(recoverAfter).toISOString(),
            reservationId: request.data.reservationId,
          });
        }

        connectionId = existingConnection.connectionId;
      }

      transaction
        .update(connectionLinkRequests)
        .set({
          completedAt: currentTime,
          connectionId,
          expiresAt,
          redirectUrl: request.data.url,
          status: "completed",
        })
        .where(
          and(
            eq(connectionLinkRequests.clientId, authority.clientId),
            eq(connectionLinkRequests.reservationId, request.data.reservationId),
            eq(connectionLinkRequests.status, "pending"),
          ),
        )
        .run();
      transaction
        .update(connectionAuthorizationReturns)
        .set({ connectionId, expiresAt })
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, authorizationTokenDigest),
            eq(connectionAuthorizationReturns.status, "pending"),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.link_created",
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: connectionId,
        })
        .run();

      const completion = createConnectionLinkResultSchema.parse({
        connectionLink: {
          connectionId,
          expiresAt: request.data.expiresAt,
          url: request.data.url,
        },
        created: true,
        ok: true,
      });
      recordConnectionLinkCompletion({
        correlationId: request.data.reservationId,
        outcome: "accepted",
      });
      return completion;
    });

    if (result.ok) {
      await this.#scheduleCleanup(Date.parse(result.connectionLink.expiresAt));
    }

    return result;
  }

  async recordAuthorizationReturn(
    input: unknown,
  ): Promise<RecordConnectionAuthorizationReturnResult> {
    const request = recordConnectionAuthorizationReturnInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionAuthorizationReturn();
    }

    const tokenDigest = await digestCanonicalRequest(request.data.authorizationToken);

    return this.#database.transaction((transaction) => {
      const currentTime = Date.now();

      this.#expireRequests(transaction, currentTime);

      const row = transaction
        .select({
          authorizationExpiresAt: connectionAuthorizationReturns.expiresAt,
          authorizationStatus: connectionAuthorizationReturns.status,
          clientId: connectionLinkRequests.clientId,
          connectionId: connectionAuthorizationReturns.connectionId,
          integrationSlug: providerAuthConfigs.integrationSlug,
          providerConnectionId: connections.providerConnectionId,
          requestStatus: connectionLinkRequests.status,
        })
        .from(connectionAuthorizationReturns)
        .innerJoin(
          connectionLinkRequests,
          eq(connectionLinkRequests.reservationId, connectionAuthorizationReturns.reservationId),
        )
        .leftJoin(
          connections,
          eq(connections.connectionId, connectionAuthorizationReturns.connectionId),
        )
        .leftJoin(
          providerAuthConfigs,
          eq(providerAuthConfigs.authConfigId, connections.authConfigId),
        )
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, tokenDigest),
          ),
        )
        .all()[0];

      if (row === undefined) {
        return deniedConnectionAuthorizationReturn();
      }

      const desiredOutcome = authorizationReturnOutcome(request.data.status);
      const currentOutcome = row.authorizationStatus;
      const storedProviderConnectionId = row.providerConnectionId;

      if (
        row.connectionId === null ||
        typeof storedProviderConnectionId !== "string" ||
        row.integrationSlug === null
      ) {
        return deniedConnectionAuthorizationReturn();
      }
      const connection = {
        connectionId: row.connectionId,
        integrationSlug: row.integrationSlug,
        providerConnectionId: storedProviderConnectionId,
      };

      if (currentOutcome === "returned" || currentOutcome === "failed") {
        if (
          currentOutcome !== desiredOutcome ||
          (request.data.providerConnectionId !== undefined &&
            request.data.providerConnectionId !== storedProviderConnectionId) ||
          (desiredOutcome === "returned" &&
            request.data.providerConnectionId !== storedProviderConnectionId)
        ) {
          return deniedConnectionAuthorizationReturn();
        }

        return recordConnectionAuthorizationReturnResultSchema.parse({
          connection,
          ok: true,
          outcome: desiredOutcome,
          recorded: false,
        });
      }

      if (
        currentOutcome !== "pending" ||
        row.requestStatus !== "completed" ||
        row.authorizationExpiresAt <= currentTime ||
        row.connectionId === null ||
        storedProviderConnectionId === null ||
        (request.data.providerConnectionId !== undefined &&
          request.data.providerConnectionId !== storedProviderConnectionId) ||
        (desiredOutcome === "returned" &&
          request.data.providerConnectionId !== storedProviderConnectionId)
      ) {
        return deniedConnectionAuthorizationReturn();
      }

      transaction
        .update(connectionAuthorizationReturns)
        .set({ completedAt: currentTime, status: desiredOutcome })
        .where(
          and(
            eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
            eq(connectionAuthorizationReturns.tokenDigest, tokenDigest),
            eq(connectionAuthorizationReturns.status, "pending"),
          ),
        )
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action:
            desiredOutcome === "returned"
              ? "connection.authorization_returned"
              : "connection.authorization_failed",
          clientId: row.clientId,
          occurredAt: currentTime,
          subjectId: row.connectionId,
        })
        .run();

      return recordConnectionAuthorizationReturnResultSchema.parse({
        connection,
        ok: true,
        outcome: desiredOutcome,
        recorded: true,
      });
    });
  }

  list(input: unknown): ListConnectionsResult {
    const request = listConnectionsInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionRead("invalid_request");
    }

    if (request.data.connectionId !== undefined) {
      const remote = this.#database
        .select({
          accountLabel: connections.accountLabel,
          authKind: remoteMcpConnections.authKind,
          connectionId: connections.connectionId,
          createdAt: connections.createdAt,
          status: connections.status,
        })
        .from(connections)
        .innerJoin(
          remoteMcpConnections,
          eq(remoteMcpConnections.connectionId, connections.connectionId),
        )
        .where(
          and(
            eq(connections.connectionId, request.data.connectionId),
            eq(connections.provider, "remote_mcp"),
          ),
        )
        .get();
      if (remote !== undefined) {
        if (remote.accountLabel === null) return deniedConnectionRead("connection_not_found");
        const summary = connectionSummarySchema.parse({
          authorizationOutcome: "untracked",
          connectionId: remote.connectionId,
          createdAt: new Date(remote.createdAt).toISOString(),
          remoteMcp: { authKind: remote.authKind, name: remote.accountLabel },
          status: remote.status,
        });
        const timeline = this.#database
          .select({
            action: auditEvents.action,
            eventId: auditEvents.eventId,
            occurredAt: auditEvents.occurredAt,
          })
          .from(auditEvents)
          .where(eq(auditEvents.subjectId, remote.connectionId))
          .orderBy(asc(auditEvents.eventId))
          .limit(25)
          .all()
          .map((event) => ({
            ...event,
            occurredAt: new Date(event.occurredAt).toISOString(),
          }));

        return listConnectionsResultSchema.parse({
          connections: [summary],
          detail: { nextAction: nextRemoteConnectionAction(remote.status), timeline },
          nextCursor: null,
          ok: true,
        });
      }
      const inspected = this.inspect({ connectionId: request.data.connectionId });

      return inspected.ok
        ? listConnectionsResultSchema.parse({
            connections: [inspected.connection],
            detail: {
              nextAction: inspected.nextAction,
              timeline: inspected.timeline,
            },
            nextCursor: null,
            ok: true,
          })
        : deniedConnectionRead(inspected.error.code);
    }

    const listedConnections = alias(connections, "listed_connections");
    const latestAuthorizationOutcome = sql<ConnectionSummary["authorizationOutcome"]>`coalesce(
      (
        SELECT ${connectionAuthorizationReturns.status}
        FROM ${connectionAuthorizationReturns}
        WHERE ${connectionAuthorizationReturns.connectionId}
          = "listed_connections"."connection_id"
        ORDER BY ${connectionAuthorizationReturns.createdAt} DESC,
          ${connectionAuthorizationReturns.reservationId} DESC
        LIMIT 1
      ),
      'untracked'
    )`;
    const integrationSlug = sql<string | null>`(
      SELECT ${providerAuthConfigs.integrationSlug}
      FROM ${providerAuthConfigs}
      WHERE ${providerAuthConfigs.authConfigId} = "listed_connections"."auth_config_id"
      LIMIT 1
    )`;
    const rows = this.#database
      .select({
        accountLabel: listedConnections.accountLabel,
        authConfigId: listedConnections.authConfigId,
        authKind: remoteMcpConnections.authKind,
        authorizationOutcome: latestAuthorizationOutcome,
        connectionId: listedConnections.connectionId,
        createdAt: listedConnections.createdAt,
        integrationSlug,
        provider: listedConnections.provider,
        providerConnectionId: listedConnections.providerConnectionId,
        status: listedConnections.status,
      })
      .from(listedConnections)
      .leftJoin(
        remoteMcpConnections,
        eq(remoteMcpConnections.connectionId, listedConnections.connectionId),
      )
      .where(
        and(
          request.data.authorizationOutcome === undefined
            ? undefined
            : eq(latestAuthorizationOutcome, request.data.authorizationOutcome),
          request.data.cursor === undefined
            ? undefined
            : gt(listedConnections.connectionId, request.data.cursor),
          request.data.integration === undefined
            ? undefined
            : sql`EXISTS (
                SELECT 1
                FROM ${providerAuthConfigs}
                WHERE ${providerAuthConfigs.integrationSlug} = ${request.data.integration}
                  AND ${providerAuthConfigs.authConfigId}
                    = "listed_connections"."auth_config_id"
              )`,
          request.data.status === undefined
            ? undefined
            : eq(listedConnections.status, request.data.status),
        ),
      )
      .orderBy(asc(listedConnections.connectionId))
      .limit(request.data.limit + 1)
      .all();
    const summaries = rows.flatMap((row) => {
      if (row.provider === "remote_mcp") {
        return row.accountLabel === null || row.authKind === null
          ? []
          : [
              connectionSummarySchema.parse({
                authorizationOutcome: "untracked",
                connectionId: row.connectionId,
                createdAt: new Date(row.createdAt).toISOString(),
                remoteMcp: { authKind: row.authKind, name: row.accountLabel },
                status: row.status,
              }),
            ];
      }
      return row.authConfigId === null || row.providerConnectionId === null
        ? []
        : [
            this.#summaryFromRow({
              ...row,
              authConfigId: row.authConfigId,
              providerConnectionId: row.providerConnectionId,
            }),
          ];
    });
    const hasMore = summaries.length > request.data.limit;
    const page = summaries.slice(0, request.data.limit);
    const nextCursor = hasMore ? (page.at(-1)?.connectionId ?? null) : null;

    return listConnectionsResultSchema.parse({ connections: page, nextCursor, ok: true });
  }

  activateVerified(authority: OwnerAuthority, input: unknown): ListConnectionsResult {
    const request = activateVerifiedConnectionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionRead("invalid_request");
    }

    return this.#activateVerified(authority.clientId, request.data);
  }

  async activateVerifiedAuthorizationReturn(input: unknown): Promise<ListConnectionsResult> {
    const request = activateVerifiedAuthorizationReturnInputSchema.safeParse(input);

    if (!request.success) return deniedConnectionRead("invalid_request");
    const tokenDigest = await digestCanonicalRequest(request.data.authorizationToken);
    const callback = this.#database
      .select({ clientId: connectionLinkRequests.clientId })
      .from(connectionAuthorizationReturns)
      .innerJoin(
        connectionLinkRequests,
        eq(connectionLinkRequests.reservationId, connectionAuthorizationReturns.reservationId),
      )
      .where(
        and(
          eq(connectionAuthorizationReturns.reservationId, request.data.reservationId),
          eq(connectionAuthorizationReturns.tokenDigest, tokenDigest),
          eq(connectionAuthorizationReturns.connectionId, request.data.connectionId),
          eq(connectionAuthorizationReturns.status, "returned"),
          gt(connectionAuthorizationReturns.expiresAt, Date.now()),
        ),
      )
      .get();

    return callback === undefined
      ? deniedConnectionRead("invalid_request")
      : this.#activateVerified(callback.clientId, request.data);
  }

  #activateVerified(
    clientId: string,
    request: ActivateVerifiedConnectionInput,
  ): ListConnectionsResult {
    const activation = this.#database.transaction(
      (transaction): VerifiedConnectionActivationResult => {
        const row = transaction
          .select({
            authConfigId: connections.authConfigId,
            provider: connections.provider,
            providerConnectionId: connections.providerConnectionId,
            status: connections.status,
          })
          .from(connections)
          .where(eq(connections.connectionId, request.connectionId))
          .get();

        if (
          row === undefined ||
          row.provider !== "composio" ||
          row.authConfigId === null ||
          row.providerConnectionId === null
        ) {
          return { kind: "rejected", reason: "connection_not_found" };
        }

        if (row.providerConnectionId !== request.providerConnectionId) {
          return { kind: "rejected", reason: "provider_connection_mismatch" };
        }

        if (row.status === "revoked" || row.status === "unavailable") {
          return { kind: "rejected", reason: "connection_unavailable" };
        }

        const authorization = transaction
          .select({ status: connectionAuthorizationReturns.status })
          .from(connectionAuthorizationReturns)
          .where(eq(connectionAuthorizationReturns.connectionId, request.connectionId))
          .orderBy(
            desc(connectionAuthorizationReturns.completedAt),
            desc(connectionAuthorizationReturns.reservationId),
          )
          .get();
        const integration = transaction
          .select({ slug: providerAuthConfigs.integrationSlug })
          .from(providerAuthConfigs)
          .where(eq(providerAuthConfigs.authConfigId, row.authConfigId))
          .get();

        if (authorization?.status !== "returned") {
          return { kind: "rejected", reason: "authorization_not_returned" };
        }

        if (integration?.slug !== request.verifiedIntegrationSlug) {
          return { kind: "rejected", reason: "integration_mismatch" };
        }

        if (row.status === "active") {
          transaction
            .update(connections)
            .set({ accountLabel: request.accountLabel })
            .where(eq(connections.connectionId, request.connectionId))
            .run();
          return { kind: "activated" };
        }

        const updated = transaction
          .update(connections)
          .set({
            accountLabel: request.accountLabel,
            status: "active",
          })
          .where(
            and(
              eq(connections.connectionId, request.connectionId),
              eq(connections.providerConnectionId, request.providerConnectionId),
              eq(connections.status, "initiated"),
            ),
          )
          .returning({ connectionId: connections.connectionId })
          .all()[0];

        if (updated === undefined) {
          return { kind: "rejected", reason: "concurrent_change" };
        }

        transaction
          .insert(auditEvents)
          .values({
            action: "connection.activated",
            clientId,
            occurredAt: Date.now(),
            subjectId: request.connectionId,
          })
          .run();
        return { kind: "activated" };
      },
    );

    return activation.kind === "activated"
      ? this.list({ connectionId: request.connectionId })
      : deniedConnectionRead("invalid_request");
  }

  inspect(input: unknown): InspectConnectionResult {
    const request = inspectConnectionInputSchema.safeParse(input);

    if (!request.success) {
      return deniedConnectionInspect("invalid_request");
    }

    const row = this.#database
      .select()
      .from(connections)
      .where(eq(connections.connectionId, request.data.connectionId))
      .get();

    if (
      row === undefined ||
      row.provider !== "composio" ||
      row.authConfigId === null ||
      row.providerConnectionId === null
    ) {
      return deniedConnectionInspect("connection_not_found");
    }

    const authorization = this.#database
      .select({ status: connectionAuthorizationReturns.status })
      .from(connectionAuthorizationReturns)
      .where(eq(connectionAuthorizationReturns.connectionId, row.connectionId))
      .orderBy(
        desc(connectionAuthorizationReturns.createdAt),
        desc(connectionAuthorizationReturns.reservationId),
      )
      .limit(1)
      .get();
    const integration = this.#database
      .select({ integrationSlug: providerAuthConfigs.integrationSlug })
      .from(providerAuthConfigs)
      .where(eq(providerAuthConfigs.authConfigId, row.authConfigId))
      .get();
    const timeline = this.#database
      .select({
        action: auditEvents.action,
        eventId: auditEvents.eventId,
        occurredAt: auditEvents.occurredAt,
      })
      .from(auditEvents)
      .where(eq(auditEvents.subjectId, row.connectionId))
      .orderBy(asc(auditEvents.eventId))
      .limit(25)
      .all()
      .map((event) => ({
        ...event,
        occurredAt: new Date(event.occurredAt).toISOString(),
      }));
    const summary = this.#summaryFromRow({
      accountLabel: row.accountLabel,
      authConfigId: row.authConfigId,
      authorizationOutcome: authorization?.status ?? "untracked",
      connectionId: row.connectionId,
      createdAt: row.createdAt,
      integrationSlug: integration?.integrationSlug ?? null,
      providerConnectionId: row.providerConnectionId,
      status: row.status,
    });
    const nextAction = nextConnectionAction(summary);

    return inspectConnectionResultSchema.parse({
      connection: summary,
      nextAction,
      ok: true,
      timeline,
    });
  }

  usage(): { active: number; pending: number; total: number } {
    const rows = this.#database
      .select({
        status: connections.status,
        value: count(),
      })
      .from(connections)
      .groupBy(connections.status)
      .all();
    const active = rows.find((row) => row.status === "active")?.value ?? 0;
    const pending =
      this.#database
        .select({ value: count() })
        .from(connectionLinkRequests)
        .where(
          and(
            eq(connectionLinkRequests.status, "pending"),
            gt(connectionLinkRequests.recoverAfter, Date.now()),
          ),
        )
        .get()?.value ?? 0;

    return {
      active,
      pending,
      total: rows.reduce((total, row) => total + row.value, pending),
    };
  }

  cleanup(currentTime: number): number | null {
    return this.#database.transaction((transaction) => {
      this.#expireRequests(transaction, currentTime);
      this.#expireIntegrationEnablements(transaction, currentTime);

      const completedAt =
        transaction
          .select({ value: min(connectionLinkRequests.expiresAt) })
          .from(connectionLinkRequests)
          .where(eq(connectionLinkRequests.status, "completed"))
          .get()?.value ?? null;
      const pendingAt =
        transaction
          .select({ value: min(connectionLinkRequests.recoverAfter) })
          .from(connectionLinkRequests)
          .where(eq(connectionLinkRequests.status, "pending"))
          .get()?.value ?? null;
      const integrationEnablementAt =
        transaction
          .select({ value: min(integrationEnablementRequests.recoverAfter) })
          .from(integrationEnablementRequests)
          .where(eq(integrationEnablementRequests.status, "pending"))
          .get()?.value ?? null;
      const scheduled = [completedAt, pendingAt, integrationEnablementAt].filter(
        (value): value is number => value !== null,
      );

      return scheduled.length === 0 ? null : Math.min(...scheduled);
    });
  }

  #linkFromRow(row: StoredConnectionLinkRow) {
    if (row.connectionId === null || row.expiresAt === null || row.redirectUrl === null) {
      throw new Error("Invalid connection-link storage.");
    }

    return {
      connectionId: row.connectionId,
      expiresAt: new Date(row.expiresAt).toISOString(),
      url: row.redirectUrl,
    };
  }

  #summaryFromRow(row: StoredConnectionSummaryRow): ComposioConnectionSummary {
    return composioConnectionSummarySchema.parse({
      accountLabel: row.accountLabel,
      authorizationOutcome: row.authorizationOutcome,
      authConfigId: row.authConfigId,
      connectionId: row.connectionId,
      createdAt: new Date(row.createdAt).toISOString(),
      integrationSlug: row.integrationSlug,
      providerConnectionId: row.providerConnectionId,
      status: row.status,
    });
  }

  #expireRequests(database: DatabaseWriter, currentTime: number): void {
    database
      .update(connectionAuthorizationReturns)
      .set({ status: "expired" })
      .where(
        and(
          eq(connectionAuthorizationReturns.status, "pending"),
          lte(connectionAuthorizationReturns.expiresAt, currentTime),
        ),
      )
      .run();
    database
      .update(connectionLinkRequests)
      .set({ redirectUrl: null, status: "expired" })
      .where(
        and(
          eq(connectionLinkRequests.status, "completed"),
          lte(connectionLinkRequests.expiresAt, currentTime),
        ),
      )
      .run();
    database
      .update(connectionLinkRequests)
      .set({ status: "abandoned" })
      .where(
        and(
          eq(connectionLinkRequests.status, "pending"),
          lte(connectionLinkRequests.recoverAfter, currentTime),
        ),
      )
      .run();
  }

  #expireIntegrationEnablements(database: DatabaseWriter, currentTime: number): void {
    database
      .update(integrationEnablementRequests)
      .set({ status: "abandoned" })
      .where(
        and(
          eq(integrationEnablementRequests.status, "pending"),
          lte(integrationEnablementRequests.recoverAfter, currentTime),
        ),
      )
      .run();
  }

  async #scheduleCleanup(cleanupAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || cleanupAt < scheduledAlarm) {
      await this.#storage.setAlarm(cleanupAt);
    }
  }
}
