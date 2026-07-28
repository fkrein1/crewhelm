import {
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  INTEGRATION_ENABLEMENT_UNKNOWN_RECOVERY_MS,
  MAXIMUM_INTEGRATION_ENABLEMENT_REQUESTS_PER_OWNER,
  MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER,
  MAXIMUM_CONNECTIONS_PER_OWNER,
  completeConnectionLinkInputSchema,
  completeIntegrationEnablementInputSchema,
  connectionAuthorizationTokenSchema,
  connectionSummarySchema,
  createConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  enableIntegrationInputSchema,
  enableIntegrationResultSchema,
  listConnectionsInputSchema,
  listConnectionsResultSchema,
  recordConnectionAuthorizationReturnInputSchema,
  recordConnectionAuthorizationReturnResultSchema,
  reserveIntegrationEnablementResultSchema,
  reserveConnectionLinkResultSchema,
  type ConnectionSummary,
  type CreateConnectionLinkInput,
  type CreateConnectionLinkResult,
  type EnableIntegrationInput,
  type EnableIntegrationResult,
  type ListConnectionsResult,
  type OwnerAuthority,
  type RecordConnectionAuthorizationReturnResult,
  type ReserveIntegrationEnablementResult,
  type ReserveConnectionLinkResult,
} from "@crewhelm/contracts";
import { and, asc, count, desc, eq, gt, inArray, lte, min } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { recordConnectionLinkCompletion } from "../../observability/integrations.js";
import {
  auditEvents,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  integrationEnablementRequests,
  type ControlPlaneDatabaseSchema,
  type StoredConnectionAuthorizationOutcome,
} from "../schema.js";

const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type DatabaseWriter = Pick<Database, "update">;
type ConnectionLinkFailure = Extract<CreateConnectionLinkResult, { ok: false }>;
type ConnectionReadFailure = Extract<ListConnectionsResult, { ok: false }>;
type ConnectionAuthorizationReturnFailure = Extract<
  RecordConnectionAuthorizationReturnResult,
  { ok: false }
