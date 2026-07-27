import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  CONNECTIONS_READ_SCOPE,
  CONNECTIONS_WRITE_SCOPE,
  CONNECTION_LINK_UNKNOWN_RECOVERY_MS,
  agentRevisionSchema,
  agentRevisionSummarySchema,
  agentSchema,
  agentSummarySchema,
  controlPlaneStatusResultSchema,
  completeConnectionLinkInputSchema,
  connectionSummarySchema,
  createAgentInputSchema,
  createAgentResultSchema,
  createConnectionLinkInputSchema,
  createConnectionLinkResultSchema,
  getAgentInputSchema,
  getAgentRevisionInputSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsInputSchema,
  listAgentRevisionsResultSchema,
  listAgentsInputSchema,
  listAgentsResultSchema,
  listConnectionsInputSchema,
  listConnectionsResultSchema,
  MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER,
  MAXIMUM_CONNECTIONS_PER_OWNER,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_REVISIONS_PER_AGENT,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  ownerAuthoritySchema,
  reserveConnectionLinkResultSchema,
  updateAgentInputSchema,
  updateAgentResultSchema,
  type Agent,
  type AgentRevision,
  type AgentRevisionSummary,
  type AgentSummary,
  type ControlPlaneStatusResult,
  type CreateAgentInput,
  type CreateAgentResult,
  type CreateConnectionLinkInput,
  type CreateConnectionLinkResult,
  type ConnectionSummary,
  type GetAgentRevisionResult,
  type GetAgentResult,
  type ListAgentRevisionsResult,
  type ListAgentsResult,
  type ListConnectionsResult,
  type OwnerAuthority,
  type OwnerScope,
  type ReserveConnectionLinkResult,
  type UpdateAgentInput,
  type UpdateAgentResult,
} from "@crewhelm/contracts";
import { DurableObject } from "cloudflare:workers";

const CONTROL_PLANE_SCHEMA_VERSION = 3;
const COMPOSIO_CONNECT_ORIGIN = "https://connect.composio.dev";
type AuthorityErrorCode =
  | "incompatible_schema"
  | "insufficient_scope"
  | "invalid_authority"
  | "owner_mismatch";
type AgentRequestErrorCode =
  | AuthorityErrorCode
  | "agent_limit_exceeded"
  | "agent_not_found"
  | "agent_revision_limit_exceeded"
  | "idempotency_conflict"
  | "invalid_request"
  | "no_changes"
  | "revision_conflict";
type AgentRequestFailure = Extract<CreateAgentResult, { ok: false }>;
type ConnectionLinkRequestErrorCode =
  | AuthorityErrorCode
  | "connection_limit_exceeded"
  | "connection_link_expired"
  | "connection_link_in_progress"
  | "connection_link_outcome_unknown"
  | "connection_link_request_limit_exceeded"
  | "connection_link_unavailable"
  | "idempotency_conflict"
  | "invalid_request";
type ConnectionLinkRequestFailure = Extract<CreateConnectionLinkResult, { ok: false }>;
type ConnectionReadRequestErrorCode = AuthorityErrorCode | "invalid_request";
type ConnectionReadRequestFailure = Extract<ListConnectionsResult, { ok: false }>;
type AuthorityResult =
  | { authority: OwnerAuthority; ok: true }
  | { code: AuthorityErrorCode; ok: false };

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

async function digestAgentCreation(input: CreateAgentInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      executionLimits: {
        maxDurationSeconds: input.executionLimits.maxDurationSeconds,
        maxModelTokens: input.executionLimits.maxModelTokens,
        maxToolCalls: input.executionLimits.maxToolCalls,
        maxTurns: input.executionLimits.maxTurns,
      },
      instructions: input.instructions,
      model: input.model,
      name: input.name,
    }),
  );
}

async function digestAgentUpdate(input: UpdateAgentInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      id: input.id,
      expectedRevision: input.expectedRevision,
      executionLimits: {
        maxDurationSeconds: input.executionLimits.maxDurationSeconds,
        maxModelTokens: input.executionLimits.maxModelTokens,
        maxToolCalls: input.executionLimits.maxToolCalls,
        maxTurns: input.executionLimits.maxTurns,
      },
      instructions: input.instructions,
      model: input.model,
      name: input.name,
    }),
  );
}

async function digestConnectionLink(input: CreateConnectionLinkInput): Promise<string> {
  return digestCanonicalRequest(
    JSON.stringify({
      authConfigId: input.authConfigId,
    }),
  );
}

function isCanonicalComposioConnectUrl(value: string): boolean {
  const url = new URL(value);

  return (
    url.origin === COMPOSIO_CONNECT_ORIGIN &&
    /^\/link\/ln_[A-Za-z0-9_-]+$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === ""
  );
}

export class OwnerControlPlane extends DurableObject {
  readonly #objectName: string | undefined;
  readonly #sql: SqlStorage;
  readonly #storage: DurableObjectStorage;

