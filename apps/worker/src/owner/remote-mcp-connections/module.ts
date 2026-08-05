import {
  beginRemoteMcpOAuthInputSchema,
  beginRemoteMcpOAuthResultSchema,
  completeRemoteMcpOAuthInputSchema,
  completeRemoteMcpOAuthResultSchema,
  createRemoteMcpConnectionInputSchema,
  createRemoteMcpConnectionResultSchema,
  deleteRemoteMcpConnectionInputSchema,
  deleteRemoteMcpConnectionResultSchema,
  failRemoteMcpOAuthInputSchema,
  failRemoteMcpOAuthResultSchema,
  inspectRemoteMcpConnectionInputSchema,
  inspectRemoteMcpConnectionResultSchema,
  lookupRemoteMcpConnectionCreationInputSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
  remoteMcpCatalogSchema,
  remoteMcpConnectionOperationInputSchema,
  remoteMcpConnectionOperationResultSchema,
  remoteMcpConnectionSchema,
  remoteMcpApiKeyCredentialSchema,
  reauthenticateRemoteMcpConnectionInputSchema,
  reauthenticateRemoteMcpConnectionResultSchema,
  type BeginRemoteMcpOAuthResult,
  type CompleteRemoteMcpOAuthResult,
  type CreateRemoteMcpConnectionResult,
  type DeleteRemoteMcpConnectionResult,
  type FleetConfigurationData,
  type FailRemoteMcpOAuthResult,
  type InspectRemoteMcpConnectionResult,
  type LookupRemoteMcpConnectionCreationResult,
  type OwnerAuthority,
  type RemoteMcpAuthKind,
  type RemoteMcpCatalog,
  type RemoteMcpConnectionOperationResult,
  type ReauthenticateRemoteMcpConnectionResult,
} from "@crewhelm/contracts";
import { and, count, eq, gt, inArray, lt } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import {
  callRemoteMcpTool,
  discoverRemoteMcpTools,
  normalizeRemoteMcpEndpoint,
} from "../../remote-mcp/client.js";
import {
  beginRemoteMcpOAuthAuthorization,
  completeRemoteMcpOAuthAuthorization,
  refreshRemoteMcpOAuthCredential,
  remoteMcpOAuthAccessToken,
  remoteMcpOAuthAuthorizationSchema,
  remoteMcpOAuthCredentialSchema,
  revokeRemoteMcpOAuthCredential,
  type RemoteMcpOAuthCredential,
} from "../../remote-mcp/oauth.js";
import {
  createRemoteMcpApiKeySetup,
  createRemoteMcpBearerSetup,
  createRemoteMcpOAuthSetup,
  createRemoteMcpOAuthState,
  REMOTE_MCP_OAUTH_CALLBACK_PATH,
  REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH,
} from "../../remote-mcp/handoff.js";
import { createRemoteMcpInputSchema } from "../../remote-mcp/schema.js";

import {
  auditEvents,
  capabilityGrants,
  connections,
  remoteMcpConnectionMutations,
  remoteMcpConnections,
  remoteMcpOAuthRequests,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type QueryableDatabase = Database | Transaction;
type RequestFailure = Extract<CreateRemoteMcpConnectionResult, { ok: false }>;
type StoredConnection = {
  accountLabel: string | null;
  apiKeyHeaderName: string | null;
  authKind: RemoteMcpAuthKind;
  catalog: RemoteMcpCatalog;
  catalogBytes: number;
  connectionId: string;
  createdAt: number;
  credentialCiphertext: string | null;
  credentialNonce: string | null;
  endpoint: string;
  oauthScopes: string[];
  serverName: string;
  serverVersion: string;
  snapshotDigest: string;
  status: "active" | "initiated" | "revoked" | "unavailable";
};

const encoder = new TextEncoder();
const MAXIMUM_OAUTH_REQUESTS_PER_OWNER = 32;
const OAUTH_REQUEST_TTL_MS = 10 * 60 * 1_000;
const OAUTH_NETWORK_TIMEOUT_MS = 15_000;

function denied(code: RequestFailure["error"]["code"]): RequestFailure {
  return {
    error: { code, message: "Remote MCP Connection request denied." },
    ok: false,
  };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      info: encoder.encode("crewhelm:remote-mcp-credential:v1"),
      name: "HKDF",
      salt: encoder.encode("crewhelm:owner-control-plane"),
    },
    material,
    { length: 256, name: "AES-GCM" },
    false,
    ["decrypt", "encrypt"],
  );
}

async function encryptCredential(
  secret: string,
  connectionId: string,
  plaintext: string,
): Promise<{ ciphertext: string; nonce: string }> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: encoder.encode(connectionId), iv: nonce, name: "AES-GCM" },
    await encryptionKey(secret),
    encoder.encode(plaintext),
  );
  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    nonce: encodeBase64Url(nonce),
  };
}

async function decryptCredential(
  secret: string,
  connectionId: string,
  ciphertext: string,
  nonce: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: encoder.encode(connectionId),
      iv: decodeBase64Url(nonce),
      name: "AES-GCM",
    },
    await encryptionKey(secret),
    decodeBase64Url(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requestDigest(secret: string, input: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(input)))),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function storedConnection(
  database: QueryableDatabase,
  connectionId: string,
): StoredConnection | undefined {
  return database
    .select({
      accountLabel: connections.accountLabel,
      apiKeyHeaderName: remoteMcpConnections.apiKeyHeaderName,
      authKind: remoteMcpConnections.authKind,
      catalog: remoteMcpConnections.catalog,
      catalogBytes: remoteMcpConnections.catalogBytes,
      connectionId: connections.connectionId,
      createdAt: connections.createdAt,
      credentialCiphertext: remoteMcpConnections.credentialCiphertext,
      credentialNonce: remoteMcpConnections.credentialNonce,
      endpoint: remoteMcpConnections.endpoint,
      oauthScopes: remoteMcpConnections.oauthScopes,
      serverName: remoteMcpConnections.serverName,
      serverVersion: remoteMcpConnections.serverVersion,
      snapshotDigest: remoteMcpConnections.snapshotDigest,
      status: connections.status,
    })
    .from(connections)
    .innerJoin(
      remoteMcpConnections,
      eq(remoteMcpConnections.connectionId, connections.connectionId),
    )
    .where(and(eq(connections.connectionId, connectionId), eq(connections.provider, "remote_mcp")))
    .get();
}