>;
type IntegrationEnablementFailure = Extract<EnableIntegrationResult, { ok: false }>;
type StoredConnectionLinkRow = {
  connectionId: string | null;
  expiresAt: number | null;
  redirectUrl: string | null;
};
type StoredConnectionSummaryRow = {
  authConfigId: string;
  authorizationOutcome: ConnectionSummary["authorizationOutcome"];
  connectionId: string;
  createdAt: number;
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
  return digestCanonicalRequest(JSON.stringify({ integrationSlug: input.integrationSlug }));
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

export function deniedConnectionLink(
  code: ConnectionLinkFailure["error"]["code"],
): ConnectionLinkFailure {
  return {
    error: { code, message: "Connection link request denied." },
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

export function deniedConnectionAuthorizationReturn(): ConnectionAuthorizationReturnFailure {
  return {
    error: { code: "invalid_return", message: "Connection authorization return denied." },
    ok: false,
  };
}

export function deniedIntegrationEnablement(
  code: IntegrationEnablementFailure["error"]["code"],
): IntegrationEnablementFailure {
  return {
    error: { code, message: "Integration enablement request denied." },
    ok: false,
  };
}

export class Connections {
  readonly #database: Database;
  readonly #storage: DurableObjectStorage;

  constructor(database: Database, storage: DurableObjectStorage) {
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
          requestDigest: integrationEnablementRequests.requestDigest,
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

        if (
          existing.status !== "completed" ||
          existing.authConfigId === null ||
          existing.authScheme === null
        ) {
          return deniedIntegrationEnablement("integration_enablement_outcome_unknown");
        }

        return reserveIntegrationEnablementResultSchema.parse({
          authConfigId: existing.authConfigId,
          authScheme: existing.authScheme,
          integrationSlug: existing.integrationSlug,
          managed: true,
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

    return this.#database.transaction((transaction) => {
      const currentTime = Date.now();

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

      if (row.status === "completed") {
        if (
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
          managed: true,
          ok: true,
        });
      }

      if (row.status !== "pending" || currentTime >= row.recoverAfter) {
        return deniedIntegrationEnablement("integration_enablement_outcome_unknown");
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
        managed: true,
        ok: true,
      });
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

      const existingRequest = transaction
        .select({
          connectionId: connectionLinkRequests.connectionId,
          expiresAt: connectionLinkRequests.expiresAt,
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

        if (existingRequest.status !== "completed") {
          return deniedConnectionLink("connection_link_outcome_unknown");
        }

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

      if (connectionCount + pendingCount >= MAXIMUM_CONNECTIONS_PER_OWNER) {
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
        return deniedConnectionLink("connection_link_outcome_unknown");
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
          return deniedConnectionLink("connection_link_outcome_unknown");
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

      const desiredOutcome = request.data.status === "success" ? "returned" : "failed";
      const currentOutcome = row.authorizationStatus;
      const storedProviderConnectionId = row.providerConnectionId;

      if (currentOutcome === "returned" || currentOutcome === "failed") {
        if (
          currentOutcome !== desiredOutcome ||
          typeof storedProviderConnectionId !== "string" ||
          (request.data.providerConnectionId !== undefined &&
            request.data.providerConnectionId !== storedProviderConnectionId) ||
          (desiredOutcome === "returned" &&
            request.data.providerConnectionId !== storedProviderConnectionId)
        ) {
          return deniedConnectionAuthorizationReturn();
        }

        return recordConnectionAuthorizationReturnResultSchema.parse({
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

    const rows = this.#database
      .select({
        authConfigId: connections.authConfigId,
        connectionId: connections.connectionId,
        createdAt: connections.createdAt,
        status: connections.status,
      })
      .from(connections)
      .where(
        request.data.cursor === undefined
          ? undefined
          : gt(connections.connectionId, request.data.cursor),
      )
      .orderBy(asc(connections.connectionId))
      .limit(request.data.limit + 1)
      .all();
    const connectionIds = rows.map((row) => row.connectionId);
    const authorizationRows =
      connectionIds.length === 0
        ? []
        : this.#database
            .select({
              connectionId: connectionAuthorizationReturns.connectionId,
              reservationId: connectionAuthorizationReturns.reservationId,
              status: connectionAuthorizationReturns.status,
            })
            .from(connectionAuthorizationReturns)
            .where(inArray(connectionAuthorizationReturns.connectionId, connectionIds))
            .orderBy(
              desc(connectionAuthorizationReturns.createdAt),
              desc(connectionAuthorizationReturns.reservationId),
            )
            .all();
    const authorizationByConnection = new Map<string, StoredConnectionAuthorizationOutcome>();

    for (const authorizationRow of authorizationRows) {
      if (
        authorizationRow.connectionId !== null &&
        !authorizationByConnection.has(authorizationRow.connectionId)
      ) {
        authorizationByConnection.set(authorizationRow.connectionId, authorizationRow.status);
      }
    }

    const summaries = rows.map((row) =>
      this.#summaryFromRow({
        ...row,
        authorizationOutcome:
          authorizationByConnection.get(row.connectionId) ?? ("untracked" as const),
      }),
    );
    const hasMore = summaries.length > request.data.limit;
    const page = summaries.slice(0, request.data.limit);
    const nextCursor = hasMore ? (page.at(-1)?.connectionId ?? null) : null;

    return listConnectionsResultSchema.parse({ connections: page, nextCursor, ok: true });
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

  #summaryFromRow(row: StoredConnectionSummaryRow): ConnectionSummary {
    return connectionSummarySchema.parse({
      authorizationOutcome: row.authorizationOutcome,
      authConfigId: row.authConfigId,
      connectionId: row.connectionId,
      createdAt: new Date(row.createdAt).toISOString(),
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
