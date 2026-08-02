import {
  createRemoteMcpConnectionInputSchema,
  createRemoteMcpConnectionResultSchema,
  deleteRemoteMcpConnectionInputSchema,
  deleteRemoteMcpConnectionResultSchema,
  inspectRemoteMcpConnectionInputSchema,
  inspectRemoteMcpConnectionResultSchema,
  lookupRemoteMcpConnectionCreationInputSchema,
  lookupRemoteMcpConnectionCreationResultSchema,
  remoteMcpCatalogSchema,
  remoteMcpConnectionSchema,
  type CreateRemoteMcpConnectionResult,
  type DeleteRemoteMcpConnectionResult,
  type FleetConfigurationData,
  type InspectRemoteMcpConnectionResult,
  type LookupRemoteMcpConnectionCreationResult,
  type OwnerAuthority,
  type RemoteMcpAuthKind,
  type RemoteMcpCatalog,
} from "@crewhelm/contracts";
import { and, count, eq } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import { callRemoteMcpTool, normalizeRemoteMcpEndpoint } from "../../remote-mcp/client.js";
import { createRemoteMcpInputSchema } from "../../remote-mcp/schema.js";

import {
  auditEvents,
  capabilityGrants,
  connections,
  remoteMcpConnectionMutations,
  remoteMcpConnections,
  type ControlPlaneDatabaseSchema,
} from "../schema.js";

type Database = DrizzleSqliteDODatabase<ControlPlaneDatabaseSchema>;
type RequestFailure = Extract<CreateRemoteMcpConnectionResult, { ok: false }>;
type StoredConnection = {
  accountLabel: string | null;
  authKind: RemoteMcpAuthKind;
  catalog: RemoteMcpCatalog;
  catalogBytes: number;
  connectionId: string;
  createdAt: number;
  endpoint: string;
  serverName: string;
  serverVersion: string;
  snapshotDigest: string;
  status: "active" | "initiated" | "revoked" | "unavailable";
};

const encoder = new TextEncoder();

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

function storedConnection(database: Database, connectionId: string): StoredConnection | undefined {
  return database
    .select({
      accountLabel: connections.accountLabel,
      authKind: remoteMcpConnections.authKind,
      catalog: remoteMcpConnections.catalog,
      catalogBytes: remoteMcpConnections.catalogBytes,
      connectionId: connections.connectionId,
      createdAt: connections.createdAt,
      endpoint: remoteMcpConnections.endpoint,
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
    authKind: row.authKind,
    catalog: row.catalog,
    catalogBytes: row.catalogBytes,
    connectionId: row.connectionId,
    createdAt: new Date(row.createdAt).toISOString(),
    endpoint: row.endpoint,
    name: row.accountLabel,
    server: { name: row.serverName, version: row.serverVersion },
    snapshotDigest: row.snapshotDigest,
    status: row.status,
  });
}

export class RemoteMcpConnections {
  readonly #currentFleetConfiguration: () => FleetConfigurationData;
  readonly #database: Database;
  readonly #encryptionSecret: string;

  constructor(
    database: Database,
    currentFleetConfiguration: () => FleetConfigurationData,
    encryptionSecret: string,
  ) {
    this.#currentFleetConfiguration = currentFleetConfiguration;
    this.#database = database;
    this.#encryptionSecret = encryptionSecret;
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
      row.endpoint !== request.data.endpoint ||
      row.accountLabel !== request.data.name
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
    const encrypted =
      request.data.bearerToken === undefined
        ? undefined
        : await encryptCredential(this.#encryptionSecret, connectionId, request.data.bearerToken);
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
          authKind: request.data.authKind,
          catalog: catalog.data,
          catalogBytes,
          connectionId,
          credentialCiphertext: encrypted?.ciphertext,
          credentialNonce: encrypted?.nonce,
          endpoint: request.data.endpoint,
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
      (row.authKind === "bearer" && (row.ciphertext === null || row.nonce === null))
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

    const bearerToken =
      row.authKind === "bearer" && row.ciphertext !== null && row.nonce !== null
        ? await decryptCredential(
            this.#encryptionSecret,
            input.connectionId,
            row.ciphertext,
            row.nonce,
          )
        : undefined;

    return callRemoteMcpTool({
      arguments: input.arguments,
      ...(bearerToken === undefined ? {} : { bearerToken }),
      endpoint: row.endpoint,
      maximumOutputBytes: input.maximumOutputBytes,
      signal: AbortSignal.timeout(input.maximumDurationMs),
      toolName: input.toolName,
    });
  }
}
