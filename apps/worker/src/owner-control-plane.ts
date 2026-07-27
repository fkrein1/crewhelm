import {
  AGENTS_READ_SCOPE,
  AGENTS_WRITE_SCOPE,
  agentRevisionSchema,
  agentRevisionSummarySchema,
  agentSchema,
  agentSummarySchema,
  controlPlaneStatusResultSchema,
  createAgentInputSchema,
  createAgentResultSchema,
  getAgentInputSchema,
  getAgentRevisionInputSchema,
  getAgentRevisionResultSchema,
  getAgentResultSchema,
  listAgentRevisionsInputSchema,
  listAgentRevisionsResultSchema,
  listAgentsInputSchema,
  listAgentsResultSchema,
  MAXIMUM_AGENTS_PER_OWNER,
  MAXIMUM_REVISIONS_PER_AGENT,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  ownerAuthoritySchema,
  updateAgentInputSchema,
  updateAgentResultSchema,
  type Agent,
  type AgentRevision,
  type AgentRevisionSummary,
  type AgentSummary,
  type ControlPlaneStatusResult,
  type CreateAgentInput,
  type CreateAgentResult,
  type GetAgentRevisionResult,
  type GetAgentResult,
  type ListAgentRevisionsResult,
  type ListAgentsResult,
  type OwnerAuthority,
  type OwnerScope,
  type UpdateAgentInput,
  type UpdateAgentResult,
} from "@crewhelm/contracts";
import { DurableObject } from "cloudflare:workers";

const CONTROL_PLANE_SCHEMA_VERSION = 2;
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
      const isVersionOneTable =
        typeof controlPlaneDefinition === "string" &&
        controlPlaneDefinition.includes("schema_version = 1");

      if (
        (controlPlane === undefined && isVersionOneTable) ||
        controlPlane?.["schema_version"] === CONTROL_PLANE_SCHEMA_VERSION - 1
      ) {
        this.#sql.exec("ALTER TABLE control_plane RENAME TO control_plane_v1");
        this.#sql.exec(`
          CREATE TABLE control_plane (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            owner_key TEXT NOT NULL UNIQUE,
            schema_version INTEGER NOT NULL CHECK (schema_version = 2)
          )
        `);
        this.#sql.exec(`
          INSERT INTO control_plane (singleton, owner_key, schema_version)
          SELECT singleton, owner_key, 2 FROM control_plane_v1
        `);
        this.#sql.exec("DROP TABLE control_plane_v1");
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
}