function present(row: StoredConnection) {
  if (row.accountLabel === null) {
    throw new Error("Remote MCP Connection is missing its account label.");
  }

  return remoteMcpConnectionSchema.parse({
    apiKeyHeaderName: row.apiKeyHeaderName ?? undefined,
    authKind: row.authKind,
    catalog: row.catalog,
    catalogBytes: row.catalogBytes,
    connectionId: row.connectionId,
    createdAt: new Date(row.createdAt).toISOString(),
    endpoint: row.endpoint,
    name: row.accountLabel,
    oauthScopes: row.oauthScopes,
    server: { name: row.serverName, version: row.serverVersion },
    snapshotDigest: row.snapshotDigest,
    status: row.status,
  });
}

export class RemoteMcpConnections {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: Database;
  readonly #encryptionSecret: string;
  readonly #publicOrigin: string;

  constructor(
    database: Database,
    currentFleetConfiguration: () => FleetConfigurationData,
    encryptionSecret: string,
    publicOrigin: string,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#encryptionSecret = encryptionSecret;
    this.#publicOrigin = publicOrigin;
  }

  async reserveAuthentication(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<RemoteMcpConnectionOperationResult> {
    const request = remoteMcpConnectionOperationInputSchema.safeParse(input);
    if (
      !request.success ||
      !(
        (request.data.action === "connect" && request.data.authKind === "oauth") ||
        request.data.action === "reauthenticate"
      )
    ) {
      return denied("invalid_request");
    }

    if (request.data.action === "reauthenticate") {
      const target = storedConnection(this.#database, request.data.connectionId);
      if (
        target === undefined ||
        !["active", "unavailable"].includes(target.status) ||
        target.accountLabel === null
      ) {
        return denied("connection_not_found");
      }
      if (target.snapshotDigest !== request.data.snapshotDigest) {
        return denied("revision_conflict");
      }
      if (target.authKind === "api_key" || target.authKind === "bearer") {
        const claims = {
          connectionId: target.connectionId,
          endpoint: target.endpoint,
          expiresAt: Date.now() + OAUTH_REQUEST_TTL_MS,
          idempotencyKey: request.data.idempotencyKey,
          name: target.accountLabel,
          operation: "reauthenticate" as const,
          ownerKey: authority.ownerKey,
          snapshotDigest: target.snapshotDigest,
        };
        const setup = await (target.authKind === "api_key"
          ? createRemoteMcpApiKeySetup({
              claims: {
                ...claims,
                apiKeyHeaderName: remoteMcpApiKeyCredentialSchema.shape.headerName.parse(
                  target.apiKeyHeaderName,
                ),
              },
              origin: this.#publicOrigin,
              signingSecret: this.#encryptionSecret,
            })
          : createRemoteMcpBearerSetup({
              claims,
              origin: this.#publicOrigin,
              signingSecret: this.#encryptionSecret,
            }));
        return remoteMcpConnectionOperationResultSchema.parse({
          ok: true,
          setup,
          state: "setup_required",
        });
      }
      if (target.authKind !== "oauth") return denied("invalid_request");
    }

    const currentTime = Date.now();
    this.#database
      .delete(remoteMcpOAuthRequests)
      .where(lt(remoteMcpOAuthRequests.expiresAt, currentTime))
      .run();

    let connection: StoredConnection | undefined;
    let operation: "create" | "reauthenticate";
    let endpoint: string;
    let name: string;
    let oauthScopes: string[];
    let connectionId: string | null;
    let snapshotDigest: string | null;

    if (request.data.action === "connect") {
      operation = "create";
      endpoint = normalizeRemoteMcpEndpoint(request.data.endpoint);
      name = request.data.name;
      oauthScopes = request.data.oauthScopes;
      connectionId = null;
      snapshotDigest = null;

      const replay = this.lookupCreation(authority, {
        authKind: "oauth",
        endpoint,
        idempotencyKey: request.data.idempotencyKey,
        name,
        oauthScopes,
      });
      if (!replay.ok) return replay;
      if (replay.connection !== null) {
        return remoteMcpConnectionOperationResultSchema.parse({
          connection: replay.connection,
          created: false,
          ok: true,
          state: "connected",
        });
      }
    } else {
      operation = "reauthenticate";
      connection = storedConnection(this.#database, request.data.connectionId);
      if (
        connection === undefined ||
        connection.authKind !== "oauth" ||
        !["active", "unavailable"].includes(connection.status)
      ) {
        return denied("connection_not_found");
      }
      if (connection.snapshotDigest !== request.data.snapshotDigest) {
        return denied("revision_conflict");
      }
      if (connection.accountLabel === null) return denied("invalid_request");
      endpoint = connection.endpoint;
      name = connection.accountLabel;
      oauthScopes = connection.oauthScopes;
      connectionId = connection.connectionId;
      snapshotDigest = connection.snapshotDigest;
    }

    const idempotencyKey = request.data.idempotencyKey;
    const digest = await requestDigest(this.#encryptionSecret, {
      connectionId,
      endpoint,
      name,
      oauthScopes,
      operation,
      snapshotDigest,
    });
    const existing = this.#database
      .select()
      .from(remoteMcpOAuthRequests)
      .where(
        and(
          eq(remoteMcpOAuthRequests.clientId, authority.clientId),
          eq(remoteMcpOAuthRequests.idempotencyKey, idempotencyKey),
        ),
      )
      .get();
    if (existing !== undefined) {
      if (existing.requestDigest !== digest || existing.operation !== operation) {
        return denied("idempotency_conflict");
      }
      if (existing.status === "completed" && existing.connectionId !== null) {
        const completed = storedConnection(this.#database, existing.connectionId);
        return completed === undefined
          ? denied("connection_not_found")
          : remoteMcpConnectionOperationResultSchema.parse({
              connection: present(completed),
              created: false,
              ok: true,
              state: "connected",
            });
      }
      if (!["reserved", "pending"].includes(existing.status)) {
        return denied("remote_mcp_unavailable");
      }
      const setup = await createRemoteMcpOAuthSetup({
        claims: {
          expiresAt: existing.expiresAt,
          ownerKey: authority.ownerKey,
          requestId: existing.requestId,
        },
        origin: this.#publicOrigin,
        signingSecret: this.#encryptionSecret,
      });
      return remoteMcpConnectionOperationResultSchema.parse({
        ok: true,
        setup,
        state: "setup_required",
      });
    }

    const requestCount =
      this.#database.select({ value: count() }).from(remoteMcpOAuthRequests).get()?.value ?? 0;
    if (requestCount >= MAXIMUM_OAUTH_REQUESTS_PER_OWNER) {
      return denied("connection_limit_exceeded");
    }
    if (operation === "create") {
      const connectionCount =
        this.#database.select({ value: count() }).from(connections).get()?.value ?? 0;
      const pendingCount =
        this.#database
          .select({ value: count() })
          .from(remoteMcpOAuthRequests)
          .where(
            and(
              eq(remoteMcpOAuthRequests.operation, "create"),
              gt(remoteMcpOAuthRequests.expiresAt, currentTime),
              inArray(remoteMcpOAuthRequests.status, [
                "reserved",
                "starting",
                "pending",
                "exchanging",
              ]),
            ),
          )
          .get()?.value ?? 0;
      if (
        connectionCount + pendingCount >=
        this.#currentFleetConfiguration().capacity.maxConnections
      ) {
        return denied("connection_limit_exceeded");
      }
    }

    const requestId = `remote_mcp_oauth_${crypto.randomUUID()}`;
    const expiresAt = currentTime + OAUTH_REQUEST_TTL_MS;
    const claims = { expiresAt, ownerKey: authority.ownerKey, requestId };
    const [setup, state] = await Promise.all([
      createRemoteMcpOAuthSetup({
        claims,
        origin: this.#publicOrigin,
        signingSecret: this.#encryptionSecret,
      }),
      createRemoteMcpOAuthState({ claims, signingSecret: this.#encryptionSecret }),
    ]);
    const stateDigest = await sha256(state);

    this.#database.transaction((transaction) => {
      transaction
        .insert(remoteMcpOAuthRequests)
        .values({
          accountLabel: name,
          clientId: authority.clientId,
          connectionId,
          createdAt: currentTime,
          endpoint,
          expiresAt,
          idempotencyKey,
          oauthScopes,
          operation,
          requestDigest: digest,
          requestId,
          snapshotDigest,
          stateDigest,
          status: "reserved",
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: `connection.remote_mcp_oauth_${operation}_reserved`,
          clientId: authority.clientId,
          occurredAt: currentTime,
          subjectId: requestId,
        })
        .run();
    });
    return remoteMcpConnectionOperationResultSchema.parse({
      ok: true,
      setup,
      state: "setup_required",
    });
  }

  async beginOAuth(authority: OwnerAuthority, input: unknown): Promise<BeginRemoteMcpOAuthResult> {
    const request = beginRemoteMcpOAuthInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const row = this.#database
      .select()
      .from(remoteMcpOAuthRequests)
      .where(eq(remoteMcpOAuthRequests.requestId, request.data.requestId))
      .get();
    const currentTime = Date.now();
    if (row === undefined || row.expiresAt <= currentTime) {
      return denied("remote_mcp_unavailable");
    }
    if (row.status === "pending" && row.authorizationUrl !== null) {
      return beginRemoteMcpOAuthResultSchema.parse({
        authorizationUrl: row.authorizationUrl,
        ok: true,
      });
    }
    if (row.status !== "reserved") return denied("remote_mcp_unavailable");

    const claimed = this.#database
      .update(remoteMcpOAuthRequests)
      .set({ status: "starting" })
      .where(
        and(
          eq(remoteMcpOAuthRequests.requestId, row.requestId),
          eq(remoteMcpOAuthRequests.status, "reserved"),
        ),
      )
      .returning({ requestId: remoteMcpOAuthRequests.requestId })
      .all();
    if (claimed.length !== 1) return denied("remote_mcp_unavailable");

    try {
      const claims = {
        expiresAt: row.expiresAt,
        ownerKey: authority.ownerKey,
        requestId: row.requestId,
      };
      const state = await createRemoteMcpOAuthState({
        claims,
        signingSecret: this.#encryptionSecret,
      });
      if ((await sha256(state)) !== row.stateDigest) {
        throw new Error("Remote MCP OAuth state binding failed.");
      }

      let priorCredential: RemoteMcpOAuthCredential | undefined;
      if (row.operation === "reauthenticate") {
        if (row.connectionId === null) throw new Error("OAuth Connection is missing.");
        const existing = storedConnection(this.#database, row.connectionId);
        if (
          existing === undefined ||
          existing.authKind !== "oauth" ||
          existing.snapshotDigest !== row.snapshotDigest ||
          existing.credentialCiphertext === null ||
          existing.credentialNonce === null
        ) {
          throw new Error("OAuth Connection is unavailable.");
        }
        priorCredential = remoteMcpOAuthCredentialSchema.parse(
          JSON.parse(
            await decryptCredential(
              this.#encryptionSecret,
              existing.connectionId,
              existing.credentialCiphertext,
              existing.credentialNonce,
            ),
          ),
        );
      }

      const started = await beginRemoteMcpOAuthAuthorization({
        ...(priorCredential === undefined
          ? {}
          : { clientInformation: priorCredential.clientInformation }),
        clientMetadataUrl: `${this.#publicOrigin}${REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH}`,
        endpoint: row.endpoint,
        redirectUrl: `${this.#publicOrigin}${REMOTE_MCP_OAUTH_CALLBACK_PATH}`,
        requestedScopes: row.oauthScopes,
        signal: AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
        state,
      });
      if (
        priorCredential !== undefined &&
        started.authorization.authorizationServerUrl !== priorCredential.authorizationServerUrl
      ) {
        throw new Error("OAuth authorization-server identity changed.");
      }
      const encrypted = await encryptCredential(
        this.#encryptionSecret,
        row.requestId,
        JSON.stringify(started.authorization),
      );
      const updated = this.#database
        .update(remoteMcpOAuthRequests)
        .set({
          authorizationUrl: started.authorizationUrl,
          credentialCiphertext: encrypted.ciphertext,
          credentialNonce: encrypted.nonce,
          status: "pending",
        })
        .where(
          and(
            eq(remoteMcpOAuthRequests.requestId, row.requestId),
            eq(remoteMcpOAuthRequests.status, "starting"),
          ),
        )
        .returning({ requestId: remoteMcpOAuthRequests.requestId })
        .all();
      if (updated.length !== 1) throw new Error("OAuth request changed during setup.");
      return beginRemoteMcpOAuthResultSchema.parse({
        authorizationUrl: started.authorizationUrl,
        ok: true,
      });
    } catch {
      this.#failOAuthRequest(row.requestId, currentTime);
      return denied("remote_mcp_unavailable");
    }
  }

  async completeOAuth(
    _authority: OwnerAuthority,
    input: unknown,
  ): Promise<CompleteRemoteMcpOAuthResult> {
    const request = completeRemoteMcpOAuthInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const row = this.#database
      .select()
      .from(remoteMcpOAuthRequests)
      .where(eq(remoteMcpOAuthRequests.requestId, request.data.requestId))
      .get();
    const currentTime = Date.now();
    if (row === undefined || row.expiresAt <= currentTime) {
      return denied("remote_mcp_unavailable");
    }
    if (row.status === "completed" && row.connectionId !== null) {
      const replay = storedConnection(this.#database, row.connectionId);
      return replay === undefined
        ? denied("connection_not_found")
        : completeRemoteMcpOAuthResultSchema.parse({
            connection: present(replay),
            ok: true,
            operation: row.operation === "create" ? "created" : "reauthenticated",
          });
    }
    if (
      row.status !== "pending" ||
      row.credentialCiphertext === null ||
      row.credentialNonce === null
    ) {
      return denied("remote_mcp_unavailable");
    }

    const claimed = this.#database
      .update(remoteMcpOAuthRequests)
      .set({ status: "exchanging" })
      .where(
        and(
          eq(remoteMcpOAuthRequests.requestId, row.requestId),
          eq(remoteMcpOAuthRequests.status, "pending"),
        ),
      )
      .returning({ requestId: remoteMcpOAuthRequests.requestId })
      .all();
    if (claimed.length !== 1) return denied("remote_mcp_unavailable");

    try {
      const authorization = remoteMcpOAuthAuthorizationSchema.parse(
        JSON.parse(
          await decryptCredential(
            this.#encryptionSecret,
            row.requestId,
            row.credentialCiphertext,
            row.credentialNonce,
          ),
        ),
      );
      if (
        request.data.authorizationServerIssuer !== undefined &&
        request.data.authorizationServerIssuer !== authorization.authorizationServerMetadata.issuer
      ) {
        throw new Error("OAuth authorization-server issuer does not match.");
      }
      const credential = await completeRemoteMcpOAuthAuthorization({
        authorization,
        authorizationCode: request.data.authorizationCode,
        redirectUrl: `${this.#publicOrigin}${REMOTE_MCP_OAUTH_CALLBACK_PATH}`,
        signal: AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
      });
      const discovered = await discoverRemoteMcpTools({
        bearerToken: credential.tokens.accessToken,
        endpoint: row.endpoint,
        signal: AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
      });

      if (row.operation === "create") {
        const connectionId = `connection_${crypto.randomUUID()}`;
        const encrypted = await encryptCredential(
          this.#encryptionSecret,
          connectionId,
          JSON.stringify(credential),
        );
        const completedAt = Date.now();
        this.#database.transaction((transaction) => {
          const currentRequest = transaction
            .select({
              expiresAt: remoteMcpOAuthRequests.expiresAt,
              status: remoteMcpOAuthRequests.status,
            })
            .from(remoteMcpOAuthRequests)
            .where(eq(remoteMcpOAuthRequests.requestId, row.requestId))
            .get();
          const existingMutation = transaction
            .select({ connectionId: remoteMcpConnectionMutations.connectionId })
            .from(remoteMcpConnectionMutations)
            .where(
              and(
                eq(remoteMcpConnectionMutations.clientId, row.clientId),
                eq(remoteMcpConnectionMutations.idempotencyKey, row.idempotencyKey),
              ),
            )
            .get();
          const usage = transaction.select({ value: count() }).from(connections).get()?.value ?? 0;
          if (
            currentRequest === undefined ||
            currentRequest.status !== "exchanging" ||
            currentRequest.expiresAt <= completedAt ||
            existingMutation !== undefined ||
            usage >= this.#currentFleetConfiguration().capacity.maxConnections
          ) {
            throw new Error("OAuth Connection completion is no longer valid.");
          }
          transaction
            .insert(connections)
            .values({
              accountLabel: row.accountLabel,
              authConfigId: null,
              connectionId,
              createdAt: completedAt,
              provider: "remote_mcp",
              providerConnectionId: null,
              status: "active",
            })
            .run();
          transaction
            .insert(remoteMcpConnections)
            .values({
              authKind: "oauth",
              catalog: discovered.tools,
              catalogBytes: discovered.catalogBytes,
              connectionId,
              credentialCiphertext: encrypted.ciphertext,
              credentialNonce: encrypted.nonce,
              endpoint: row.endpoint,
              oauthScopes: credential.grantedScopes,
              serverName: discovered.server.name,
              serverVersion: discovered.server.version,
              snapshotDigest: discovered.digest,
            })
            .run();
          transaction
            .insert(remoteMcpConnectionMutations)
            .values({
              clientId: row.clientId,
              connectionId,
              idempotencyKey: row.idempotencyKey,
              occurredAt: completedAt,
              operation: "create",
              requestDigest: row.requestDigest,
            })
            .run();
          const completed = transaction
            .update(remoteMcpOAuthRequests)
            .set({
              authorizationUrl: null,
              completedAt,
              connectionId,
              credentialCiphertext: null,
              credentialNonce: null,
              oauthScopes: credential.grantedScopes,
              status: "completed",
            })
            .where(
              and(
                eq(remoteMcpOAuthRequests.requestId, row.requestId),
                eq(remoteMcpOAuthRequests.status, "exchanging"),
                gt(remoteMcpOAuthRequests.expiresAt, completedAt),
              ),
            )
            .returning({ requestId: remoteMcpOAuthRequests.requestId })
            .all();
          if (completed.length !== 1) {
            throw new Error("OAuth Connection request changed during completion.");
          }
          transaction
            .insert(auditEvents)
            .values({
              action: "connection.remote_mcp_oauth_created",
              clientId: row.clientId,
              occurredAt: completedAt,
              subjectId: connectionId,
            })
            .run();
        });
        const created = storedConnection(this.#database, connectionId);
        if (created === undefined) throw new Error("OAuth Connection creation failed.");
        return completeRemoteMcpOAuthResultSchema.parse({
          connection: present(created),
          ok: true,
          operation: "created",
        });
      }

      if (row.connectionId === null || row.snapshotDigest === null) {
        throw new Error("OAuth reauthentication target is missing.");
      }
      const existing = storedConnection(this.#database, row.connectionId);
      if (
        existing === undefined ||
        existing.authKind !== "oauth" ||
        existing.snapshotDigest !== row.snapshotDigest ||
        existing.credentialCiphertext === null ||
        existing.credentialNonce === null ||
        discovered.digest !== existing.snapshotDigest ||
        discovered.server.name !== existing.serverName ||
        discovered.server.version !== existing.serverVersion
      ) {
        throw new Error("OAuth Connection snapshot changed.");
      }
      const priorCredential = remoteMcpOAuthCredentialSchema.parse(
        JSON.parse(
          await decryptCredential(
            this.#encryptionSecret,
            existing.connectionId,
            existing.credentialCiphertext,
            existing.credentialNonce,
          ),
        ),
      );
      if (
        credential.authorizationServerUrl !== priorCredential.authorizationServerUrl ||
        credential.grantedScopes.some((scope) => !priorCredential.grantedScopes.includes(scope))
      ) {
        throw new Error("OAuth reauthentication widened authority.");
      }
      const encrypted = await encryptCredential(
        this.#encryptionSecret,
        existing.connectionId,
        JSON.stringify(credential),
      );
      const completedAt = Date.now();
      this.#database.transaction((transaction) => {
        const completed = transaction
          .update(remoteMcpOAuthRequests)
          .set({
            authorizationUrl: null,
            completedAt,
            credentialCiphertext: null,
            credentialNonce: null,
            oauthScopes: credential.grantedScopes,
            status: "completed",
          })
          .where(
            and(
              eq(remoteMcpOAuthRequests.requestId, row.requestId),
              eq(remoteMcpOAuthRequests.status, "exchanging"),
              gt(remoteMcpOAuthRequests.expiresAt, completedAt),
            ),
          )
          .returning({ requestId: remoteMcpOAuthRequests.requestId })
          .all();
        const current = storedConnection(transaction, existing.connectionId);
        if (
          completed.length !== 1 ||
          current === undefined ||
          current.authKind !== "oauth" ||
          !["active", "unavailable"].includes(current.status) ||
          current.snapshotDigest !== existing.snapshotDigest ||
          current.serverName !== existing.serverName ||
          current.serverVersion !== existing.serverVersion ||
          current.credentialCiphertext !== existing.credentialCiphertext ||
          current.credentialNonce !== existing.credentialNonce
        ) {
          throw new Error("OAuth reauthentication completion is no longer valid.");
        }
        const credentialUpdated = transaction
          .update(remoteMcpConnections)
          .set({
            credentialCiphertext: encrypted.ciphertext,
            credentialNonce: encrypted.nonce,
            oauthScopes: credential.grantedScopes,
          })
          .where(eq(remoteMcpConnections.connectionId, existing.connectionId))
          .returning({ connectionId: remoteMcpConnections.connectionId })
          .all();
        const connectionUpdated = transaction
          .update(connections)
          .set({ status: "active" })
          .where(
            and(
              eq(connections.connectionId, existing.connectionId),
              eq(connections.provider, "remote_mcp"),
              inArray(connections.status, ["active", "unavailable"]),
            ),
          )
          .returning({ connectionId: connections.connectionId })
          .all();
        if (credentialUpdated.length !== 1 || connectionUpdated.length !== 1) {
          throw new Error("OAuth reauthentication target changed during completion.");
        }
        transaction
          .insert(auditEvents)
          .values({
            action: "connection.remote_mcp_oauth_reauthenticated",
            clientId: row.clientId,
            occurredAt: completedAt,
            subjectId: existing.connectionId,
          })
          .run();
      });
      const reauthenticated = storedConnection(this.#database, existing.connectionId);
      if (reauthenticated === undefined) throw new Error("OAuth reauthentication failed.");
      return completeRemoteMcpOAuthResultSchema.parse({
        connection: present(reauthenticated),
        ok: true,
        operation: "reauthenticated",
      });
    } catch {
      this.#failOAuthRequest(row.requestId, currentTime);
      return denied("remote_mcp_unavailable");
    }
  }

  failOAuth(input: unknown): FailRemoteMcpOAuthResult {
    const request = failRemoteMcpOAuthInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const failed = this.#failOAuthRequest(request.data.requestId, Date.now());
    return failRemoteMcpOAuthResultSchema.parse({ failed, ok: true });
  }

  async prepareExecution(input: {
    connectionId: string;
    snapshotDigest: string;
  }): Promise<boolean> {
    const row = storedConnection(this.#database, input.connectionId);
    if (
      row === undefined ||
      row.status !== "active" ||
      row.snapshotDigest !== input.snapshotDigest
    ) {
      return false;
    }
    if (row.authKind !== "oauth") return true;
    if (row.credentialCiphertext === null || row.credentialNonce === null) return false;

    let credential: RemoteMcpOAuthCredential;
    try {
      credential = remoteMcpOAuthCredentialSchema.parse(
        JSON.parse(
          await decryptCredential(
            this.#encryptionSecret,
            row.connectionId,
            row.credentialCiphertext,
            row.credentialNonce,
          ),
        ),
      );
    } catch {
      return false;
    }
    if (remoteMcpOAuthAccessToken(credential) !== null) return true;

    try {
      const refreshed = await refreshRemoteMcpOAuthCredential({
        credential,
        signal: AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
      });
      const encrypted = await encryptCredential(
        this.#encryptionSecret,
        row.connectionId,
        JSON.stringify(refreshed),
      );
      const refreshedAt = Date.now();
      const updated = this.#database.transaction((transaction) => {
        const current = storedConnection(transaction, row.connectionId);
        if (
          current === undefined ||
          current.status !== "active" ||
          current.snapshotDigest !== row.snapshotDigest ||
          current.credentialCiphertext !== row.credentialCiphertext
        ) {
          return false;
        }
        transaction
          .update(remoteMcpConnections)
          .set({
            credentialCiphertext: encrypted.ciphertext,
            credentialNonce: encrypted.nonce,
            oauthScopes: refreshed.grantedScopes,
          })
          .where(eq(remoteMcpConnections.connectionId, row.connectionId))
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "connection.remote_mcp_oauth_refreshed",
            clientId: "crewhelm:remote-mcp-oauth-refresh",
            occurredAt: refreshedAt,
            subjectId: row.connectionId,
          })
          .run();
        return true;
      });
      return updated;
    } catch {
      const failedAt = Date.now();
      this.#database.transaction((transaction) => {
        const current = storedConnection(transaction, row.connectionId);
        if (
          current === undefined ||
          current.status !== "active" ||
          current.snapshotDigest !== row.snapshotDigest ||
          current.credentialCiphertext !== row.credentialCiphertext
        ) {
          return;
        }
        transaction
          .update(connections)
          .set({ status: "unavailable" })
          .where(
            and(
              eq(connections.connectionId, row.connectionId),
              eq(connections.provider, "remote_mcp"),
              eq(connections.status, "active"),
            ),
          )
          .run();
        transaction
          .insert(auditEvents)
          .values({
            action: "connection.remote_mcp_oauth_reauthentication_required",
            clientId: "crewhelm:remote-mcp-oauth-refresh",
            occurredAt: failedAt,
            subjectId: row.connectionId,
          })
          .run();
      });
      return false;
    }
  }

  lookupCreation(
    authority: OwnerAuthority,
    input: unknown,
  ): LookupRemoteMcpConnectionCreationResult {
    const request = lookupRemoteMcpConnectionCreationInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");

    try {
      if (normalizeRemoteMcpEndpoint(request.data.endpoint) !== request.data.endpoint) {
        return denied("invalid_request");
      }
    } catch {
      return denied("invalid_request");
    }

    const existing = this.#database
      .select()
      .from(remoteMcpConnectionMutations)
      .where(
        and(
          eq(remoteMcpConnectionMutations.clientId, authority.clientId),
          eq(remoteMcpConnectionMutations.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();

    if (existing === undefined) {
      return lookupRemoteMcpConnectionCreationResultSchema.parse({ connection: null, ok: true });
    }
    if (existing.operation !== "create") return denied("idempotency_conflict");

    const row = storedConnection(this.#database, existing.connectionId);
    if (row === undefined) return denied("connection_not_found");
    if (
      row.authKind !== request.data.authKind ||
      row.apiKeyHeaderName !== (request.data.apiKeyHeaderName ?? null) ||
      row.endpoint !== request.data.endpoint ||
      row.accountLabel !== request.data.name ||
      JSON.stringify(row.oauthScopes) !== JSON.stringify(request.data.oauthScopes)
    ) {
      return denied("idempotency_conflict");
    }

    return lookupRemoteMcpConnectionCreationResultSchema.parse({
      connection: present(row),
      ok: true,
    });
  }

  async create(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<CreateRemoteMcpConnectionResult> {
    const request = createRemoteMcpConnectionInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");

    try {
      if (normalizeRemoteMcpEndpoint(request.data.endpoint) !== request.data.endpoint) {
        return denied("invalid_request");
      }
    } catch {
      return denied("invalid_request");
    }

    const catalog = remoteMcpCatalogSchema.safeParse(request.data.catalog);
    if (!catalog.success) return denied("invalid_request");
    const serializedCatalog = JSON.stringify(catalog.data);
    const catalogBytes = encoder.encode(serializedCatalog).byteLength;
    const snapshotDigest = await sha256(serializedCatalog);
    if (
      catalogBytes !== request.data.catalogBytes ||
      snapshotDigest !== request.data.snapshotDigest
    ) {
      return denied("invalid_request");
    }

    const digest = await requestDigest(this.#encryptionSecret, request.data);
    const existing = this.#database
      .select()
      .from(remoteMcpConnectionMutations)
      .where(
        and(
          eq(remoteMcpConnectionMutations.clientId, authority.clientId),
          eq(remoteMcpConnectionMutations.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();

    if (existing !== undefined) {
      if (existing.operation !== "create" || existing.requestDigest !== digest) {
        return denied("idempotency_conflict");
      }
      const row = storedConnection(this.#database, existing.connectionId);
      return row === undefined
        ? denied("connection_not_found")
        : createRemoteMcpConnectionResultSchema.parse({
            connection: present(row),
            created: false,
            ok: true,
          });
    }

    const usage = this.#database.select({ value: count() }).from(connections).get()?.value ?? 0;
    if (usage >= this.#currentFleetConfiguration().capacity.maxConnections) {
      return denied("connection_limit_exceeded");
    }

    const connectionId = `connection_${crypto.randomUUID()}`;
    const credential = request.data.apiKey?.value ?? request.data.bearerToken;
    const encrypted =
      credential === undefined
        ? undefined
        : await encryptCredential(this.#encryptionSecret, connectionId, credential);
    const occurredAt = Date.now();

    this.#database.transaction((transaction) => {
      transaction
        .insert(connections)
        .values({
          accountLabel: request.data.name,
          authConfigId: null,
          connectionId,
          createdAt: occurredAt,
          provider: "remote_mcp",
          providerConnectionId: null,
          status: "active",
        })
        .run();
      transaction
        .insert(remoteMcpConnections)
        .values({
          apiKeyHeaderName: request.data.apiKey?.headerName,
          authKind: request.data.authKind,
          catalog: catalog.data,
          catalogBytes,
          connectionId,
          credentialCiphertext: encrypted?.ciphertext,
          credentialNonce: encrypted?.nonce,
          endpoint: request.data.endpoint,
          oauthScopes: [],
          serverName: request.data.server.name,
          serverVersion: request.data.server.version,
          snapshotDigest,
        })
        .run();
      transaction
        .insert(remoteMcpConnectionMutations)
        .values({
          clientId: authority.clientId,
          connectionId,
          idempotencyKey: request.data.idempotencyKey,
          occurredAt,
          operation: "create",
          requestDigest: digest,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.remote_mcp_created",
          clientId: authority.clientId,
          occurredAt,
          subjectId: connectionId,
        })
        .run();
    });

    const row = storedConnection(this.#database, connectionId);
    if (row === undefined) throw new Error("Remote MCP Connection creation failed.");
    return createRemoteMcpConnectionResultSchema.parse({
      connection: present(row),
      created: true,
      ok: true,
    });
  }

  async reauthenticate(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<ReauthenticateRemoteMcpConnectionResult> {
    const request = reauthenticateRemoteMcpConnectionInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");

    const catalog = remoteMcpCatalogSchema.safeParse(request.data.catalog);
    if (!catalog.success) return denied("invalid_request");
    const serializedCatalog = JSON.stringify(catalog.data);
    if (
      encoder.encode(serializedCatalog).byteLength !== request.data.catalogBytes ||
      (await sha256(serializedCatalog)) !== request.data.snapshotDigest
    ) {
      return denied("invalid_request");
    }

    const digest = await requestDigest(this.#encryptionSecret, request.data);
    const priorMutation = this.#database
      .select()
      .from(remoteMcpConnectionMutations)
      .where(
        and(
          eq(remoteMcpConnectionMutations.clientId, authority.clientId),
          eq(remoteMcpConnectionMutations.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();
    if (priorMutation !== undefined) {
      if (priorMutation.operation !== "reauthenticate" || priorMutation.requestDigest !== digest) {
        return denied("idempotency_conflict");
      }
      const replay = storedConnection(this.#database, priorMutation.connectionId);
      return replay === undefined
        ? denied("connection_not_found")
        : reauthenticateRemoteMcpConnectionResultSchema.parse({
            connection: present(replay),
            ok: true,
            reauthenticated: false,
          });
    }

    const existing = storedConnection(this.#database, request.data.connectionId);
    if (existing === undefined) return denied("connection_not_found");
    if (existing.snapshotDigest !== request.data.snapshotDigest) {
      return denied("revision_conflict");
    }
    if (
      !["active", "unavailable"].includes(existing.status) ||
      existing.authKind !== request.data.authKind ||
      existing.serverName !== request.data.server.name ||
      existing.serverVersion !== request.data.server.version ||
      (request.data.authKind === "api_key" &&
        existing.apiKeyHeaderName !== request.data.apiKey.headerName)
    ) {
      return denied("connection_not_found");
    }

    const credential =
      request.data.authKind === "api_key" ? request.data.apiKey.value : request.data.bearerToken;
    const encrypted = await encryptCredential(
      this.#encryptionSecret,
      existing.connectionId,
      credential,
    );
    const occurredAt = Date.now();

    this.#database.transaction((transaction) => {
      const current = storedConnection(transaction, existing.connectionId);
      if (
        current === undefined ||
        !["active", "unavailable"].includes(current.status) ||
        current.authKind !== existing.authKind ||
        current.apiKeyHeaderName !== existing.apiKeyHeaderName ||
        current.snapshotDigest !== existing.snapshotDigest ||
        current.serverName !== existing.serverName ||
        current.serverVersion !== existing.serverVersion ||
        current.credentialCiphertext !== existing.credentialCiphertext ||
        current.credentialNonce !== existing.credentialNonce
      ) {
        throw new Error("Remote MCP reauthentication target changed.");
      }
      transaction
        .update(remoteMcpConnections)
        .set({
          credentialCiphertext: encrypted.ciphertext,
          credentialNonce: encrypted.nonce,
        })
        .where(eq(remoteMcpConnections.connectionId, existing.connectionId))
        .run();
      transaction
        .update(connections)
        .set({ status: "active" })
        .where(
          and(
            eq(connections.connectionId, existing.connectionId),
            eq(connections.provider, "remote_mcp"),
          ),
        )
        .run();
      transaction
        .insert(remoteMcpConnectionMutations)
        .values({
          clientId: authority.clientId,
          connectionId: existing.connectionId,
          idempotencyKey: request.data.idempotencyKey,
          occurredAt,
          operation: "reauthenticate",
          requestDigest: digest,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.remote_mcp_reauthenticated",
          clientId: authority.clientId,
          occurredAt,
          subjectId: existing.connectionId,
        })
        .run();
    });

    const reauthenticated = storedConnection(this.#database, existing.connectionId);
    if (reauthenticated === undefined) throw new Error("Remote MCP reauthentication failed.");
    return reauthenticateRemoteMcpConnectionResultSchema.parse({
      connection: present(reauthenticated),
      ok: true,
      reauthenticated: true,
    });
  }

  inspect(input: unknown): InspectRemoteMcpConnectionResult {
    const request = inspectRemoteMcpConnectionInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const row = storedConnection(this.#database, request.data.connectionId);
    return row === undefined
      ? denied("connection_not_found")
      : inspectRemoteMcpConnectionResultSchema.parse({ connection: present(row), ok: true });
  }

  async delete(
    authority: OwnerAuthority,
    input: unknown,
  ): Promise<DeleteRemoteMcpConnectionResult> {
    const request = deleteRemoteMcpConnectionInputSchema.safeParse(input);
    if (!request.success) return denied("invalid_request");
    const digest = await requestDigest(this.#encryptionSecret, request.data);
    const existing = this.#database
      .select()
      .from(remoteMcpConnectionMutations)
      .where(
        and(
          eq(remoteMcpConnectionMutations.clientId, authority.clientId),
          eq(remoteMcpConnectionMutations.idempotencyKey, request.data.idempotencyKey),
        ),
      )
      .get();
    if (existing !== undefined) {
      return existing.operation === "delete" && existing.requestDigest === digest
        ? deleteRemoteMcpConnectionResultSchema.parse({ deleted: false, ok: true })
        : denied("idempotency_conflict");
    }

    const row = storedConnection(this.#database, request.data.connectionId);
    if (row === undefined) return denied("connection_not_found");
    if (row.snapshotDigest !== request.data.snapshotDigest) return denied("revision_conflict");
    let oauthCredential: RemoteMcpOAuthCredential | undefined;
    if (
      row.authKind === "oauth" &&
      row.credentialCiphertext !== null &&
      row.credentialNonce !== null
    ) {
      try {
        oauthCredential = remoteMcpOAuthCredentialSchema.parse(
          JSON.parse(
            await decryptCredential(
              this.#encryptionSecret,
              row.connectionId,
              row.credentialCiphertext,
              row.credentialNonce,
            ),
          ),
        );
      } catch {
        oauthCredential = undefined;
      }
    }
    const deleted = row.status !== "revoked";
    const occurredAt = Date.now();

    this.#database.transaction((transaction) => {
      transaction
        .update(connections)
        .set({ revokedAt: occurredAt, status: "revoked" })
        .where(
          and(
            eq(connections.connectionId, row.connectionId),
            eq(connections.provider, "remote_mcp"),
          ),
        )
        .run();
      transaction
        .update(remoteMcpConnections)
        .set({ credentialCiphertext: null, credentialNonce: null })
        .where(eq(remoteMcpConnections.connectionId, row.connectionId))
        .run();
      transaction
        .update(capabilityGrants)
        .set({ revokedAt: occurredAt, status: "revoked" })
        .where(
          and(
            eq(capabilityGrants.connectionId, row.connectionId),
            eq(capabilityGrants.status, "active"),
          ),
        )
        .run();
      transaction
        .insert(remoteMcpConnectionMutations)
        .values({
          clientId: authority.clientId,
          connectionId: row.connectionId,
          idempotencyKey: request.data.idempotencyKey,
          occurredAt,
          operation: "delete",
          requestDigest: digest,
        })
        .run();
      transaction
        .insert(auditEvents)
        .values({
          action: "connection.remote_mcp_deleted",
          clientId: authority.clientId,
          occurredAt,
          subjectId: row.connectionId,
        })
        .run();
    });

    if (deleted && row.authKind === "oauth") {
      const revocation =
        oauthCredential === undefined
          ? "unconfirmed"
          : await revokeRemoteMcpOAuthCredential({
              credential: oauthCredential,
              signal: AbortSignal.timeout(OAUTH_NETWORK_TIMEOUT_MS),
            });
      this.#database
        .insert(auditEvents)
        .values({
          action: `connection.remote_mcp_oauth_revocation_${revocation}`,
          clientId: authority.clientId,
          occurredAt: Date.now(),
          subjectId: row.connectionId,
        })
        .run();
    }

    return deleteRemoteMcpConnectionResultSchema.parse({ deleted, ok: true });
  }

  async execute(input: {
    arguments: Record<string, unknown>;
    connectionId: string;
    maximumDurationMs: number;
    maximumOutputBytes: number;
    snapshotDigest: string;
    toolName: string;
  }): Promise<unknown> {
    const row = this.#database
      .select({
        apiKeyHeaderName: remoteMcpConnections.apiKeyHeaderName,
        authKind: remoteMcpConnections.authKind,
        catalog: remoteMcpConnections.catalog,
        ciphertext: remoteMcpConnections.credentialCiphertext,
        endpoint: remoteMcpConnections.endpoint,
        nonce: remoteMcpConnections.credentialNonce,
        snapshotDigest: remoteMcpConnections.snapshotDigest,
        status: connections.status,
      })
      .from(remoteMcpConnections)
      .innerJoin(connections, eq(connections.connectionId, remoteMcpConnections.connectionId))
      .where(
        and(
          eq(remoteMcpConnections.connectionId, input.connectionId),
          eq(connections.provider, "remote_mcp"),
        ),
      )
      .get();
    const tool = row?.catalog.find(({ name }) => name === input.toolName);
    if (
      row === undefined ||
      row.status !== "active" ||
      row.snapshotDigest !== input.snapshotDigest ||
      tool === undefined ||
      (row.authKind !== "public" && (row.ciphertext === null || row.nonce === null))
    ) {
      throw new Error("Remote MCP execution denied.");
    }

    try {
      const inputSchema = createRemoteMcpInputSchema(tool.inputSchema);
      if (!inputSchema.safeParse(input.arguments).success) {
        throw new Error("Remote MCP execution denied.");
      }
    } catch {
      throw new Error("Remote MCP execution denied.");
    }

    let bearerToken: string | undefined;
    let apiKey: { headerName: string; value: string } | undefined;
    if (row.authKind !== "public" && row.ciphertext !== null && row.nonce !== null) {
      const plaintext = await decryptCredential(
        this.#encryptionSecret,
        input.connectionId,
        row.ciphertext,
        row.nonce,
      );
      if (row.authKind === "bearer") {
        bearerToken = plaintext;
      } else if (row.authKind === "api_key") {
        apiKey = remoteMcpApiKeyCredentialSchema.parse({
          headerName: row.apiKeyHeaderName,
          value: plaintext,
        });
      } else {
        const credential = remoteMcpOAuthCredentialSchema.parse(JSON.parse(plaintext));
        bearerToken = remoteMcpOAuthAccessToken(credential) ?? undefined;
        if (bearerToken === undefined) throw new Error("Remote MCP execution denied.");
      }
    }

    const execution = {
      arguments: input.arguments,
      endpoint: row.endpoint,
      maximumOutputBytes: input.maximumOutputBytes,
      signal: AbortSignal.timeout(input.maximumDurationMs),
      toolName: input.toolName,
    };
    if (apiKey !== undefined) return callRemoteMcpTool({ ...execution, apiKey });
    if (bearerToken !== undefined) return callRemoteMcpTool({ ...execution, bearerToken });
    return callRemoteMcpTool(execution);
  }

  #failOAuthRequest(requestId: string, occurredAt: number): boolean {
    return (
      this.#database
        .update(remoteMcpOAuthRequests)
        .set({
          authorizationUrl: null,
          completedAt: occurredAt,
          credentialCiphertext: null,
          credentialNonce: null,
          status: "failed",
        })
        .where(
          and(
            eq(remoteMcpOAuthRequests.requestId, requestId),
            inArray(remoteMcpOAuthRequests.status, [
              "reserved",
              "starting",
              "pending",
              "exchanging",
            ]),
          ),
        )
        .returning({ requestId: remoteMcpOAuthRequests.requestId })
        .all().length === 1
    );
  }
}
