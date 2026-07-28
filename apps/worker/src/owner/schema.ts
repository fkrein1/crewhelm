import type {
  Agent,
  AgentExecutionLimits,
  ComposioToolCapabilityGrant,
  ConnectionAuthorizationOutcome,
  RunBudgetReservation,
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
    status: text("status", { enum: ["active", "disabled"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at").notNull(),
    disabledAt: integer("disabled_at"),
  },
  (table) => [
    check("agents_current_revision_positive", sql`${table.currentRevision} > 0`),
    check("agents_status", sql`${table.status} IN ('active', 'disabled')`),
    check("agents_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "agents_state",
      sql`(
        (${table.status} = 'active' AND ${table.disabledAt} IS NULL)
        OR (${table.status} = 'disabled'
          AND ${table.disabledAt} IS NOT NULL
          AND ${table.disabledAt} >= ${table.createdAt})
      )`,
    ),
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
    check("agent_revisions_capability_grants_json", sql`json_valid(${table.capabilityGrants})`),
    check("agent_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const connections = sqliteTable(
  "connections",
  {
    connectionId: text("connection_id").primaryKey(),
    provider: text("provider", { enum: ["composio"] }).notNull(),
    providerConnectionId: text("provider_connection_id").notNull().unique(),
    authConfigId: text("auth_config_id").notNull(),
    status: text("status", {
      enum: ["initiated", "active", "revoked", "unavailable"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    check("connections_provider_composio", sql`${table.provider} = 'composio'`),
    check(
      "connections_status",
      sql`${table.status} IN ('initiated', 'active', 'revoked', 'unavailable')`,
    ),
    check("connections_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "connections_revocation_state",
      sql`(
        (${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
          AND ${table.revokedAt} >= ${table.createdAt})
        OR (${table.status} != 'revoked' AND ${table.revokedAt} IS NULL)
      )`,
    ),
  ],
);

export const capabilityGrants = sqliteTable(
  "capability_grants",
  {
    grantId: text("grant_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    connectionId: text("connection_id").notNull(),
    grant: text("grant", { mode: "json" }).$type<ComposioToolCapabilityGrant>().notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    index("capability_grants_agent_revision").on(table.agentId, table.agentRevision),
    index("capability_grants_connection").on(table.connectionId),
    check("capability_grants_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check("capability_grants_grant_json", sql`json_valid(${table.grant})`),
    check("capability_grants_status", sql`${table.status} IN ('active', 'revoked')`),
    check("capability_grants_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "capability_grants_state",
      sql`(
        (${table.status} = 'active' AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'revoked'
          AND ${table.revokedAt} IS NOT NULL
          AND ${table.revokedAt} >= ${table.createdAt})
      )`,
    ),
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

export const runAdmissions = sqliteTable(
  "run_admissions",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    budgetReservation: text("budget_reservation", { mode: "json" })
      .$type<RunBudgetReservation>()
      .notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    status: text("status", { enum: ["issued", "redeemed", "expired"] }).notNull(),
    expiresAt: integer("expires_at").notNull(),
    cleanupAt: integer("cleanup_at").notNull(),
    createdAt: integer("created_at").notNull(),
    redeemedAt: integer("redeemed_at"),
    cancellationRequestedAt: integer("cancellation_requested_at"),
    cancelledAt: integer("cancelled_at"),
    modelCallConsumedAt: integer("model_call_consumed_at"),
    modelCallsConsumed: integer("model_calls_consumed").notNull().default(0),
    toolCallsConsumed: integer("tool_calls_consumed").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("run_admissions_run_id").on(table.runId),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    index("run_admissions_cleanup").on(table.cleanupAt),
    index("run_admissions_expiry")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'issued'`),
    check("run_admissions_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("run_admissions_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check("run_admissions_prompt_digest_length", sql`length(${table.promptDigest}) = 64`),
    check("run_admissions_nonce_digest_length", sql`length(${table.nonceDigest}) = 43`),
    check("run_admissions_status", sql`${table.status} IN ('issued', 'redeemed', 'expired')`),
    check("run_admissions_expires_at_positive", sql`${table.expiresAt} > 0`),
    check("run_admissions_cleanup_after_expiry", sql`${table.cleanupAt} > ${table.expiresAt}`),
    check("run_admissions_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "run_admissions_cancellation_requested_at_positive",
      sql`${table.cancellationRequestedAt} IS NULL OR ${table.cancellationRequestedAt} > 0`,
    ),
    check(
      "run_admissions_cancelled_at_positive",
      sql`${table.cancelledAt} IS NULL OR ${table.cancelledAt} > 0`,
    ),
    check(
      "run_admissions_cancellation_state",
      sql`(
        (${table.cancellationRequestedAt} IS NULL AND ${table.cancelledAt} IS NULL)
        OR (${table.cancellationRequestedAt} IS NOT NULL
          AND ${table.cancellationRequestedAt} >= ${table.createdAt}
          AND (${table.cancelledAt} IS NULL
            OR ${table.cancelledAt} >= ${table.cancellationRequestedAt}))
      )`,
    ),
    check(
      "run_admissions_model_call_consumed_at_positive",
      sql`${table.modelCallConsumedAt} IS NULL OR ${table.modelCallConsumedAt} > 0`,
    ),
    check("run_admissions_model_calls_consumed", sql`${table.modelCallsConsumed} >= 0`),
    check("run_admissions_tool_calls_consumed", sql`${table.toolCallsConsumed} >= 0`),
    check(
      "run_admissions_state",
      sql`(
        (${table.status} = 'issued'
          AND ${table.redeemedAt} IS NULL
          AND ${table.modelCallConsumedAt} IS NULL
          AND ${table.modelCallsConsumed} = 0)
        OR (${table.status} = 'redeemed'
          AND ${table.redeemedAt} IS NOT NULL
          AND ${table.modelCallsConsumed} <= json_extract(
            ${table.budgetReservation},
            '$.maxModelCalls'
          )
          AND ((${table.modelCallsConsumed} = 0 AND ${table.modelCallConsumedAt} IS NULL)
            OR (${table.modelCallsConsumed} > 0
              AND ${table.modelCallConsumedAt} >= ${table.redeemedAt})))
        OR (${table.status} = 'expired'
          AND ${table.redeemedAt} IS NULL
          AND ${table.modelCallConsumedAt} IS NULL
          AND ${table.modelCallsConsumed} = 0)
      )`,
    ),
  ],
);

export const toolApprovals = sqliteTable(
  "tool_approvals",
  {
    executionId: text("execution_id").primaryKey(),
    runId: text("run_id").notNull(),
    toolCallId: text("tool_call_id").notNull().unique(),
    grantId: text("grant_id"),
    actionDigest: text("action_digest").notNull(),
    clientId: text("client_id").notNull(),
    decision: text("decision", { enum: ["approved", "rejected"] }),
    expiresAt: integer("expires_at").notNull(),
    requestedAt: integer("requested_at").notNull(),
    decidedAt: integer("decided_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runAdmissions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.grantId],
      foreignColumns: [capabilityGrants.grantId],
    }).onDelete("restrict"),
    index("tool_approvals_run").on(table.runId, table.requestedAt),
    check("tool_approvals_action_digest_length", sql`length(${table.actionDigest}) = 64`),
    check(
      "tool_approvals_decision",
      sql`${table.decision} IS NULL OR ${table.decision} IN ('approved', 'rejected')`,
    ),
    check("tool_approvals_requested_at_positive", sql`${table.requestedAt} > 0`),
    check(
      "tool_approvals_decision_state",
      sql`((${table.decision} IS NULL AND ${table.decidedAt} IS NULL)
        OR (${table.decision} IS NOT NULL AND ${table.decidedAt} >= ${table.requestedAt}))`,
    ),
    check(
      "tool_approvals_expiry_after_request",
      sql`${table.expiresAt} > coalesce(${table.decidedAt}, ${table.requestedAt})`,
    ),
  ],
);

export const toolExecutions = sqliteTable(
  "tool_executions",
  {
    toolCallId: text("tool_call_id").primaryKey(),
    runId: text("run_id").notNull(),
    grantId: text("grant_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    effectDigest: text("effect_digest").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    status: text("status", {
      enum: ["reserved", "completed", "failed", "unknown"],
    }).notNull(),
    costMicrousd: integer("cost_microusd").notNull(),
    outputBytes: integer("output_bytes"),
    expiresAt: integer("expires_at").notNull(),
    startedAt: integer("started_at").notNull(),
    dispatchedAt: integer("dispatched_at"),
    completedAt: integer("completed_at"),
    reconciliation: text("reconciliation", { enum: ["applied", "not_applied"] }),
    reconciledAt: integer("reconciled_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runAdmissions.runId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.grantId],
      foreignColumns: [capabilityGrants.grantId],
    }).onDelete("restrict"),
    index("tool_executions_run").on(table.runId, table.startedAt),
    index("tool_executions_grant_status").on(table.grantId, table.status),
    index("tool_executions_effect_status").on(table.effectDigest, table.status),
    check("tool_executions_action_digest_length", sql`length(${table.actionDigest}) = 64`),
    check("tool_executions_effect_digest_length", sql`length(${table.effectDigest}) = 64`),
    check("tool_executions_nonce_digest_length", sql`length(${table.nonceDigest}) = 43`),
    check(
      "tool_executions_status",
      sql`${table.status} IN ('reserved', 'completed', 'failed', 'unknown')`,
    ),
    check("tool_executions_cost_nonnegative", sql`${table.costMicrousd} >= 0`),
    check(
      "tool_executions_output_nonnegative",
      sql`${table.outputBytes} IS NULL OR ${table.outputBytes} >= 0`,
    ),
    check("tool_executions_started_at_positive", sql`${table.startedAt} > 0`),
    check(
      "tool_executions_dispatched_at_positive",
      sql`${table.dispatchedAt} IS NULL OR ${table.dispatchedAt} > 0`,
    ),
    check(
      "tool_executions_dispatch_after_start",
      sql`${table.dispatchedAt} IS NULL OR ${table.dispatchedAt} >= ${table.startedAt}`,
    ),
    check("tool_executions_expiry_after_start", sql`${table.expiresAt} > ${table.startedAt}`),
    check(
      "tool_executions_completion_after_dispatch",
      sql`${table.completedAt} IS NULL
        OR ${table.dispatchedAt} IS NULL
        OR ${table.completedAt} >= ${table.dispatchedAt}`,
    ),
    check(
      "tool_executions_reconciliation",
      sql`${table.reconciliation} IS NULL
        OR ${table.reconciliation} IN ('applied', 'not_applied')`,
    ),
    check(
      "tool_executions_reconciliation_state",
      sql`(
        (${table.reconciliation} IS NULL AND ${table.reconciledAt} IS NULL)
        OR (${table.reconciliation} = 'applied'
          AND ${table.status} = 'completed'
          AND ${table.reconciledAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reconciledAt} >= ${table.completedAt})
        OR (${table.reconciliation} = 'not_applied'
          AND ${table.status} = 'failed'
          AND ${table.reconciledAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.reconciledAt} >= ${table.completedAt})
      )`,
    ),
    check(
      "tool_executions_state",
      sql`(
        (${table.status} = 'reserved'
          AND ${table.outputBytes} IS NULL
          AND ${table.completedAt} IS NULL)
        OR (${table.status} = 'completed'
          AND ${table.dispatchedAt} IS NOT NULL
          AND ${table.outputBytes} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.startedAt})
        OR (${table.status} IN ('failed', 'unknown')
          AND ${table.outputBytes} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.startedAt})
      )`,
    ),
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

export const integrationEnablementRequests = sqliteTable(
  "integration_enablement_requests",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    integrationSlug: text("integration_slug").notNull(),
    reservationId: text("reservation_id").notNull().unique(),
    status: text("status", {
      enum: ["pending", "completed", "abandoned"],
    }).notNull(),
    recoverAfter: integer("recover_after").notNull(),
    authConfigId: text("auth_config_id"),
    authScheme: text("auth_scheme"),
    createdAt: integer("created_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("integration_enablement_requests_pending_slug")
      .on(table.integrationSlug)
      .where(sql`${table.status} = 'pending'`),
    check(
      "integration_enablement_requests_request_digest_length",
      sql`length(${table.requestDigest}) = 43`,
    ),
    check(
      "integration_enablement_requests_status",
      sql`${table.status} IN ('pending', 'completed', 'abandoned')`,
    ),
    check("integration_enablement_requests_recover_after_positive", sql`${table.recoverAfter} > 0`),
    check("integration_enablement_requests_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "integration_enablement_requests_state",
      sql`(
        (${table.status} = 'completed'
          AND ${table.authConfigId} IS NOT NULL
          AND ${table.authScheme} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.createdAt})
        OR
        (${table.status} IN ('pending', 'abandoned')
          AND ${table.authConfigId} IS NULL
          AND ${table.authScheme} IS NULL
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
  capabilityGrants,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  controlPlane,
  controlPlaneMigrations,
  integrationEnablementRequests,
  runAdmissions,
  toolApprovals,
  toolExecutions,
};

export type ControlPlaneDatabaseSchema = typeof controlPlaneSchema;
export type StoredConnectionAuthorizationOutcome = Exclude<
  ConnectionAuthorizationOutcome,
  "untracked"
>;