  constructor(state: DurableObjectState, environment: Cloudflare.Env) {
    super(state, environment);
    this.#objectName = state.id.name;
    this.#sql = state.storage.sql;
    this.#storage = state.storage;
    this.#sql.exec("PRAGMA foreign_keys = ON");
    this.#storage.transactionSync(() => {
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS control_plane (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_key TEXT NOT NULL UNIQUE,
          schema_version INTEGER NOT NULL CHECK (schema_version = 1)
        )
      `);
      const controlPlane = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT schema_version FROM control_plane WHERE singleton = 1",
        )
        .toArray()[0];
      const controlPlaneTable = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'control_plane'",
        )
        .one();
      const controlPlaneDefinition = controlPlaneTable["sql"];
      const isEmptyMigratableTable =
        typeof controlPlaneDefinition === "string" &&
        (controlPlaneDefinition.includes("schema_version = 1") ||
          controlPlaneDefinition.includes("schema_version = 2"));

      if (
        (controlPlane === undefined && isEmptyMigratableTable) ||
        controlPlane?.["schema_version"] === 1 ||
        controlPlane?.["schema_version"] === 2
      ) {
        this.#sql.exec("ALTER TABLE control_plane RENAME TO control_plane_previous");
        this.#sql.exec(`
          CREATE TABLE control_plane (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_key TEXT NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL CHECK (schema_version = 3)
          )
        `);
        this.#sql.exec(`
          INSERT INTO control_plane (singleton, owner_key, schema_version)
          SELECT singleton, owner_key, 3 FROM control_plane_previous
        `);
        this.#sql.exec("DROP TABLE control_plane_previous");
      } else if (controlPlane?.["schema_version"] !== CONTROL_PLANE_SCHEMA_VERSION) {
        return;
      }
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS agents (
          agent_id TEXT PRIMARY KEY,
          current_revision INTEGER NOT NULL CHECK (current_revision > 0),
          created_at INTEGER NOT NULL CHECK (created_at > 0)
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_revisions (
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          name TEXT NOT NULL,
          model TEXT NOT NULL,
          instructions TEXT NOT NULL,
          execution_limits TEXT NOT NULL,
          capability_grants TEXT NOT NULL CHECK (capability_grants = '[]'),
          created_at INTEGER NOT NULL CHECK (created_at > 0),
          PRIMARY KEY (agent_id, revision),
          FOREIGN KEY (agent_id) REFERENCES agents(agent_id) ON DELETE RESTRICT
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_creations (
          client_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL CHECK (length(request_digest) = 43),
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          PRIMARY KEY (client_id, idempotency_key),
          UNIQUE (agent_id, revision),
          FOREIGN KEY (agent_id, revision)
            REFERENCES agent_revisions(agent_id, revision) ON DELETE RESTRICT
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_updates (
          client_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL CHECK (length(request_digest) = 43),
          agent_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 1),
          PRIMARY KEY (client_id, idempotency_key),
          UNIQUE (agent_id, revision),
          FOREIGN KEY (agent_id, revision)
            REFERENCES agent_revisions(agent_id, revision) ON DELETE RESTRICT
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS audit_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          occurred_at INTEGER NOT NULL CHECK (occurred_at > 0),
          client_id TEXT NOT NULL,
          action TEXT NOT NULL,
          subject_id TEXT NOT NULL
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS connections (
          connection_id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider = 'composio'),
          provider_connection_id TEXT NOT NULL UNIQUE,
          auth_config_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status = 'initiated'),
          created_at INTEGER NOT NULL CHECK (created_at > 0)
        )
      `);
      this.#sql.exec(`
        CREATE TABLE IF NOT EXISTS connection_link_requests (
          client_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_digest TEXT NOT NULL CHECK (length(request_digest) = 43),
          auth_config_id TEXT NOT NULL,
          reservation_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'completed', 'expired', 'abandoned')),
          recover_after INTEGER NOT NULL CHECK (recover_after > 0),
          connection_id TEXT,
          redirect_url TEXT,
          expires_at INTEGER,
          created_at INTEGER NOT NULL CHECK (created_at > 0),
          completed_at INTEGER,
          PRIMARY KEY (client_id, idempotency_key),
          FOREIGN KEY (connection_id) REFERENCES connections(connection_id) ON DELETE RESTRICT,
          CHECK (
            (status = 'completed'
              AND connection_id IS NOT NULL
              AND redirect_url IS NOT NULL
              AND expires_at IS NOT NULL
              AND completed_at IS NOT NULL)
            OR
            (status = 'expired'
              AND connection_id IS NOT NULL
              AND redirect_url IS NULL
              AND expires_at IS NOT NULL
              AND completed_at IS NOT NULL)
            OR
            (status IN ('pending', 'abandoned')
              AND connection_id IS NULL
              AND redirect_url IS NULL
              AND expires_at IS NULL
              AND completed_at IS NULL)
          )
        )
      `);
      this.#sql.exec(`
        CREATE INDEX IF NOT EXISTS connection_link_requests_pending_auth_config
        ON connection_link_requests (auth_config_id, recover_after)
        WHERE status = 'pending'
      `);
    });
  }

  status(authorityInput: unknown): ControlPlaneStatusResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedStatus(authorization.code);
    }

    return controlPlaneStatusResultSchema.parse({
      ok: true,
      status: {
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
        status: "ready",
      },
    });
  }

  async createAgent(authorityInput: unknown, input: unknown): Promise<CreateAgentResult> {
    const authorization = this.#authorize(authorityInput, OWNER_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = createAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const requestDigest = await digestAgentCreation(request.data);

    return this.#storage.transactionSync(() => {
      const existingRow = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT
               a.agent_id,
               c.revision AS current_revision,
               c.request_digest,
               a.created_at,
               r.name,
               r.model,
               r.instructions,
               r.execution_limits,
               r.capability_grants
             FROM agent_creations c
             JOIN agents a ON a.agent_id = c.agent_id
             JOIN agent_revisions r
               ON r.agent_id = c.agent_id AND r.revision = c.revision
             WHERE c.client_id = ? AND c.idempotency_key = ?`,
          authorization.authority.clientId,
          request.data.idempotencyKey,
        )
        .toArray()[0];

      if (existingRow !== undefined) {
        if (existingRow["request_digest"] !== requestDigest) {
          return this.#deniedAgent("idempotency_conflict");
        }

        return createAgentResultSchema.parse({
          agent: this.#agentFromRow(existingRow),
          created: false,
          ok: true,
        });
      }

      const agentCount = this.#sql
        .exec<Record<string, SqlStorageValue>>("SELECT COUNT(*) AS count FROM agents")
        .one()["count"];

      if (typeof agentCount !== "number") {
        throw new Error("Invalid Agent count.");
      }

      if (agentCount >= MAXIMUM_AGENTS_PER_OWNER) {
        return this.#deniedAgent("agent_limit_exceeded");
      }

      const agentId = `agent_${crypto.randomUUID()}`;
      const createdAt = Date.now();
      const executionLimits = JSON.stringify(request.data.executionLimits);

      this.#sql.exec(
        `INSERT INTO agents (agent_id, current_revision, created_at) VALUES (?, 1, ?)`,
        agentId,
        createdAt,
      );
      this.#sql.exec(
        `INSERT INTO agent_revisions
             (agent_id, revision, name, model, instructions, execution_limits,
              capability_grants, created_at)
           VALUES (?, 1, ?, ?, ?, ?, '[]', ?)`,
        agentId,
        request.data.name,
        request.data.model,
        request.data.instructions,
        executionLimits,
        createdAt,
      );
      this.#sql.exec(
        `INSERT INTO agent_creations
             (client_id, idempotency_key, request_digest, agent_id, revision)
           VALUES (?, ?, ?, ?, 1)`,
        authorization.authority.clientId,
        request.data.idempotencyKey,
        requestDigest,
        agentId,
      );
      this.#sql.exec(
        `INSERT INTO audit_events (occurred_at, client_id, action, subject_id)
           VALUES (?, ?, 'agent.created', ?)`,
        createdAt,
        authorization.authority.clientId,
        agentId,
      );

      const agent = agentSchema.parse({
        capabilityGrants: [],
        createdAt: new Date(createdAt).toISOString(),
        executionLimits: request.data.executionLimits,
        id: agentId,
        instructions: request.data.instructions,
        model: request.data.model,
        name: request.data.name,
        revision: 1,
      });

      return createAgentResultSchema.parse({ agent, created: true, ok: true });
    });
  }

  async reserveConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<ReserveConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionLink(authorization.code);
    }

    const request = createConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionLink("invalid_request");
    }

    const requestDigest = await digestConnectionLink(request.data);
    const currentTime = Date.now();
    const recoverAfter = currentTime + CONNECTION_LINK_UNKNOWN_RECOVERY_MS;

    await this.#scheduleConnectionLinkCleanup(recoverAfter);

    return this.#storage.transactionSync(() => {
      this.#expireConnectionLinkRequests(currentTime);

      const existingRequest = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT
             request_digest,
             status,
             reservation_id,
             connection_id,
             redirect_url,
             expires_at
           FROM connection_link_requests
           WHERE client_id = ? AND idempotency_key = ?`,
          authorization.authority.clientId,
          request.data.idempotencyKey,
        )
        .toArray()[0];

      if (existingRequest !== undefined) {
        if (existingRequest["request_digest"] !== requestDigest) {
          return this.#deniedConnectionLink("idempotency_conflict");
        }

        if (existingRequest["status"] === "expired") {
          return this.#deniedConnectionLink("connection_link_expired");
        }

        if (existingRequest["status"] !== "completed") {
          return this.#deniedConnectionLink("connection_link_outcome_unknown");
        }

        const expiresAt = existingRequest["expires_at"];

        if (typeof expiresAt !== "number" || expiresAt <= currentTime) {
          return this.#deniedConnectionLink("connection_link_expired");
        }

        return reserveConnectionLinkResultSchema.parse({
          connectionLink: this.#connectionLinkFromRow(existingRequest),
          ok: true,
          state: "replay",
        });
      }

      const pendingRequest = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT reservation_id
           FROM connection_link_requests
           WHERE auth_config_id = ? AND status = 'pending' AND recover_after > ?
           LIMIT 1`,
          request.data.authConfigId,
          currentTime,
        )
        .toArray()[0];

      if (pendingRequest !== undefined) {
        return this.#deniedConnectionLink("connection_link_in_progress");
      }

      const requestCount = this.#countRows("connection_link_requests");

      if (requestCount >= MAXIMUM_CONNECTION_LINK_REQUESTS_PER_OWNER) {
        return this.#deniedConnectionLink("connection_link_request_limit_exceeded");
      }

      const connectionCount = this.#countRows("connections");
      const pendingCount = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count
           FROM connection_link_requests
           WHERE status = 'pending' AND recover_after > ?`,
          currentTime,
        )
        .one()["count"];

      if (
        typeof pendingCount !== "number" ||
        connectionCount + pendingCount >= MAXIMUM_CONNECTIONS_PER_OWNER
      ) {
        return this.#deniedConnectionLink("connection_limit_exceeded");
      }

      const reservationId = `connection_link_${crypto.randomUUID()}`;

      this.#sql.exec(
        `INSERT INTO connection_link_requests
           (client_id, idempotency_key, request_digest, auth_config_id, reservation_id,
            status, recover_after, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
        authorization.authority.clientId,
        request.data.idempotencyKey,
        requestDigest,
        request.data.authConfigId,
        reservationId,
        recoverAfter,
        currentTime,
      );
      this.#sql.exec(
        `INSERT INTO audit_events (occurred_at, client_id, action, subject_id)
         VALUES (?, ?, 'connection.link_reserved', ?)`,
        currentTime,
        authorization.authority.clientId,
        reservationId,
      );

      return reserveConnectionLinkResultSchema.parse({
        ok: true,
        reservationId,
        state: "dispatch",
      });
    });
  }

  async completeConnectionLink(
    authorityInput: unknown,
    input: unknown,
  ): Promise<CreateConnectionLinkResult> {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionLink(authorization.code);
    }

    const request = completeConnectionLinkInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionLink("invalid_request");
    }

    if (!isCanonicalComposioConnectUrl(request.data.url)) {
      return this.#deniedConnectionLink("invalid_request");
    }

    const result = this.#storage.transactionSync(() => {
      const currentTime = Date.now();

      this.#expireConnectionLinkRequests(currentTime);

      const row = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT
             r.status,
             r.recover_after,
             r.connection_id,
             r.redirect_url,
             r.expires_at,
             r.auth_config_id,
             c.provider_connection_id
           FROM connection_link_requests r
           LEFT JOIN connections c ON c.connection_id = r.connection_id
           WHERE r.client_id = ? AND r.reservation_id = ?`,
          authorization.authority.clientId,
          request.data.reservationId,
        )
        .toArray()[0];

      if (row === undefined) {
        return this.#deniedConnectionLink("invalid_request");
      }

      if (row["status"] === "expired") {
        return this.#deniedConnectionLink("connection_link_expired");
      }

      if (row["status"] === "completed") {
        if (
          row["provider_connection_id"] !== request.data.providerConnectionId ||
          row["redirect_url"] !== request.data.url ||
          row["expires_at"] !== Date.parse(request.data.expiresAt)
        ) {
          return this.#deniedConnectionLink("invalid_request");
        }

        return createConnectionLinkResultSchema.parse({
          connectionLink: this.#connectionLinkFromRow(row),
          created: false,
          ok: true,
        });
      }

      const recoverAfter = row["recover_after"];
      const expiresAt = Date.parse(request.data.expiresAt);

      if (
        row["status"] !== "pending" ||
        typeof recoverAfter !== "number" ||
        currentTime >= recoverAfter ||
        expiresAt <= currentTime ||
        expiresAt > recoverAfter
      ) {
        return this.#deniedConnectionLink("connection_link_outcome_unknown");
      }

      const authConfigId = row["auth_config_id"];

      if (typeof authConfigId !== "string") {
        throw new Error("Invalid connection-link storage.");
      }

      const existingConnection = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT connection_id, auth_config_id
           FROM connections
           WHERE provider_connection_id = ?`,
          request.data.providerConnectionId,
        )
        .toArray()[0];
      let connectionId: string;

      if (existingConnection === undefined) {
        connectionId = `connection_${crypto.randomUUID()}`;
        this.#sql.exec(
          `INSERT INTO connections
             (connection_id, provider, provider_connection_id, auth_config_id, status, created_at)
           VALUES (?, 'composio', ?, ?, 'initiated', ?)`,
          connectionId,
          request.data.providerConnectionId,
          authConfigId,
          currentTime,
        );
      } else {
        if (existingConnection["auth_config_id"] !== authConfigId) {
          return this.#deniedConnectionLink("connection_link_outcome_unknown");
        }

        const storedConnectionId = existingConnection["connection_id"];

        if (typeof storedConnectionId !== "string") {
          throw new Error("Invalid connection storage.");
        }

        connectionId = storedConnectionId;
      }

      this.#sql.exec(
        `UPDATE connection_link_requests
         SET status = 'completed',
             connection_id = ?,
             redirect_url = ?,
             expires_at = ?,
             completed_at = ?
         WHERE client_id = ? AND reservation_id = ? AND status = 'pending'`,
        connectionId,
        request.data.url,
        expiresAt,
        currentTime,
        authorization.authority.clientId,
        request.data.reservationId,
      );
      this.#sql.exec(
        `INSERT INTO audit_events (occurred_at, client_id, action, subject_id)
         VALUES (?, ?, 'connection.link_created', ?)`,
        currentTime,
        authorization.authority.clientId,
        connectionId,
      );

      return createConnectionLinkResultSchema.parse({
        connectionLink: {
          connectionId,
          expiresAt: request.data.expiresAt,
          url: request.data.url,
        },
        created: true,
        ok: true,
      });
    });

    if (result.ok) {
      await this.#scheduleConnectionLinkCleanup(Date.parse(result.connectionLink.expiresAt));
    }

    return result;
  }

  override async alarm(): Promise<void> {
    const nextCleanupAt = this.#storage.transactionSync(() => {
      const currentTime = Date.now();

      this.#expireConnectionLinkRequests(currentTime);

      const nextCleanup = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT MIN(cleanup_at) AS cleanup_at
           FROM (
             SELECT expires_at AS cleanup_at
             FROM connection_link_requests
             WHERE status = 'completed'
             UNION ALL
             SELECT recover_after AS cleanup_at
             FROM connection_link_requests
             WHERE status = 'pending'
           )`,
        )
        .one()["cleanup_at"];

      return typeof nextCleanup === "number" ? nextCleanup : null;
    });

    if (nextCleanupAt !== null) {
      await this.#storage.setAlarm(nextCleanupAt);
    }
  }

  getAgent(authorityInput: unknown, input: unknown): GetAgentResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = getAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const row = this.#currentAgentRow(request.data.id);

    if (row === undefined) {
      return this.#deniedAgent("agent_not_found");
    }

    return getAgentResultSchema.parse({
      agent: this.#agentFromRow(row),
      ok: true,
    });
  }

  getAgentRevision(authorityInput: unknown, input: unknown): GetAgentRevisionResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = getAgentRevisionInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const row = this.#agentRevisionRow(request.data.id, request.data.revision);

    if (row === undefined) {
      return this.#deniedAgent("agent_not_found");
    }

    return getAgentRevisionResultSchema.parse({
      agent: this.#agentRevisionFromRow(row),
      ok: true,
    });
  }

  listAgentRevisions(authorityInput: unknown, input: unknown): ListAgentRevisionsResult {
    const authorization = this.#authorize(authorityInput, AGENTS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = listAgentRevisionsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const bindings: Array<number | string> = [request.data.id];
    let cursorClause = "";

    if (request.data.cursor !== undefined) {
      cursorClause = "AND r.revision < ?";
      bindings.push(request.data.cursor);
    }

    bindings.push(request.data.limit + 1);
    const rows = this.#sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT
             a.agent_id,
             r.revision AS current_revision,
             a.created_at,
             r.created_at AS revised_at,
             r.name,
             r.model,
             r.execution_limits,
             r.capability_grants
           FROM agents a
           JOIN agent_revisions r ON r.agent_id = a.agent_id
           WHERE a.agent_id = ?
             ${cursorClause}
           ORDER BY r.revision DESC
           LIMIT ?`,
        ...bindings,
      )
      .toArray();

    if (rows.length === 0 && !this.#agentExists(request.data.id)) {
      return this.#deniedAgent("agent_not_found");
    }

    const hasMore = rows.length > request.data.limit;
    const revisions = rows
      .slice(0, request.data.limit)
      .map((row) => this.#agentRevisionSummaryFromRow(row));
    const nextCursor = hasMore ? (revisions.at(-1)?.revision ?? null) : null;

    return listAgentRevisionsResultSchema.parse({ nextCursor, ok: true, revisions });
  }

  async updateAgent(authorityInput: unknown, input: unknown): Promise<UpdateAgentResult> {
    const authorization = this.#authorize(authorityInput, AGENTS_WRITE_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = updateAgentInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const requestDigest = await digestAgentUpdate(request.data);

    return this.#storage.transactionSync(() => {
      const existingUpdate = this.#sql
        .exec<Record<string, SqlStorageValue>>(
          `SELECT
               a.agent_id,
               u.revision AS current_revision,
               u.request_digest,
               a.created_at,
               r.name,
               r.model,
               r.instructions,
               r.execution_limits,
               r.capability_grants
             FROM agent_updates u
             JOIN agents a ON a.agent_id = u.agent_id
             JOIN agent_revisions r
               ON r.agent_id = u.agent_id AND r.revision = u.revision
             WHERE u.client_id = ? AND u.idempotency_key = ?`,
          authorization.authority.clientId,
          request.data.idempotencyKey,
        )
        .toArray()[0];

      if (existingUpdate !== undefined) {
        if (existingUpdate["request_digest"] !== requestDigest) {
          return this.#deniedAgent("idempotency_conflict");
        }

        return updateAgentResultSchema.parse({
          agent: this.#agentFromRow(existingUpdate),
          ok: true,
          updated: false,
        });
      }

      const currentRow = this.#currentAgentRow(request.data.id);

      if (currentRow === undefined) {
        return this.#deniedAgent("agent_not_found");
      }

      const currentAgent = this.#agentFromRow(currentRow);

      if (currentAgent.revision !== request.data.expectedRevision) {
        return this.#deniedAgent("revision_conflict");
      }

      if (
        currentAgent.name === request.data.name &&
        currentAgent.model === request.data.model &&
        currentAgent.instructions === request.data.instructions &&
        JSON.stringify(currentAgent.executionLimits) ===
          JSON.stringify(request.data.executionLimits)
      ) {
        return this.#deniedAgent("no_changes");
      }

      if (currentAgent.revision >= MAXIMUM_REVISIONS_PER_AGENT) {
        return this.#deniedAgent("agent_revision_limit_exceeded");
      }

      const capabilityGrants = currentRow["capability_grants"];
      const updatedAt = Date.now();
      const revision = currentAgent.revision + 1;

      if (typeof capabilityGrants !== "string") {
        throw new Error("Invalid Agent capability grants.");
      }

      this.#sql.exec(
        `INSERT INTO agent_revisions
             (agent_id, revision, name, model, instructions, execution_limits,
              capability_grants, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        currentAgent.id,
        revision,
        request.data.name,
        request.data.model,
        request.data.instructions,
        JSON.stringify(request.data.executionLimits),
        capabilityGrants,
        updatedAt,
      );
      this.#sql.exec(
        "UPDATE agents SET current_revision = ? WHERE agent_id = ?",
        revision,
        currentAgent.id,
      );
      this.#sql.exec(
        `INSERT INTO agent_updates
             (client_id, idempotency_key, request_digest, agent_id, revision)
           VALUES (?, ?, ?, ?, ?)`,
        authorization.authority.clientId,
        request.data.idempotencyKey,
        requestDigest,
        currentAgent.id,
        revision,
      );
      this.#sql.exec(
        `INSERT INTO audit_events (occurred_at, client_id, action, subject_id)
           VALUES (?, ?, 'agent.updated', ?)`,
        updatedAt,
        authorization.authority.clientId,
        currentAgent.id,
      );

      return updateAgentResultSchema.parse({
        agent: {
          capabilityGrants: currentAgent.capabilityGrants,
          createdAt: currentAgent.createdAt,
          executionLimits: request.data.executionLimits,
          id: currentAgent.id,
          instructions: request.data.instructions,
          model: request.data.model,
          name: request.data.name,
          revision,
        },
        ok: true,
        updated: true,
      });
    });
  }

  listAgents(authorityInput: unknown, input: unknown): ListAgentsResult {
    const authorization = this.#authorize(authorityInput, OWNER_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedAgent(authorization.code);
    }

    const request = listAgentsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedAgent("invalid_request");
    }

    const bindings: Array<number | string> = [];
    let cursorClause = "";

    if (request.data.cursor !== undefined) {
      cursorClause = "WHERE a.agent_id > ?";
      bindings.push(request.data.cursor);
    }

    bindings.push(request.data.limit + 1);
    const rows = this.#sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT
             a.agent_id,
             a.current_revision,
             a.created_at,
             r.name,
             r.model,
             r.instructions,
             r.execution_limits,
             r.capability_grants
           FROM agents a
           JOIN agent_revisions r
             ON r.agent_id = a.agent_id AND r.revision = a.current_revision
           ${cursorClause}
           ORDER BY a.agent_id
         LIMIT ?`,
        ...bindings,
      )
      .toArray();
    const hasMore = rows.length > request.data.limit;
    const agents = rows.slice(0, request.data.limit).map((row) => this.#agentSummaryFromRow(row));
    const nextCursor = hasMore ? (agents.at(-1)?.id ?? null) : null;

    return listAgentsResultSchema.parse({ agents, nextCursor, ok: true });
  }

  listConnections(authorityInput: unknown, input: unknown): ListConnectionsResult {
    const authorization = this.#authorize(authorityInput, CONNECTIONS_READ_SCOPE);

    if (!authorization.ok) {
      return this.#deniedConnectionRead(authorization.code);
    }

    const request = listConnectionsInputSchema.safeParse(input);

    if (!request.success) {
      return this.#deniedConnectionRead("invalid_request");
    }

    const bindings: Array<number | string> = [];
    let cursorClause = "";

    if (request.data.cursor !== undefined) {
      cursorClause = "WHERE connection_id > ?";
      bindings.push(request.data.cursor);
    }

    bindings.push(request.data.limit + 1);
    const rows = this.#sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT connection_id, auth_config_id, status, created_at
         FROM connections
         ${cursorClause}
         ORDER BY connection_id
         LIMIT ?`,
        ...bindings,
      )
      .toArray();
    const hasMore = rows.length > request.data.limit;
    const connections = rows
      .slice(0, request.data.limit)
      .map((row) => this.#connectionSummaryFromRow(row));
    const nextCursor = hasMore ? (connections.at(-1)?.connectionId ?? null) : null;

    return listConnectionsResultSchema.parse({ connections, nextCursor, ok: true });
  }

  #agentFromRow(row: Record<string, SqlStorageValue>): Agent {
    const createdAt = row["created_at"];
    const executionLimits = row["execution_limits"];
    const capabilityGrants = row["capability_grants"];

    if (
      typeof createdAt !== "number" ||
      typeof executionLimits !== "string" ||
      typeof capabilityGrants !== "string"
    ) {
      throw new Error("Invalid agent storage.");
    }

    return agentSchema.parse({
      capabilityGrants: JSON.parse(capabilityGrants),
      createdAt: new Date(createdAt).toISOString(),
      executionLimits: JSON.parse(executionLimits),
      id: row["agent_id"],
      instructions: row["instructions"] ?? "",
      model: row["model"],
      name: row["name"],
      revision: row["current_revision"],
    });
  }

  #agentRevisionFromRow(row: Record<string, SqlStorageValue>): AgentRevision {
    const revisedAt = row["revised_at"];

    if (typeof revisedAt !== "number") {
      throw new Error("Invalid Agent revision storage.");
    }

    return agentRevisionSchema.parse({
      ...this.#agentFromRow(row),
      revisedAt: new Date(revisedAt).toISOString(),
    });
  }

  #agentRevisionRow(
    agentId: string,
    revision: number,
  ): Record<string, SqlStorageValue> | undefined {
    return this.#sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT
             a.agent_id,
             r.revision AS current_revision,
             a.created_at,
             r.created_at AS revised_at,
             r.name,
             r.model,
             r.instructions,
             r.execution_limits,
             r.capability_grants
           FROM agents a
           JOIN agent_revisions r ON r.agent_id = a.agent_id
           WHERE a.agent_id = ? AND r.revision = ?`,
        agentId,
        revision,
      )
      .toArray()[0];
  }

  #agentExists(agentId: string): boolean {
    return (
      this.#sql
        .exec<Record<string, SqlStorageValue>>(
          "SELECT agent_id FROM agents WHERE agent_id = ?",
          agentId,
        )
        .toArray()[0] !== undefined
    );
  }

  #currentAgentRow(agentId: string): Record<string, SqlStorageValue> | undefined {
    return this.#sql
      .exec<Record<string, SqlStorageValue>>(
        `SELECT
             a.agent_id,
             a.current_revision,
             a.created_at,
             r.name,
             r.model,
             r.instructions,
             r.execution_limits,
             r.capability_grants
           FROM agents a
           JOIN agent_revisions r
             ON r.agent_id = a.agent_id AND r.revision = a.current_revision
           WHERE a.agent_id = ?`,
        agentId,
      )
      .toArray()[0];
  }

  #agentSummaryFromRow(row: Record<string, SqlStorageValue>): AgentSummary {
    const agent = this.#agentFromRow(row);

    return agentSummarySchema.parse({
      capabilityGrants: agent.capabilityGrants,
      createdAt: agent.createdAt,
      executionLimits: agent.executionLimits,
      id: agent.id,
      model: agent.model,
      name: agent.name,
      revision: agent.revision,
    });
  }

  #agentRevisionSummaryFromRow(row: Record<string, SqlStorageValue>): AgentRevisionSummary {
    const createdAt = row["created_at"];
    const revisedAt = row["revised_at"];
    const executionLimits = row["execution_limits"];
    const capabilityGrants = row["capability_grants"];

    if (
      typeof createdAt !== "number" ||
      typeof revisedAt !== "number" ||
      typeof executionLimits !== "string" ||
      typeof capabilityGrants !== "string"
    ) {
      throw new Error("Invalid Agent revision summary storage.");
    }

    return agentRevisionSummarySchema.parse({
      capabilityGrants: JSON.parse(capabilityGrants),
      createdAt: new Date(createdAt).toISOString(),
      executionLimits: JSON.parse(executionLimits),
      id: row["agent_id"],
      model: row["model"],
      name: row["name"],
      revisedAt: new Date(revisedAt).toISOString(),
      revision: row["current_revision"],
    });
  }

  #connectionLinkFromRow(row: Record<string, SqlStorageValue>) {
    const connectionId = row["connection_id"];
    const expiresAt = row["expires_at"];
    const url = row["redirect_url"];

    if (
      typeof connectionId !== "string" ||
      typeof expiresAt !== "number" ||
      typeof url !== "string"
    ) {
      throw new Error("Invalid connection-link storage.");
    }

    return {
      connectionId,
      expiresAt: new Date(expiresAt).toISOString(),
      url,
    };
  }

  #connectionSummaryFromRow(row: Record<string, SqlStorageValue>): ConnectionSummary {
    const createdAt = row["created_at"];

    if (typeof createdAt !== "number") {
      throw new Error("Invalid connection summary storage.");
    }

    return connectionSummarySchema.parse({
      authConfigId: row["auth_config_id"],
      connectionId: row["connection_id"],
      createdAt: new Date(createdAt).toISOString(),
      status: row["status"],
    });
  }

  #countRows(table: "connection_link_requests" | "connections"): number {
    const count = this.#sql
      .exec<Record<string, SqlStorageValue>>(`SELECT COUNT(*) AS count FROM ${table}`)
      .one()["count"];

    if (typeof count !== "number") {
      throw new Error("Invalid control-plane count.");
    }

    return count;
  }

  #expireConnectionLinkRequests(currentTime: number): void {
    this.#sql.exec(
      `UPDATE connection_link_requests
       SET status = 'expired', redirect_url = NULL
       WHERE status = 'completed' AND expires_at <= ?`,
      currentTime,
    );
    this.#sql.exec(
      `UPDATE connection_link_requests
       SET status = 'abandoned'
       WHERE status = 'pending' AND recover_after <= ?`,
      currentTime,
    );
  }

  async #scheduleConnectionLinkCleanup(cleanupAt: number): Promise<void> {
    const scheduledAlarm = await this.#storage.getAlarm();

    if (scheduledAlarm === null || cleanupAt < scheduledAlarm) {
      await this.#storage.setAlarm(cleanupAt);
    }
  }

  #authorize(authorityInput: unknown, requiredScope: OwnerScope): AuthorityResult {
    const result = ownerAuthoritySchema.safeParse(authorityInput);

    if (!result.success || !this.#objectName) {
      return { code: "invalid_authority", ok: false };
    }

    const authority = result.data;

    if (authority.ownerKey !== this.#objectName) {
      return { code: "owner_mismatch", ok: false };
    }

    this.#sql.exec(
      `INSERT OR IGNORE INTO control_plane (singleton, owner_key, schema_version)
       VALUES (1, ?, ?)`,
      authority.ownerKey,
      CONTROL_PLANE_SCHEMA_VERSION,
    );

    const row = this.#sql
      .exec<Record<string, SqlStorageValue>>(
        "SELECT owner_key, schema_version FROM control_plane WHERE singleton = 1",
      )
      .one();

    if (row["owner_key"] !== authority.ownerKey) {
      return { code: "owner_mismatch", ok: false };
    }

    if (row["schema_version"] !== CONTROL_PLANE_SCHEMA_VERSION) {
      return { code: "incompatible_schema", ok: false };
    }

    if (!authority.scopes.includes(requiredScope)) {
      return { code: "insufficient_scope", ok: false };
    }

    return { authority, ok: true };
  }

  #deniedStatus(code: AuthorityErrorCode): ControlPlaneStatusResult {
    return controlPlaneStatusResultSchema.parse({
      error: {
        code,
        message: "Control-plane request denied.",
      },
      ok: false,
    });
  }

  #deniedAgent(code: AgentRequestErrorCode): AgentRequestFailure {
    return {
      error: {
        code,
        message: "Agent request denied.",
      },
      ok: false,
    };
  }

  #deniedConnectionLink(code: ConnectionLinkRequestErrorCode): ConnectionLinkRequestFailure {
    return {
      error: {
        code,
        message: "Connection link request denied.",
      },
      ok: false,
    };
  }

  #deniedConnectionRead(code: ConnectionReadRequestErrorCode): ConnectionReadRequestFailure {
    return {
      error: {
        code,
        message: "Connection request denied.",
      },
      ok: false,
    };
  }
}
