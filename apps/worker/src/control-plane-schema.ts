import type {
  Agent,
  AgentExecutionLimits,
  ConnectionAuthorizationOutcome,
} from "@crewhelm/contracts";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm/sql";

export const controlPlane = sqliteTable(
  "control_plane",
  {
    singleton: integer("singleton").primaryKey(),
    ownerKey: text("owner_key").notNull().unique(),
  },
  (table) => [check("control_plane_singleton", sql`${table.singleton} = 1`)],
);

export const agents = sqliteTable(
  "agents",
  {
    agentId: text("agent_id").primaryKey(),
    currentRevision: integer("current_revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check("agents_current_revision_positive", sql`${table.currentRevision} > 0`),
    check("agents_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentRevisions = sqliteTable(
  "agent_revisions",
  {
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    model: text("model").notNull(),
    instructions: text("instructions").notNull(),
    executionLimits: text("execution_limits", { mode: "json" })
      .$type<AgentExecutionLimits>()
      .notNull(),
    capabilityGrants: text("capability_grants", { mode: "json" })
      .$type<Agent["capabilityGrants"]>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.revision] }),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.agentId],
    }).onDelete("restrict"),
    check("agent_revisions_revision_positive", sql`${table.revision} > 0`),
    check("agent_revisions_capability_grants_empty", sql`${table.capabilityGrants} = '[]'`),
    check("agent_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentCreations = sqliteTable(
  "agent_creations",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("agent_creations_agent_revision").on(table.agentId, table.revision),
    foreignKey({
      columns: [table.agentId, table.revision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    check("agent_creations_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("agent_creations_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const agentUpdates = sqliteTable(
  "agent_updates",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("agent_updates_agent_revision").on(table.agentId, table.revision),
    foreignKey({
      columns: [table.agentId, table.revision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    check("agent_updates_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("agent_updates_revision_after_initial", sql`${table.revision} > 1`),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    eventId: integer("event_id").primaryKey({ autoIncrement: true }),
    occurredAt: integer("occurred_at").notNull(),
    clientId: text("client_id").notNull(),
    action: text("action").notNull(),
    subjectId: text("subject_id").notNull(),
  },
  (table) => [check("audit_events_occurred_at_positive", sql`${table.occurredAt} > 0`)],
);

export const connections = sqliteTable(
  "connections",
  {
    connectionId: text("connection_id").primaryKey(),
    provider: text("provider", { enum: ["composio"] }).notNull(),
    providerConnectionId: text("provider_connection_id").notNull().unique(),
    authConfigId: text("auth_config_id").notNull(),
    status: text("status", { enum: ["initiated"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check("connections_provider_composio", sql`${table.provider} = 'composio'`),
    check("connections_status_initiated", sql`${table.status} = 'initiated'`),
    check("connections_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const connectionLinkRequests = sqliteTable(
  "connection_link_requests",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    authConfigId: text("auth_config_id").notNull(),
    reservationId: text("reservation_id").notNull().unique(),
    status: text("status", {
      enum: ["pending", "completed", "expired", "abandoned"],
    }).notNull(),
    recoverAfter: integer("recover_after").notNull(),
    connectionId: text("connection_id"),
    redirectUrl: text("redirect_url"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    index("connection_link_requests_pending_auth_config")
      .on(table.authConfigId, table.recoverAfter)
      .where(sql`${table.status} = 'pending'`),
    check(
      "connection_link_requests_request_digest_length",
      sql`length(${table.requestDigest}) = 43`,
    ),
    check("connection_link_requests_recover_after_positive", sql`${table.recoverAfter} > 0`),
    check("connection_link_requests_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "connection_link_requests_state",
      sql`(
        (${table.status} = 'completed'
          AND ${table.connectionId} IS NOT NULL
          AND ${table.redirectUrl} IS NOT NULL
          AND ${table.expiresAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.status} = 'expired'
          AND ${table.connectionId} IS NOT NULL
          AND ${table.redirectUrl} IS NULL
          AND ${table.expiresAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.status} IN ('pending', 'abandoned')
          AND ${table.connectionId} IS NULL
          AND ${table.redirectUrl} IS NULL
          AND ${table.expiresAt} IS NULL
          AND ${table.completedAt} IS NULL)
      )`,
    ),
  ],
);

export const connectionAuthorizationReturns = sqliteTable(
  "connection_authorization_returns",
  {
    reservationId: text("reservation_id").primaryKey(),
    tokenDigest: text("token_digest").notNull().unique(),
    status: text("status", {
      enum: ["pending", "returned", "failed", "expired"],
    }).notNull(),
    connectionId: text("connection_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.reservationId],
      foreignColumns: [connectionLinkRequests.reservationId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    index("connection_authorization_returns_connection").on(
      table.connectionId,
      sql`${table.createdAt} DESC`,
    ),
    check(
      "connection_authorization_returns_token_digest_length",
      sql`length(${table.tokenDigest}) = 43`,
    ),
    check(
      "connection_authorization_returns_status",
      sql`${table.status} IN ('pending', 'returned', 'failed', 'expired')`,
    ),
    check("connection_authorization_returns_expires_at_positive", sql`${table.expiresAt} > 0`),
    check("connection_authorization_returns_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "connection_authorization_returns_state",
      sql`(
        (${table.status} = 'pending' AND ${table.completedAt} IS NULL)
        OR
        (${table.status} IN ('returned', 'failed')
          AND ${table.connectionId} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.status} = 'expired' AND ${table.completedAt} IS NULL)
      )`,
    ),
  ],
);

export const controlPlaneMigrations = sqliteTable(
  "control_plane_migrations",
  {
    version: integer("version").primaryKey(),
    name: text("name").notNull().unique(),
    checksum: text("checksum").notNull(),
    appliedAt: integer("applied_at").notNull(),
  },
  (table) => [
    check("control_plane_migrations_version_positive", sql`${table.version} > 0`),
    check("control_plane_migrations_checksum_length", sql`length(${table.checksum}) = 64`),
    check("control_plane_migrations_applied_at_positive", sql`${table.appliedAt} > 0`),
  ],
);

export const controlPlaneSchema = {
  agentCreations,
  agentRevisions,
  agentUpdates,
  agents,
  auditEvents,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  controlPlane,
  controlPlaneMigrations,
};

export type ControlPlaneDatabaseSchema = typeof controlPlaneSchema;
export type StoredConnectionAuthorizationOutcome = Exclude<
  ConnectionAuthorizationOutcome,
  "untracked"
>;
