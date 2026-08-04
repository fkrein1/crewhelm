import type {
  Agent,
  AgentBlueprintPackage,
  AgentBlueprintProvenance,
  AgentCapabilityConfigurations,
  AgentInboxDeferredReason,
  AgentExecutionLimits,
  AgentScheduleConfiguration,
  AgentEventTriggerDefinition,
  AgentWorkflowAggregateBudget,
  AdmittedBriefContext,
  AdmittedOutputContract,
  ExternalToolCapabilityGrant,
  ConnectionAuthorizationOutcome,
  FleetConfigurationData,
  IntegrationToolParameterValue,
  RunBudgetReservation,
  RunSession,
  RemoteMcpCatalog,
  RecipeInstallationPlan,
  RecipeInstallationReceipt,
  RegistrySkillPackage,
  SkillProvenance,
  SkillWarning,
  WorkflowDeliverable,
  JsonValue,
  McpAuthoringDraftKind,
  ProviderAuthSetupPlan,
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

export const fleetConfigurations = sqliteTable(
  "fleet_configurations",
  {
    singleton: integer("singleton").primaryKey(),
    currentRevision: integer("current_revision").notNull(),
  },
  (table) => [
    check("fleet_configurations_singleton", sql`${table.singleton} = 1`),
    check("fleet_configurations_current_revision_positive", sql`${table.currentRevision} > 0`),
  ],
);

export const fleetConfigurationRevisions = sqliteTable(
  "fleet_configuration_revisions",
  {
    revision: integer("revision").primaryKey(),
    configuration: text("configuration", { mode: "json" })
      .$type<FleetConfigurationData>()
      .notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check("fleet_configuration_revisions_revision_positive", sql`${table.revision} > 0`),
    check(
      "fleet_configuration_revisions_configuration_json",
      sql`json_valid(${table.configuration})`,
    ),
    check("fleet_configuration_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const fleetConfigurationUpdates = sqliteTable(
  "fleet_configuration_updates",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("fleet_configuration_updates_revision").on(table.revision),
    foreignKey({
      columns: [table.revision],
      foreignColumns: [fleetConfigurationRevisions.revision],
    }).onDelete("restrict"),
    check(
      "fleet_configuration_updates_request_digest_length",
      sql`length(${table.requestDigest}) = 43`,
    ),
    check("fleet_configuration_updates_revision_positive", sql`${table.revision} > 0`),
  ],
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
    capabilities: text("capabilities", { mode: "json" })
      .$type<AgentCapabilityConfigurations>()
      .notNull(),
    instructions: text("instructions").notNull(),
    executionLimits: text("execution_limits", { mode: "json" })
      .$type<AgentExecutionLimits>()
      .notNull(),
    capabilityGrants: text("capability_grants", { mode: "json" })
      .$type<Agent["capabilityGrants"]>()
      .notNull(),
    blueprintProvenance: text("blueprint_provenance", {
      mode: "json",
    }).$type<AgentBlueprintProvenance | null>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.revision] }),
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.agentId],
    }).onDelete("restrict"),
    check("agent_revisions_revision_positive", sql`${table.revision} > 0`),
    check("agent_revisions_capabilities_json", sql`json_valid(${table.capabilities})`),
    check("agent_revisions_capability_grants_json", sql`json_valid(${table.capabilityGrants})`),
    check(
      "agent_revisions_blueprint_provenance_json",
      sql`${table.blueprintProvenance} IS NULL OR json_valid(${table.blueprintProvenance})`,
    ),
    check("agent_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentBlueprints = sqliteTable(
  "agent_blueprints",
  {
    blueprintId: text("blueprint_id").primaryKey(),
    currentVersion: integer("current_version").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "retired"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    retiredAt: integer("retired_at"),
  },
  (table) => [
    index("agent_blueprints_status_id").on(table.status, table.blueprintId),
    uniqueIndex("agent_blueprints_active_name")
      .on(table.name)
      .where(sql`${table.status} = 'active'`),
    check("agent_blueprints_current_version_positive", sql`${table.currentVersion} > 0`),
    check("agent_blueprints_status", sql`${table.status} IN ('active', 'retired')`),
    check("agent_blueprints_created_at_positive", sql`${table.createdAt} > 0`),
    check("agent_blueprints_updated_after_creation", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "agent_blueprints_state",
      sql`(
        (${table.status} = 'active' AND ${table.retiredAt} IS NULL)
        OR (${table.status} = 'retired'
          AND ${table.retiredAt} IS NOT NULL
          AND ${table.retiredAt} >= ${table.createdAt})
      )`,
    ),
  ],
);

export const agentBlueprintVersions = sqliteTable(
  "agent_blueprint_versions",
  {
    blueprintId: text("blueprint_id").notNull(),
    version: integer("version").notNull(),
    package: text("package", { mode: "json" }).$type<AgentBlueprintPackage>().notNull(),
    packageDigest: text("package_digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.blueprintId, table.version] }),
    foreignKey({
      columns: [table.blueprintId],
      foreignColumns: [agentBlueprints.blueprintId],
    }).onDelete("restrict"),
    check("agent_blueprint_versions_version_positive", sql`${table.version} > 0`),
    check("agent_blueprint_versions_package_json", sql`json_valid(${table.package})`),
    check(
      "agent_blueprint_versions_package_digest_length",
      sql`length(${table.packageDigest}) = 64`,
    ),
    check("agent_blueprint_versions_size_bytes_positive", sql`${table.sizeBytes} > 0`),
    check("agent_blueprint_versions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentBlueprintMutations = sqliteTable(
  "agent_blueprint_mutations",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    operation: text("operation", { enum: ["publish", "retire"] }).notNull(),
    blueprintId: text("blueprint_id").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.blueprintId, table.version],
      foreignColumns: [agentBlueprintVersions.blueprintId, agentBlueprintVersions.version],
    }).onDelete("restrict"),
    check(
      "agent_blueprint_mutations_request_digest_length",
      sql`length(${table.requestDigest}) = 43`,
    ),
    check("agent_blueprint_mutations_operation", sql`${table.operation} IN ('publish', 'retire')`),
    check("agent_blueprint_mutations_version_positive", sql`${table.version} > 0`),
  ],
);

export const connections = sqliteTable(
  "connections",
  {
    connectionId: text("connection_id").primaryKey(),
    provider: text("provider", { enum: ["composio", "remote_mcp"] }).notNull(),
    providerConnectionId: text("provider_connection_id").unique(),
    authConfigId: text("auth_config_id"),
    accountLabel: text("account_label"),
    status: text("status", {
      enum: ["initiated", "active", "revoked", "unavailable"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    check(
      "connections_provider_details",
      sql`(
        (${table.provider} = 'composio'
          AND ${table.providerConnectionId} IS NOT NULL
          AND ${table.authConfigId} IS NOT NULL)
        OR (${table.provider} = 'remote_mcp'
          AND ${table.providerConnectionId} IS NULL
          AND ${table.authConfigId} IS NULL)
      )`,
    ),
    check(
      "connections_status",
      sql`${table.status} IN ('initiated', 'active', 'revoked', 'unavailable')`,
    ),
    check("connections_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "connections_account_label",
      sql`${table.accountLabel} IS NULL
        OR (length(${table.accountLabel}) BETWEEN 1 AND 160
          AND ${table.accountLabel} NOT GLOB '*[^ -~]*')`,
    ),
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

export const remoteMcpConnections = sqliteTable(
  "remote_mcp_connections",
  {
    connectionId: text("connection_id").primaryKey(),
    endpoint: text("endpoint").notNull(),
    authKind: text("auth_kind", { enum: ["public", "bearer", "oauth"] }).notNull(),
    catalog: text("catalog", { mode: "json" }).$type<RemoteMcpCatalog>().notNull(),
    catalogBytes: integer("catalog_bytes").notNull(),
    snapshotDigest: text("snapshot_digest").notNull(),
    serverName: text("server_name").notNull(),
    serverVersion: text("server_version").notNull(),
    credentialCiphertext: text("credential_ciphertext"),
    credentialNonce: text("credential_nonce"),
    oauthScopes: text("oauth_scopes", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
  },
  (table) => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    check("remote_mcp_connections_endpoint", sql`length(${table.endpoint}) BETWEEN 1 AND 2048`),
    check(
      "remote_mcp_connections_auth",
      sql`(
        (${table.authKind} = 'public'
          AND ${table.credentialCiphertext} IS NULL
          AND ${table.credentialNonce} IS NULL)
        OR (${table.authKind} IN ('bearer', 'oauth')
          AND ((${table.credentialCiphertext} IS NOT NULL
              AND ${table.credentialNonce} IS NOT NULL)
            OR (${table.credentialCiphertext} IS NULL
              AND ${table.credentialNonce} IS NULL)))
      )`,
    ),
    check("remote_mcp_connections_catalog_json", sql`json_valid(${table.catalog})`),
    check(
      "remote_mcp_connections_oauth_scopes_json",
      sql`json_valid(${table.oauthScopes}) AND json_type(${table.oauthScopes}) = 'array'`,
    ),
    check(
      "remote_mcp_connections_oauth_scopes_auth_kind",
      sql`${table.authKind} = 'oauth' OR json_array_length(${table.oauthScopes}) = 0`,
    ),
    check("remote_mcp_connections_catalog_bytes", sql`${table.catalogBytes} BETWEEN 2 AND 524288`),
    check(
      "remote_mcp_connections_snapshot_digest",
      sql`length(${table.snapshotDigest}) = 64
        AND ${table.snapshotDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("remote_mcp_connections_server_name", sql`length(${table.serverName}) BETWEEN 1 AND 160`),
    check(
      "remote_mcp_connections_server_version",
      sql`length(${table.serverVersion}) BETWEEN 1 AND 160`,
    ),
  ],
);

export const remoteMcpOAuthRequests = sqliteTable(
  "remote_mcp_oauth_requests",
  {
    requestId: text("request_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    operation: text("operation", { enum: ["create", "reauthenticate"] }).notNull(),
    connectionId: text("connection_id"),
    endpoint: text("endpoint").notNull(),
    accountLabel: text("account_label").notNull(),
    oauthScopes: text("oauth_scopes", { mode: "json" }).$type<string[]>().notNull(),
    snapshotDigest: text("snapshot_digest"),
    stateDigest: text("state_digest").notNull(),
    authorizationUrl: text("authorization_url"),
    credentialCiphertext: text("credential_ciphertext"),
    credentialNonce: text("credential_nonce"),
    status: text("status", {
      enum: ["reserved", "starting", "pending", "exchanging", "completed", "failed"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    uniqueIndex("remote_mcp_oauth_requests_client_idempotency").on(
      table.clientId,
      table.idempotencyKey,
    ),
    index("remote_mcp_oauth_requests_expiry").on(table.expiresAt),
    check(
      "remote_mcp_oauth_requests_operation",
      sql`${table.operation} IN ('create', 'reauthenticate')`,
    ),
    check(
      "remote_mcp_oauth_requests_digest",
      sql`length(${table.requestDigest}) = 64
        AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'
        AND length(${table.stateDigest}) = 64
        AND ${table.stateDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "remote_mcp_oauth_requests_status",
      sql`${table.status} IN ('reserved', 'starting', 'pending', 'exchanging', 'completed', 'failed')`,
    ),
    check(
      "remote_mcp_oauth_requests_credential_pair",
      sql`(${table.credentialCiphertext} IS NULL) = (${table.credentialNonce} IS NULL)`,
    ),
    check(
      "remote_mcp_oauth_requests_scopes_json",
      sql`json_valid(${table.oauthScopes}) AND json_type(${table.oauthScopes}) = 'array'`,
    ),
    check(
      "remote_mcp_oauth_requests_target",
      sql`(${table.operation} = 'create'
          AND ${table.snapshotDigest} IS NULL
          AND ((${table.status} = 'completed' AND ${table.connectionId} IS NOT NULL)
            OR (${table.status} != 'completed' AND ${table.connectionId} IS NULL)))
        OR (${table.operation} = 'reauthenticate'
          AND ${table.connectionId} IS NOT NULL
          AND ${table.snapshotDigest} IS NOT NULL)`,
    ),
    check(
      "remote_mcp_oauth_requests_times",
      sql`${table.createdAt} > 0
        AND ${table.expiresAt} > ${table.createdAt}
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
    check(
      "remote_mcp_oauth_requests_completion",
      sql`(
        (${table.status} IN ('completed', 'failed')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.authorizationUrl} IS NULL
          AND ${table.credentialCiphertext} IS NULL)
        OR (${table.status} NOT IN ('completed', 'failed') AND ${table.completedAt} IS NULL)
      )`,
    ),
    check(
      "remote_mcp_oauth_requests_pending_material",
      sql`(
        (${table.status} IN ('pending', 'exchanging')
          AND ${table.authorizationUrl} IS NOT NULL
          AND ${table.credentialCiphertext} IS NOT NULL)
        OR (${table.status} NOT IN ('pending', 'exchanging')
          AND ${table.authorizationUrl} IS NULL
          AND ${table.credentialCiphertext} IS NULL)
      )`,
    ),
  ],
);

export const remoteMcpConnectionMutations = sqliteTable(
  "remote_mcp_connection_mutations",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    connectionId: text("connection_id").notNull(),
    operation: text("operation", { enum: ["create", "delete"] }).notNull(),
    requestDigest: text("request_digest").notNull(),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    index("remote_mcp_connection_mutations_connection").on(table.connectionId),
    check(
      "remote_mcp_connection_mutations_operation",
      sql`${table.operation} IN ('create', 'delete')`,
    ),
    check(
      "remote_mcp_connection_mutations_request_digest",
      sql`length(${table.requestDigest}) = 64
        AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("remote_mcp_connection_mutations_occurred_at", sql`${table.occurredAt} > 0`),
  ],
);

export const capabilityGrants = sqliteTable(
  "capability_grants",
  {
    grantId: text("grant_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    connectionId: text("connection_id").notNull(),
    grant: text("grant", { mode: "json" }).$type<ExternalToolCapabilityGrant>().notNull(),
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

export const agentScheduleRevisions = sqliteTable(
  "agent_schedule_revisions",
  {
    scheduleId: text("schedule_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    name: text("name").notNull(),
    configuration: text("configuration", {
      mode: "json",
    }).$type<AgentScheduleConfiguration | null>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.revision] }),
    uniqueIndex("agent_schedule_revisions_schedule_revision").on(
      table.scheduleId,
      table.agentId,
      table.revision,
    ),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    check("agent_schedule_revisions_revision_positive", sql`${table.revision} > 0`),
    check("agent_schedule_revisions_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check("agent_schedule_revisions_name_length", sql`length(${table.name}) BETWEEN 1 AND 80`),
    check(
      "agent_schedule_revisions_configuration_json",
      sql`${table.configuration} IS NULL OR json_valid(${table.configuration})`,
    ),
    check("agent_schedule_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentSchedules = sqliteTable(
  "agent_schedules",
  {
    scheduleId: text("schedule_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    currentRevision: integer("current_revision").notNull(),
    status: text("status", { enum: ["active", "paused", "deleted"] }).notNull(),
    nextRunAt: integer("next_run_at"),
    lastRunId: text("last_run_id"),
    lastDispatchedAt: integer("last_dispatched_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.agentId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.scheduleId, table.agentId, table.currentRevision],
      foreignColumns: [
        agentScheduleRevisions.scheduleId,
        agentScheduleRevisions.agentId,
        agentScheduleRevisions.revision,
      ],
    }).onDelete("restrict"),
    index("agent_schedules_agent").on(table.agentId),
    index("agent_schedules_due")
      .on(table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
    check("agent_schedules_current_revision_positive", sql`${table.currentRevision} > 0`),
    check("agent_schedules_status", sql`${table.status} IN ('active', 'paused', 'deleted')`),
    check("agent_schedules_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "agent_schedules_dispatch_state",
      sql`((${table.lastRunId} IS NULL AND ${table.lastDispatchedAt} IS NULL)
        OR (${table.lastRunId} IS NOT NULL
          AND ${table.lastDispatchedAt} IS NOT NULL
          AND ${table.lastDispatchedAt} >= ${table.createdAt}))`,
    ),
    check(
      "agent_schedules_state",
      sql`((${table.status} = 'active' AND ${table.nextRunAt} IS NOT NULL)
        OR (${table.status} IN ('paused', 'deleted') AND ${table.nextRunAt} IS NULL))`,
    ),
  ],
);

export const agentScheduleUpdates = sqliteTable(
  "agent_schedule_updates",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("agent_schedule_updates_agent_revision").on(table.agentId, table.revision),
    foreignKey({
      columns: [table.agentId, table.revision],
      foreignColumns: [agentScheduleRevisions.agentId, agentScheduleRevisions.revision],
    }).onDelete("restrict"),
    check("agent_schedule_updates_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("agent_schedule_updates_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const agentScheduleOccurrences = sqliteTable(
  "agent_schedule_occurrences",
  {
    scheduleId: text("schedule_id").notNull(),
    agentId: text("agent_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    nextAttemptAt: integer("next_attempt_at"),
    attempts: integer("attempts").notNull(),
    status: text("status", { enum: ["pending", "dispatched", "skipped"] }).notNull(),
    runId: text("run_id"),
    reason: text("reason", {
      enum: [
        "active_run",
        "agent_changed",
        "agent_unavailable",
        "dispatch_exception",
        "record_dispatch_conflict",
        "run_unavailable",
      ],
    }),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleId, table.scheduleRevision, table.scheduledAt] }),
    foreignKey({
      columns: [table.scheduleId, table.agentId, table.scheduleRevision],
      foreignColumns: [
        agentScheduleRevisions.scheduleId,
        agentScheduleRevisions.agentId,
        agentScheduleRevisions.revision,
      ],
    }).onDelete("restrict"),
    index("agent_schedule_occurrences_pending")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index("agent_schedule_occurrences_history").on(table.scheduleId, table.occurredAt),
    check("agent_schedule_occurrences_revision_positive", sql`${table.scheduleRevision} > 0`),
    check("agent_schedule_occurrences_scheduled_at_positive", sql`${table.scheduledAt} > 0`),
    check("agent_schedule_occurrences_occurred_at_positive", sql`${table.occurredAt} > 0`),
    check("agent_schedule_occurrences_attempts_positive", sql`${table.attempts} > 0`),
    check(
      "agent_schedule_occurrences_status",
      sql`${table.status} IN ('pending', 'dispatched', 'skipped')`,
    ),
    check(
      "agent_schedule_occurrences_state",
      sql`(
        (${table.status} = 'pending'
          AND ${table.nextAttemptAt} IS NOT NULL
          AND ${table.runId} IS NULL
          AND ${table.reason} IS NULL)
        OR (${table.status} = 'dispatched'
          AND ${table.nextAttemptAt} IS NULL
          AND ${table.runId} IS NOT NULL
          AND ${table.reason} IS NULL)
        OR (${table.status} = 'skipped'
          AND ${table.nextAttemptAt} IS NULL
          AND ${table.runId} IS NULL
          AND ${table.reason} IS NOT NULL)
      )`,
    ),
  ],
);

export const agentEventTriggerRevisions = sqliteTable(
  "agent_event_trigger_revisions",
  {
    eventTriggerId: text("event_trigger_id").notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    definition: text("definition", { mode: "json" }).$type<AgentEventTriggerDefinition | null>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventTriggerId, table.revision] }),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    check("agent_event_trigger_revisions_revision_positive", sql`${table.revision} > 0`),
    check("agent_event_trigger_revisions_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check(
      "agent_event_trigger_revisions_definition_json",
      sql`${table.definition} IS NULL OR json_valid(${table.definition})`,
    ),
    check("agent_event_trigger_revisions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const agentEventTriggers = sqliteTable(
  "agent_event_triggers",
  {
    eventTriggerId: text("event_trigger_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    currentRevision: integer("current_revision").notNull(),
    connectionId: text("connection_id").notNull(),
    sourceSlug: text("source_slug").notNull(),
    status: text("status", { enum: ["active", "paused", "deleted"] }).notNull(),
    providerTriggerId: text("provider_trigger_id").unique(),
    providerOperation: text("provider_operation", {
      enum: ["stable", "creating", "pausing", "resuming", "deleting"],
    }).notNull(),
    providerAttempts: integer("provider_attempts").notNull().default(0),
    providerRetryAt: integer("provider_retry_at"),
    lastRunId: text("last_run_id"),
    lastDispatchedAt: integer("last_dispatched_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.agentId],
      foreignColumns: [agents.agentId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.connectionId],
      foreignColumns: [connections.connectionId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.eventTriggerId, table.currentRevision],
      foreignColumns: [
        agentEventTriggerRevisions.eventTriggerId,
        agentEventTriggerRevisions.revision,
      ],
    }).onDelete("restrict"),
    index("agent_event_triggers_agent").on(table.agentId),
    uniqueIndex("agent_event_triggers_active_source")
      .on(table.connectionId, table.sourceSlug)
      .where(sql`${table.status} != 'deleted'`),
    index("agent_event_triggers_operation")
      .on(table.providerOperation)
      .where(sql`${table.providerOperation} != 'stable'`),
    check("agent_event_triggers_current_revision_positive", sql`${table.currentRevision} > 0`),
    check(
      "agent_event_triggers_provider_attempts",
      sql`${table.providerAttempts} BETWEEN 0 AND 2147483647`,
    ),
    check("agent_event_triggers_status", sql`${table.status} IN ('active', 'paused', 'deleted')`),
    check(
      "agent_event_triggers_provider_operation",
      sql`${table.providerOperation} IN ('stable', 'creating', 'pausing', 'resuming', 'deleting')`,
    ),
    check("agent_event_triggers_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "agent_event_triggers_dispatch_state",
      sql`((${table.lastRunId} IS NULL AND ${table.lastDispatchedAt} IS NULL)
        OR (${table.lastRunId} IS NOT NULL
          AND ${table.lastDispatchedAt} IS NOT NULL
          AND ${table.lastDispatchedAt} >= ${table.createdAt}))`,
    ),
    check(
      "agent_event_triggers_provider_state",
      sql`(
        (${table.providerOperation} = 'creating' AND ${table.providerTriggerId} IS NULL)
        OR (${table.providerOperation} IN ('stable', 'pausing', 'resuming', 'deleting')
          AND (${table.status} = 'deleted' OR ${table.providerTriggerId} IS NOT NULL))
      )`,
    ),
    check(
      "agent_event_triggers_provider_retry_state",
      sql`(
        (${table.providerOperation} = 'stable'
          AND ${table.providerAttempts} = 0
          AND ${table.providerRetryAt} IS NULL)
        OR (${table.providerOperation} != 'stable'
          AND ${table.providerAttempts} BETWEEN 0 AND 4
          AND ${table.providerRetryAt} IS NOT NULL)
        OR (${table.providerOperation} != 'stable'
          AND ${table.providerAttempts} >= 5
          AND ${table.providerRetryAt} IS NULL)
      )`,
    ),
  ],
);

export const agentEventTriggerUpdates = sqliteTable(
  "agent_event_trigger_updates",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    action: text("action", {
      enum: ["create", "update", "pause", "resume", "delete"],
    }).notNull(),
    eventTriggerId: text("event_trigger_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.eventTriggerId, table.revision],
      foreignColumns: [
        agentEventTriggerRevisions.eventTriggerId,
        agentEventTriggerRevisions.revision,
      ],
    }).onDelete("restrict"),
    check(
      "agent_event_trigger_updates_request_digest_length",
      sql`length(${table.requestDigest}) = 43`,
    ),
    check(
      "agent_event_trigger_updates_action",
      sql`${table.action} IN ('create', 'update', 'pause', 'resume', 'delete')`,
    ),
    check("agent_event_trigger_updates_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const agentEventTriggerOccurrences = sqliteTable(
  "agent_event_trigger_occurrences",
  {
    eventTriggerId: text("event_trigger_id").notNull(),
    eventTriggerRevision: integer("event_trigger_revision").notNull(),
    agentId: text("agent_id").notNull(),
    eventId: text("event_id").notNull(),
    eventData: text("event_data", { mode: "json" })
      .$type<Record<string, IntegrationToolParameterValue>>()
      .notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    occurredAt: integer("occurred_at").notNull(),
    nextAttemptAt: integer("next_attempt_at"),
    attempts: integer("attempts").notNull(),
    status: text("status", { enum: ["pending", "dispatched", "skipped"] }).notNull(),
    runId: text("run_id"),
    reason: text("reason", {
      enum: [
        "active_run",
        "agent_changed",
        "agent_unavailable",
        "connection_unavailable",
        "dispatch_exception",
        "event_too_large",
        "record_dispatch_conflict",
        "run_unavailable",
        "source_mismatch",
        "event_trigger_deleted",
        "event_trigger_paused",
        "event_trigger_queue_full",
      ],
    }),
  },
  (table) => [
    primaryKey({ columns: [table.eventTriggerId, table.eventId] }),
    foreignKey({
      columns: [table.eventTriggerId, table.eventTriggerRevision],
      foreignColumns: [
        agentEventTriggerRevisions.eventTriggerId,
        agentEventTriggerRevisions.revision,
      ],
    }).onDelete("restrict"),
    index("agent_event_trigger_occurrences_pending")
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
    index("agent_event_trigger_occurrences_history").on(table.eventTriggerId, table.occurredAt),
    check(
      "agent_event_trigger_occurrences_revision_positive",
      sql`${table.eventTriggerRevision} > 0`,
    ),
    check("agent_event_trigger_occurrences_scheduled_at_positive", sql`${table.scheduledAt} > 0`),
    check("agent_event_trigger_occurrences_occurred_at_positive", sql`${table.occurredAt} > 0`),
    check("agent_event_trigger_occurrences_attempts_positive", sql`${table.attempts} > 0`),
    check("agent_event_trigger_occurrences_event_data_json", sql`json_valid(${table.eventData})`),
    check(
      "agent_event_trigger_occurrences_status",
      sql`${table.status} IN ('pending', 'dispatched', 'skipped')`,
    ),
    check(
      "agent_event_trigger_occurrences_state",
      sql`(
        (${table.status} = 'pending'
          AND ${table.nextAttemptAt} IS NOT NULL
          AND ${table.runId} IS NULL
          AND ${table.reason} IS NULL)
        OR (${table.status} = 'dispatched'
          AND ${table.nextAttemptAt} IS NULL
          AND ${table.runId} IS NOT NULL
          AND ${table.reason} IS NULL)
        OR (${table.status} = 'skipped'
          AND ${table.nextAttemptAt} IS NULL
          AND ${table.runId} IS NULL
          AND ${table.reason} IS NOT NULL)
      )`,
    ),
  ],
);

export const composioEventTriggerWebhook = sqliteTable(
  "composio_event_trigger_webhook",
  {
    singleton: integer("singleton").primaryKey(),
    subscriptionId: text("subscription_id").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretNonce: text("secret_nonce").notNull(),
    url: text("url").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    check("composio_event_trigger_webhook_singleton", sql`${table.singleton} = 1`),
    check("composio_event_trigger_webhook_updated_at_positive", sql`${table.updatedAt} > 0`),
  ],
);

export const agentWorkflows = sqliteTable(
  "agent_workflows",
  {
    workflowId: text("workflow_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    briefContext: text("brief_context", { mode: "json" }).$type<AdmittedBriefContext | null>(),
    fleetRevision: integer("fleet_revision").notNull(),
    objective: text("objective").notNull(),
    outputContract: text("output_contract", {
      mode: "json",
    }).$type<AdmittedOutputContract | null>(),
    budget: text("budget", { mode: "json" }).$type<AgentWorkflowAggregateBudget>().notNull(),
    status: text("status", {
      enum: ["queued", "running", "waiting", "cancelling", "completed", "failed", "cancelled"],
    }).notNull(),
    workflowRevision: integer("workflow_revision").notNull(),
    stageCount: integer("stage_count").notNull(),
    completedStages: integer("completed_stages").notNull().default(0),
    currentStageIndex: integer("current_stage_index"),
    currentRunId: text("current_run_id"),
    session: text("session", { mode: "json" }).$type<RunSession | null>(),
    failureCode: text("failure_code", {
      enum: [
        "agent_unavailable",
        "budget_exhausted",
        "brief_unavailable",
        "capability_unavailable",
        "coordinator_failed",
        "model_unavailable",
        "revision_conflict",
        "run_failed",
        "workflow_unavailable",
      ],
    }),
    failureStageIndex: integer("failure_stage_index"),
    cancellationRequestedAt: integer("cancellation_requested_at"),
    deletingAt: integer("deleting_at"),
    deliverable: text("deliverable", { mode: "json" }).$type<WorkflowDeliverable | null>(),
    deliverableObjectKey: text("deliverable_object_key"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
    cleanupAt: integer("cleanup_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_workflows_client_idempotency").on(table.clientId, table.idempotencyKey),
    index("agent_workflows_agent_created").on(table.agentId, table.workflowId),
    index("agent_workflows_cleanup").on(table.cleanupAt),
    index("agent_workflows_status_updated").on(table.status, table.updatedAt),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.fleetRevision],
      foreignColumns: [fleetConfigurationRevisions.revision],
    }).onDelete("restrict"),
    check("agent_workflows_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("agent_workflows_objective_length", sql`length(${table.objective}) BETWEEN 1 AND 4096`),
    check("agent_workflows_budget_json", sql`json_valid(${table.budget})`),
    check(
      "agent_workflows_output_contract_json",
      sql`${table.outputContract} IS NULL OR json_valid(${table.outputContract})`,
    ),
    check(
      "agent_workflows_brief_context_json",
      sql`${table.briefContext} IS NULL OR json_valid(${table.briefContext})`,
    ),
    check(
      "agent_workflows_deliverable_json",
      sql`${table.deliverable} IS NULL OR json_valid(${table.deliverable})`,
    ),
    check(
      "agent_workflows_deliverable_state",
      sql`(${table.deliverable} IS NULL AND ${table.deliverableObjectKey} IS NULL)
        OR (${table.deliverable} IS NOT NULL AND ${table.deliverableObjectKey} IS NOT NULL)`,
    ),
    check(
      "agent_workflows_status",
      sql`${table.status} IN ('queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')`,
    ),
    check("agent_workflows_revision_positive", sql`${table.workflowRevision} > 0`),
    check("agent_workflows_stage_count", sql`${table.stageCount} BETWEEN 2 AND 8`),
    check(
      "agent_workflows_completed_stages",
      sql`${table.completedStages} BETWEEN 0 AND ${table.stageCount}`,
    ),
    check(
      "agent_workflows_current_stage",
      sql`${table.currentStageIndex} IS NULL OR ${table.currentStageIndex} BETWEEN 0 AND ${table.stageCount} - 1`,
    ),
    check(
      "agent_workflows_session_json",
      sql`${table.session} IS NULL OR json_valid(${table.session})`,
    ),
    check(
      "agent_workflows_failure",
      sql`(${table.failureCode} IS NULL AND ${table.failureStageIndex} IS NULL)
        OR (${table.failureCode} IN ('agent_unavailable', 'brief_unavailable', 'budget_exhausted', 'capability_unavailable', 'coordinator_failed', 'model_unavailable', 'revision_conflict', 'run_failed', 'workflow_unavailable')
          AND ${table.failureStageIndex} BETWEEN 0 AND ${table.stageCount} - 1)`,
    ),
    check("agent_workflows_created_at_positive", sql`${table.createdAt} > 0`),
    check("agent_workflows_updated_after_creation", sql`${table.updatedAt} >= ${table.createdAt}`),
    check("agent_workflows_cleanup_after_creation", sql`${table.cleanupAt} > ${table.createdAt}`),
    check(
      "agent_workflows_terminal_state",
      sql`((${table.status} IN ('completed', 'failed', 'cancelled')
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.createdAt})
        OR (${table.status} NOT IN ('completed', 'failed', 'cancelled')
          AND ${table.completedAt} IS NULL))`,
    ),
  ],
);

export const agentWorkflowStages = sqliteTable(
  "agent_workflow_stages",
  {
    workflowId: text("workflow_id").notNull(),
    stageIndex: integer("stage_index").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    promptDigest: text("prompt_digest").notNull(),
    status: text("status", {
      enum: ["pending", "running", "waiting", "completed", "failed", "cancelled"],
    }).notNull(),
    runId: text("run_id"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.workflowId, table.stageIndex] }),
    uniqueIndex("agent_workflow_stages_run").on(table.runId),
    foreignKey({
      columns: [table.workflowId],
      foreignColumns: [agentWorkflows.workflowId],
    }).onDelete("cascade"),
    check("agent_workflow_stages_index", sql`${table.stageIndex} BETWEEN 0 AND 7`),
    check("agent_workflow_stages_name_length", sql`length(${table.name}) BETWEEN 1 AND 80`),
    check("agent_workflow_stages_prompt_length", sql`length(${table.prompt}) BETWEEN 1 AND 11264`),
    check("agent_workflow_stages_prompt_digest_length", sql`length(${table.promptDigest}) = 64`),
    check(
      "agent_workflow_stages_status",
      sql`${table.status} IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "agent_workflow_stages_state",
      sql`((${table.status} = 'pending'
          AND ${table.runId} IS NULL
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('running', 'waiting')
          AND ${table.runId} IS NOT NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('completed', 'cancelled')
          AND ${table.runId} IS NOT NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.completedAt} >= ${table.startedAt})
        OR (${table.status} = 'failed'
          AND ${table.completedAt} IS NOT NULL
          AND ((${table.runId} IS NULL AND ${table.startedAt} IS NULL)
            OR (${table.runId} IS NOT NULL
              AND ${table.startedAt} IS NOT NULL
              AND ${table.completedAt} >= ${table.startedAt}))))`,
    ),
  ],
);

export const agentWorkflowDeletions = sqliteTable(
  "agent_workflow_deletions",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    workflowId: text("workflow_id").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    startClientId: text("start_client_id").notNull(),
    startIdempotencyKey: text("start_idempotency_key").notNull(),
    startRequestDigest: text("start_request_digest").notNull(),
    deletedAt: integer("deleted_at").notNull(),
    cleanupAt: integer("cleanup_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    uniqueIndex("agent_workflow_deletions_start_idempotency").on(
      table.startClientId,
      table.startIdempotencyKey,
    ),
    index("agent_workflow_deletions_cleanup").on(table.cleanupAt),
    check("agent_workflow_deletions_revision_positive", sql`${table.expectedRevision} > 0`),
    check(
      "agent_workflow_deletions_start_request_digest_length",
      sql`length(${table.startRequestDigest}) = 43`,
    ),
    check("agent_workflow_deletions_deleted_at_positive", sql`${table.deletedAt} > 0`),
    check(
      "agent_workflow_deletions_cleanup_after_deletion",
      sql`${table.cleanupAt} > ${table.deletedAt}`,
    ),
  ],
);

export const briefs = sqliteTable(
  "briefs",
  {
    briefId: text("brief_id").primaryKey(),
    currentRevision: integer("current_revision").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "deleting"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletingAt: integer("deleting_at"),
  },
  (table) => [
    index("briefs_status_id").on(table.status, table.briefId),
    uniqueIndex("briefs_active_name")
      .on(table.name)
      .where(sql`${table.status} = 'active'`),
    check("briefs_current_revision_positive", sql`${table.currentRevision} > 0`),
    check("briefs_status", sql`${table.status} IN ('active', 'deleting')`),
    check("briefs_created_at_positive", sql`${table.createdAt} > 0`),
    check("briefs_updated_after_creation", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "briefs_state",
      sql`(${table.status} = 'active' AND ${table.deletingAt} IS NULL)
        OR (${table.status} = 'deleting' AND ${table.deletingAt} IS NOT NULL
          AND ${table.deletingAt} >= ${table.createdAt})`,
    ),
  ],
);

export const briefVersions = sqliteTable(
  "brief_versions",
  {
    briefId: text("brief_id").notNull(),
    revision: integer("revision").notNull(),
    digest: text("digest").notNull(),
    mediaType: text("media_type", {
      enum: ["application/json", "text/markdown", "text/plain"],
    }).notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.briefId, table.revision] }),
    foreignKey({ columns: [table.briefId], foreignColumns: [briefs.briefId] }).onDelete("cascade"),
    check("brief_versions_revision_positive", sql`${table.revision} > 0`),
    check("brief_versions_digest_length", sql`length(${table.digest}) = 64`),
    check(
      "brief_versions_media_type",
      sql`${table.mediaType} IN ('application/json', 'text/markdown', 'text/plain')`,
    ),
    check("brief_versions_size_bytes", sql`${table.sizeBytes} BETWEEN 1 AND 32768`),
    check("brief_versions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const briefMutations = sqliteTable(
  "brief_mutations",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    operation: text("operation", { enum: ["create", "revise"] }).notNull(),
    briefId: text("brief_id").notNull(),
    revision: integer("revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    check("brief_mutations_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("brief_mutations_operation", sql`${table.operation} IN ('create', 'revise')`),
    check("brief_mutations_revision_positive", sql`${table.revision} > 0`),
  ],
);

export const briefDeletions = sqliteTable(
  "brief_deletions",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    briefId: text("brief_id").notNull().unique(),
    expectedRevision: integer("expected_revision").notNull(),
    deletedAt: integer("deleted_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    check("brief_deletions_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("brief_deletions_revision_positive", sql`${table.expectedRevision} > 0`),
    check("brief_deletions_deleted_at_positive", sql`${table.deletedAt} > 0`),
  ],
);

export const skills = sqliteTable(
  "skills",
  {
    skillId: text("skill_id").primaryKey(),
    currentVersion: integer("current_version").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "retired"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    retiredAt: integer("retired_at"),
  },
  (table) => [
    index("skills_status_id").on(table.status, table.skillId),
    uniqueIndex("skills_active_name")
      .on(table.name)
      .where(sql`${table.status} = 'active'`),
    check("skills_current_version_positive", sql`${table.currentVersion} > 0`),
    check("skills_status", sql`${table.status} IN ('active', 'retired')`),
    check("skills_created_at_positive", sql`${table.createdAt} > 0`),
    check("skills_updated_after_creation", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "skills_state",
      sql`(
        (${table.status} = 'active' AND ${table.retiredAt} IS NULL)
        OR (${table.status} = 'retired'
          AND ${table.retiredAt} IS NOT NULL
          AND ${table.retiredAt} >= ${table.createdAt})
      )`,
    ),
  ],
);

export const skillObjects = sqliteTable(
  "skill_objects",
  {
    packageDigest: text("package_digest").primaryKey(),
    objectKey: text("object_key").notNull().unique(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: ["pending", "committed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    committedAt: integer("committed_at"),
  },
  (table) => [
    check("skill_objects_package_digest_length", sql`length(${table.packageDigest}) = 64`),
    check("skill_objects_size_bytes_positive", sql`${table.sizeBytes} > 0`),
    check("skill_objects_status", sql`${table.status} IN ('pending', 'committed')`),
    check("skill_objects_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "skill_objects_state",
      sql`(
        (${table.status} = 'pending' AND ${table.committedAt} IS NULL)
        OR (${table.status} = 'committed'
          AND ${table.committedAt} IS NOT NULL
          AND ${table.committedAt} >= ${table.createdAt})
      )`,
    ),
  ],
);

export const skillVersions = sqliteTable(
  "skill_versions",
  {
    skillId: text("skill_id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    packageDigest: text("package_digest").notNull(),
    objectKey: text("object_key").notNull(),
    fileCount: integer("file_count").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    warnings: text("warnings", { mode: "json" }).$type<SkillWarning[]>().notNull(),
    provenance: text("provenance", { mode: "json" }).$type<SkillProvenance>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.version] }),
    foreignKey({
      columns: [table.skillId],
      foreignColumns: [skills.skillId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.packageDigest],
      foreignColumns: [skillObjects.packageDigest],
    }).onDelete("restrict"),
    index("skill_versions_object_key").on(table.objectKey),
    check("skill_versions_version_positive", sql`${table.version} > 0`),
    check("skill_versions_package_digest_length", sql`length(${table.packageDigest}) = 64`),
    check("skill_versions_file_count_positive", sql`${table.fileCount} > 0`),
    check("skill_versions_size_bytes_positive", sql`${table.sizeBytes} > 0`),
    check("skill_versions_warnings_json", sql`json_valid(${table.warnings})`),
    check("skill_versions_provenance_json", sql`json_valid(${table.provenance})`),
    check("skill_versions_created_at_positive", sql`${table.createdAt} > 0`),
  ],
);

export const skillMutations = sqliteTable(
  "skill_mutations",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    operation: text("operation", { enum: ["publish", "retire"] }).notNull(),
    skillId: text("skill_id").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.clientId, table.idempotencyKey] }),
    foreignKey({
      columns: [table.skillId, table.version],
      foreignColumns: [skillVersions.skillId, skillVersions.version],
    }).onDelete("restrict"),
    check("skill_mutations_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("skill_mutations_operation", sql`${table.operation} IN ('publish', 'retire')`),
    check("skill_mutations_version_positive", sql`${table.version} > 0`),
  ],
);

export const recipeInstallations = sqliteTable(
  "recipe_installations",
  {
    installationId: text("installation_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    planDigest: text("plan_digest").notNull(),
    plan: text("plan", { mode: "json" }).$type<RecipeInstallationPlan>().notNull(),
    skillPackages: text("skill_packages", { mode: "json" })
      .$type<RegistrySkillPackage[]>()
      .notNull(),
    receipt: text("receipt", { mode: "json" }).$type<RecipeInstallationReceipt>().notNull(),
    status: text("status", { enum: ["installing", "installed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("recipe_installations_client_idempotency").on(table.clientId, table.idempotencyKey),
    index("recipe_installations_status_updated").on(table.status, table.updatedAt),
    check("recipe_installations_request_digest_length", sql`length(${table.requestDigest}) = 64`),
    check("recipe_installations_plan_digest_length", sql`length(${table.planDigest}) = 64`),
    check("recipe_installations_plan_json", sql`json_valid(${table.plan})`),
    check("recipe_installations_skill_packages_json", sql`json_valid(${table.skillPackages})`),
    check("recipe_installations_receipt_json", sql`json_valid(${table.receipt})`),
    check("recipe_installations_status", sql`${table.status} IN ('installing', 'installed')`),
    check("recipe_installations_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "recipe_installations_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const mcpAuthoringDrafts = sqliteTable(
  "mcp_authoring_drafts",
  {
    draftId: text("draft_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    kind: text("kind", {
      enum: [
        "agent-blueprint-package",
        "recipe-installation",
        "recipe-publication",
        "skill-package",
      ],
    })
      .$type<McpAuthoringDraftKind>()
      .notNull(),
    revision: integer("revision").notNull(),
    content: text("content", { mode: "json" }).$type<JsonValue>().notNull(),
    contentDigest: text("content_digest").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    lastIdempotencyKey: text("last_idempotency_key"),
    lastRequestDigest: text("last_request_digest"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("mcp_authoring_drafts_client_idempotency").on(table.clientId, table.idempotencyKey),
    index("mcp_authoring_drafts_client_expiry").on(table.clientId, table.expiresAt),
    check("mcp_authoring_drafts_request_digest_length", sql`length(${table.requestDigest}) = 64`),
    check(
      "mcp_authoring_drafts_kind",
      sql`${table.kind} IN ('agent-blueprint-package', 'recipe-installation', 'recipe-publication', 'skill-package')`,
    ),
    check("mcp_authoring_drafts_revision_positive", sql`${table.revision} > 0`),
    check("mcp_authoring_drafts_content_json", sql`json_valid(${table.content})`),
    check("mcp_authoring_drafts_content_digest_length", sql`length(${table.contentDigest}) = 64`),
    check("mcp_authoring_drafts_size", sql`${table.sizeBytes} BETWEEN 2 AND 163840`),
    check(
      "mcp_authoring_drafts_last_request_digest",
      sql`${table.lastRequestDigest} IS NULL OR length(${table.lastRequestDigest}) = 64`,
    ),
    check("mcp_authoring_drafts_expires_at_positive", sql`${table.expiresAt} > 0`),
    check("mcp_authoring_drafts_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "mcp_authoring_drafts_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
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
    briefContext: text("brief_context", { mode: "json" }).$type<AdmittedBriefContext | null>(),
    prompt: text("prompt"),
    promptDigest: text("prompt_digest").notNull(),
    outputContract: text("output_contract", {
      mode: "json",
    }).$type<AdmittedOutputContract | null>(),
    scheduleRevision: integer("schedule_revision"),
    trigger: text("trigger", { enum: ["manual", "schedule", "event_trigger", "workflow"] })
      .notNull()
      .default("manual"),
    eventTriggerEventId: text("event_trigger_event_id"),
    eventTriggerId: text("event_trigger_id"),
    eventTriggerRevision: integer("event_trigger_revision"),
    eventTriggerSourceKind: text("event_trigger_source_kind", {
      enum: ["connection_event"],
    }).$type<"connection_event">(),
    budgetReservation: text("budget_reservation", { mode: "json" })
      .$type<RunBudgetReservation>()
      .notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    status: text("status", { enum: ["issued", "redeemed", "expired"] }).notNull(),
    failureCode: text("failure_code", { enum: ["skill_unavailable"] }),
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
    foreignKey({
      columns: [table.eventTriggerId, table.eventTriggerRevision],
      foreignColumns: [
        agentEventTriggerRevisions.eventTriggerId,
        agentEventTriggerRevisions.revision,
      ],
    }).onDelete("restrict"),
    index("run_admissions_cleanup").on(table.cleanupAt),
    index("run_admissions_expiry")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'issued'`),
    check("run_admissions_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("run_admissions_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check(
      "run_admissions_brief_context_json",
      sql`${table.briefContext} IS NULL OR json_valid(${table.briefContext})`,
    ),
    check(
      "run_admissions_prompt_length",
      sql`${table.prompt} IS NULL OR length(${table.prompt}) BETWEEN 1 AND 16384`,
    ),
    check("run_admissions_prompt_digest_length", sql`length(${table.promptDigest}) = 64`),
    check(
      "run_admissions_output_contract_json",
      sql`${table.outputContract} IS NULL OR json_valid(${table.outputContract})`,
    ),
    check(
      "run_admissions_schedule_revision_positive",
      sql`${table.scheduleRevision} IS NULL OR ${table.scheduleRevision} > 0`,
    ),
    check(
      "run_admissions_trigger",
      sql`${table.trigger} IN ('manual', 'schedule', 'event_trigger', 'workflow')`,
    ),
    check(
      "run_admissions_event_trigger_identity",
      sql`(
        (${table.eventTriggerId} IS NULL
          AND ${table.eventTriggerRevision} IS NULL
          AND ${table.eventTriggerEventId} IS NULL
          AND ${table.eventTriggerSourceKind} IS NULL
          AND ${table.trigger} <> 'event_trigger')
        OR (${table.eventTriggerId} IS NOT NULL
          AND ${table.eventTriggerRevision} IS NOT NULL
          AND ${table.eventTriggerEventId} IS NOT NULL
          AND ${table.eventTriggerSourceKind} = 'connection_event'
          AND ${table.trigger} = 'event_trigger')
      )`,
    ),
    check(
      "run_admissions_event_trigger_revision_positive",
      sql`${table.eventTriggerRevision} IS NULL OR ${table.eventTriggerRevision} > 0`,
    ),
    check("run_admissions_nonce_digest_length", sql`length(${table.nonceDigest}) = 43`),
    check("run_admissions_status", sql`${table.status} IN ('issued', 'redeemed', 'expired')`),
    check(
      "run_admissions_failure_code",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} = 'skill_unavailable'`,
    ),
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
          AND ${table.failureCode} IS NULL
          AND ${table.redeemedAt} IS NULL
          AND ${table.modelCallConsumedAt} IS NULL
          AND ${table.modelCallsConsumed} = 0)
        OR (${table.status} = 'redeemed'
          AND ${table.failureCode} IS NULL
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

export const aiGatewayCalls = sqliteTable(
  "ai_gateway_calls",
  {
    gatewayLogId: text("gateway_log_id").primaryKey(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    status: text("status", { enum: ["pending", "settled"] }).notNull(),
    reservationMicrousd: integer("reservation_microusd").notNull(),
    costMicrousd: integer("cost_microusd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    recordedAt: integer("recorded_at").notNull(),
    settledAt: integer("settled_at"),
    nextReconciliationAt: integer("next_reconciliation_at").notNull(),
    reconciliationAttempts: integer("reconciliation_attempts").notNull().default(0),
  },
  (table) => [
    index("ai_gateway_calls_run").on(table.runId, table.recordedAt),
    index("ai_gateway_calls_reconciliation")
      .on(table.nextReconciliationAt)
      .where(sql`${table.status} = 'pending'`),
    check("ai_gateway_calls_status", sql`${table.status} IN ('pending', 'settled')`),
    check(
      "ai_gateway_calls_cost_nonnegative",
      sql`${table.costMicrousd} IS NULL OR ${table.costMicrousd} >= 0`,
    ),
    check("ai_gateway_calls_reservation_positive", sql`${table.reservationMicrousd} > 0`),
    check(
      "ai_gateway_calls_tokens_nonnegative",
      sql`(${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0)
        AND (${table.outputTokens} IS NULL OR ${table.outputTokens} >= 0)`,
    ),
    check("ai_gateway_calls_recorded_at_positive", sql`${table.recordedAt} > 0`),
    check(
      "ai_gateway_calls_settlement_state",
      sql`((${table.status} = 'pending'
          AND ${table.costMicrousd} IS NULL
          AND ${table.settledAt} IS NULL)
        OR (${table.status} = 'settled'
          AND ${table.costMicrousd} IS NOT NULL
          AND ${table.settledAt} IS NOT NULL
          AND ${table.settledAt} >= ${table.recordedAt}))`,
    ),
    check(
      "ai_gateway_calls_reconciliation_positive",
      sql`${table.nextReconciliationAt} > 0 AND ${table.reconciliationAttempts} >= 0`,
    ),
  ],
);

export const integrationUsageEvents = sqliteTable(
  "integration_usage_events",
  {
    toolCallId: text("tool_call_id").primaryKey(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    grantId: text("grant_id").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    index("integration_usage_events_recorded_at").on(table.recordedAt),
    index("integration_usage_events_agent").on(table.agentId, table.recordedAt),
    check("integration_usage_events_recorded_at_positive", sql`${table.recordedAt} > 0`),
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
    inputDigest: text("input_digest").notNull(),
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
    index("tool_executions_started_at").on(table.startedAt),
    index("tool_executions_run_input").on(table.runId, table.grantId, table.inputDigest),
    check("tool_executions_action_digest_length", sql`length(${table.actionDigest}) = 64`),
    check("tool_executions_effect_digest_length", sql`length(${table.effectDigest}) = 64`),
    check("tool_executions_input_digest_length", sql`length(${table.inputDigest}) = 64`),
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

export const runtimeToolExecutions = sqliteTable(
  "runtime_tool_executions",
  {
    toolCallId: text("tool_call_id").primaryKey(),
    runId: text("run_id").notNull(),
    toolId: text("tool_id").notNull(),
    actionDigest: text("action_digest").notNull(),
    inputDigest: text("input_digest").notNull(),
    nonceDigest: text("nonce_digest").notNull(),
    status: text("status", {
      enum: ["reserved", "completed", "failed", "unknown"],
    }).notNull(),
    outputBytes: integer("output_bytes"),
    expiresAt: integer("expires_at").notNull(),
    startedAt: integer("started_at").notNull(),
    dispatchedAt: integer("dispatched_at"),
    completedAt: integer("completed_at"),
    cleanupAt: integer("cleanup_at"),
    cleanupRetryAt: integer("cleanup_retry_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.runId],
      foreignColumns: [runAdmissions.runId],
    }).onDelete("restrict"),
    index("runtime_tool_executions_run").on(table.runId, table.startedAt),
    index("runtime_tool_executions_expiry").on(table.status, table.expiresAt),
    index("runtime_tool_executions_run_input").on(table.runId, table.toolId, table.inputDigest),
    check("runtime_tool_executions_action_digest_length", sql`length(${table.actionDigest}) = 64`),
    check("runtime_tool_executions_input_digest_length", sql`length(${table.inputDigest}) = 64`),
    check("runtime_tool_executions_nonce_digest_length", sql`length(${table.nonceDigest}) = 43`),
    check(
      "runtime_tool_executions_status",
      sql`${table.status} IN ('reserved', 'completed', 'failed', 'unknown')`,
    ),
    check(
      "runtime_tool_executions_output_nonnegative",
      sql`${table.outputBytes} IS NULL OR ${table.outputBytes} >= 0`,
    ),
    check("runtime_tool_executions_started_at_positive", sql`${table.startedAt} > 0`),
    check(
      "runtime_tool_executions_dispatched_at_positive",
      sql`${table.dispatchedAt} IS NULL OR ${table.dispatchedAt} > 0`,
    ),
    check(
      "runtime_tool_executions_dispatch_after_start",
      sql`${table.dispatchedAt} IS NULL OR ${table.dispatchedAt} >= ${table.startedAt}`,
    ),
    check(
      "runtime_tool_executions_expiry_after_start",
      sql`${table.expiresAt} > ${table.startedAt}`,
    ),
    check(
      "runtime_tool_executions_completion_after_dispatch",
      sql`${table.completedAt} IS NULL
        OR ${table.dispatchedAt} IS NULL
        OR ${table.completedAt} >= ${table.dispatchedAt}`,
    ),
    check("runtime_tool_executions_cleanup_retry_positive", sql`${table.cleanupRetryAt} > 0`),
    check(
      "runtime_tool_executions_cleanup_after_start",
      sql`${table.cleanupAt} IS NULL OR ${table.cleanupAt} >= ${table.startedAt}`,
    ),
    check(
      "runtime_tool_executions_state",
      sql`(
        (${table.status} = 'reserved'
          AND ${table.outputBytes} IS NULL
          AND ${table.completedAt} IS NULL)
        OR (${table.status} IN ('completed', 'failed', 'unknown')
          AND ${table.outputBytes} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
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

export const agentInboxAcknowledgements = sqliteTable(
  "agent_inbox_acknowledgements",
  {
    itemId: text("item_id").notNull(),
    version: text("version").notNull(),
    acknowledgedAt: integer("acknowledged_at").notNull(),
    cleanupAt: integer("cleanup_at").notNull(),
    clientId: text("client_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.version] }),
    index("agent_inbox_acknowledgements_cleanup").on(table.cleanupAt),
    check("agent_inbox_acknowledgements_acknowledged_at", sql`${table.acknowledgedAt} > 0`),
    check(
      "agent_inbox_acknowledgements_cleanup_after_acknowledgement",
      sql`${table.cleanupAt} > ${table.acknowledgedAt}`,
    ),
  ],
);

export const agentInboxItems = sqliteTable(
  "agent_inbox_items",
  {
    itemId: text("item_id").primaryKey(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    fleetRevision: integer("fleet_revision").notNull(),
    scheduleId: text("schedule_id"),
    scheduleRevision: integer("schedule_revision"),
    runId: text("run_id"),
    trigger: text("trigger", { enum: ["manual", "schedule", "event_trigger", "workflow"] }),
    eventTriggerEventId: text("event_trigger_event_id"),
    eventTriggerId: text("event_trigger_id"),
    eventTriggerRevision: integer("event_trigger_revision"),
    eventTriggerSourceKind: text("event_trigger_source_kind", {
      enum: ["connection_event"],
    }).$type<"connection_event">(),
    runStatus: text("run_status", {
      enum: ["cancelled", "completed", "failed", "running"],
    }),
    kind: text("kind", {
      enum: ["action_required", "deferred", "exception", "outcome"],
    }).notNull(),
    approvalCount: integer("approval_count").notNull().default(0),
    requestPreview: text("request_preview").notNull(),
    resultPreview: text("result_preview"),
    reason: text("reason").$type<AgentInboxDeferredReason>(),
    scheduledAt: integer("scheduled_at"),
    retryAt: integer("retry_at"),
    occurredAt: integer("occurred_at").notNull(),
    version: text("version").notNull(),
    cleanupAt: integer("cleanup_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_inbox_items_run").on(table.runId),
    uniqueIndex("agent_inbox_items_schedule_occurrence").on(
      table.agentId,
      table.scheduleRevision,
      table.scheduledAt,
    ),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    index("agent_inbox_items_agent_occurred").on(table.agentId, table.occurredAt),
    index("agent_inbox_items_cleanup").on(table.cleanupAt),
    index("agent_inbox_items_kind_occurred").on(table.kind, table.occurredAt),
    index("agent_inbox_items_occurred").on(table.occurredAt),
    check("agent_inbox_items_agent_revision", sql`${table.agentRevision} > 0`),
    check("agent_inbox_items_fleet_revision", sql`${table.fleetRevision} > 0`),
    check(
      "agent_inbox_items_schedule_revision",
      sql`${table.scheduleRevision} IS NULL OR ${table.scheduleRevision} > 0`,
    ),
    check(
      "agent_inbox_items_schedule_identity",
      sql`(${table.scheduleId} IS NULL) = (${table.scheduleRevision} IS NULL)`,
    ),
    check(
      "agent_inbox_items_event_trigger_identity",
      sql`(
        (${table.eventTriggerId} IS NULL
          AND ${table.eventTriggerRevision} IS NULL
          AND ${table.eventTriggerEventId} IS NULL
          AND ${table.eventTriggerSourceKind} IS NULL
          AND (${table.trigger} IS NULL OR ${table.trigger} <> 'event_trigger'))
        OR (${table.eventTriggerId} IS NOT NULL
          AND ${table.eventTriggerRevision} IS NOT NULL
          AND ${table.eventTriggerEventId} IS NOT NULL
          AND ${table.eventTriggerSourceKind} = 'connection_event'
          AND ${table.trigger} = 'event_trigger')
      )`,
    ),
    check(
      "agent_inbox_items_kind",
      sql`${table.kind} IN ('action_required', 'deferred', 'exception', 'outcome')`,
    ),
    check("agent_inbox_items_approval_count", sql`${table.approvalCount} BETWEEN 0 AND 100`),
    check(
      "agent_inbox_items_request_preview",
      sql`length(${table.requestPreview}) BETWEEN 1 AND 240`,
    ),
    check(
      "agent_inbox_items_result_preview",
      sql`${table.resultPreview} IS NULL OR length(${table.resultPreview}) BETWEEN 1 AND 240`,
    ),
    check(
      "agent_inbox_items_reason",
      sql`${table.reason} IS NULL OR ${table.reason} IN (
        'active_run',
        'admission_limit_exceeded',
        'agent_not_found',
        'agent_unavailable',
        'budget_exhausted',
        'capability_unavailable',
        'dispatch_exception',
        'idempotency_conflict',
        'model_unavailable',
        'record_dispatch_conflict',
        'revision_conflict',
        'run_unavailable'
      )`,
    ),
    check(
      "agent_inbox_items_shape",
      sql`(
        (${table.kind} = 'deferred'
          AND ${table.runId} IS NULL
          AND ${table.trigger} IS NULL
          AND ${table.runStatus} IS NULL
          AND ${table.scheduleRevision} IS NOT NULL
          AND ${table.reason} IS NOT NULL
          AND ${table.scheduledAt} IS NOT NULL
          AND ${table.approvalCount} = 0
          AND ${table.resultPreview} IS NULL)
        OR
        (${table.kind} <> 'deferred'
          AND ${table.runId} IS NOT NULL
          AND ${table.trigger} IS NOT NULL
          AND ${table.runStatus} IS NOT NULL
          AND ${table.reason} IS NULL
          AND ${table.scheduledAt} IS NULL
          AND ${table.retryAt} IS NULL
          AND ((${table.kind} = 'action_required' AND ${table.approvalCount} > 0)
            OR (${table.kind} <> 'action_required' AND ${table.approvalCount} = 0))
          AND ((${table.kind} = 'action_required' AND ${table.runStatus} = 'running')
            OR (${table.kind} = 'exception' AND ${table.runStatus} = 'failed')
            OR (${table.kind} = 'outcome'
              AND ${table.runStatus} IN ('cancelled', 'completed'))))
      )`,
    ),
    check(
      "agent_inbox_items_scheduled_at",
      sql`${table.scheduledAt} IS NULL OR ${table.scheduledAt} > 0`,
    ),
    check(
      "agent_inbox_items_retry_at",
      sql`${table.retryAt} IS NULL OR ${table.retryAt} > ${table.scheduledAt}`,
    ),
    check("agent_inbox_items_occurred_at", sql`${table.occurredAt} > 0`),
    check(
      "agent_inbox_items_cleanup_after_occurrence",
      sql`${table.cleanupAt} > ${table.occurredAt}`,
    ),
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

export const providerAuthConfigs = sqliteTable(
  "provider_auth_configs",
  {
    authConfigId: text("auth_config_id").primaryKey(),
    integrationSlug: text("integration_slug").notNull(),
    authScheme: text("auth_scheme", {
      enum: ["OAUTH2", "API_KEY", "BEARER_TOKEN", "BASIC"],
    }).notNull(),
    source: text("source", {
      enum: ["composio_managed", "crewhelm_custom"],
    }).notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("provider_auth_configs_integration").on(table.integrationSlug, table.authConfigId),
    check(
      "provider_auth_configs_integration_slug",
      sql`length(${table.integrationSlug}) BETWEEN 1 AND 128`,
    ),
    check(
      "provider_auth_configs_auth_scheme",
      sql`${table.authScheme} IN ('OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC')`,
    ),
    check(
      "provider_auth_configs_source",
      sql`${table.source} IN ('composio_managed', 'crewhelm_custom')`,
    ),
    check(
      "provider_auth_configs_display_name",
      sql`length(${table.displayName}) BETWEEN 1 AND 160`,
    ),
    check("provider_auth_configs_created_at_positive", sql`${table.createdAt} > 0`),
    check(
      "provider_auth_configs_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const providerAuthSetupRequests = sqliteTable(
  "provider_auth_setup_requests",
  {
    setupId: text("setup_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    capabilityDigest: text("capability_digest").notNull().unique(),
    capabilityExpiresAt: integer("capability_expires_at").notNull(),
    setupExpiresAt: integer("setup_expires_at").notNull(),
    sessionDigest: text("session_digest").unique(),
    sessionExpiresAt: integer("session_expires_at"),
    plan: text("plan", { mode: "json" }).$type<ProviderAuthSetupPlan>().notNull(),
    status: text("status", {
      enum: ["prepared", "exchanged", "submitting", "configured", "rejected", "outcome_unknown"],
    }).notNull(),
    authConfigId: text("auth_config_id"),
    recoverAfter: integer("recover_after"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_auth_setup_requests_client_idempotency").on(
      table.clientId,
      table.idempotencyKey,
    ),
    index("provider_auth_setup_requests_status_expiry").on(table.status, table.setupExpiresAt),
    check("provider_auth_setup_requests_request_digest", sql`length(${table.requestDigest}) = 64`),
    check(
      "provider_auth_setup_requests_capability_digest",
      sql`length(${table.capabilityDigest}) = 64`,
    ),
    check(
      "provider_auth_setup_requests_session_digest",
      sql`${table.sessionDigest} IS NULL OR length(${table.sessionDigest}) = 64`,
    ),
    check("provider_auth_setup_requests_plan_json", sql`json_valid(${table.plan})`),
    check(
      "provider_auth_setup_requests_status",
      sql`${table.status} IN ('prepared', 'exchanged', 'submitting', 'configured', 'rejected', 'outcome_unknown')`,
    ),
    check("provider_auth_setup_requests_created_at", sql`${table.createdAt} > 0`),
    check("provider_auth_setup_requests_updated_at", sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      "provider_auth_setup_requests_expiry",
      sql`${table.capabilityExpiresAt} > ${table.createdAt} AND ${table.setupExpiresAt} >= ${table.capabilityExpiresAt}`,
    ),
    check(
      "provider_auth_setup_requests_session_state",
      sql`(
        (${table.status} = 'prepared' AND ${table.sessionDigest} IS NULL AND ${table.sessionExpiresAt} IS NULL)
        OR
        (${table.status} <> 'prepared' AND ${table.sessionDigest} IS NOT NULL AND ${table.sessionExpiresAt} IS NOT NULL)
      )`,
    ),
    check(
      "provider_auth_setup_requests_completion_state",
      sql`(
        (${table.status} = 'configured' AND ${table.authConfigId} IS NOT NULL)
        OR
        (${table.status} <> 'configured' AND ${table.authConfigId} IS NULL)
      )`,
    ),
    check(
      "provider_auth_setup_requests_recovery_state",
      sql`(
        (${table.status} IN ('submitting', 'outcome_unknown') AND ${table.recoverAfter} IS NOT NULL)
        OR
        (${table.status} NOT IN ('submitting', 'outcome_unknown') AND ${table.recoverAfter} IS NULL)
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
  aiGatewayCalls,
  agentBlueprintMutations,
  agentBlueprintVersions,
  agentBlueprints,
  agentCreations,
  agentEventTriggerOccurrences,
  agentEventTriggerRevisions,
  agentEventTriggerUpdates,
  agentEventTriggers,
  agentInboxAcknowledgements,
  agentInboxItems,
  agentRevisions,
  agentScheduleRevisions,
  agentScheduleOccurrences,
  agentSchedules,
  agentScheduleUpdates,
  agentWorkflowDeletions,
  agentWorkflowStages,
  agentWorkflows,
  agentUpdates,
  agents,
  auditEvents,
  briefDeletions,
  briefMutations,
  briefVersions,
  briefs,
  capabilityGrants,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  remoteMcpConnections,
  remoteMcpConnectionMutations,
  remoteMcpOAuthRequests,
  recipeInstallations,
  composioEventTriggerWebhook,
  controlPlane,
  controlPlaneMigrations,
  fleetConfigurationRevisions,
  fleetConfigurations,
  fleetConfigurationUpdates,
  integrationUsageEvents,
  integrationEnablementRequests,
  providerAuthConfigs,
  providerAuthSetupRequests,
  mcpAuthoringDrafts,
  runAdmissions,
  runtimeToolExecutions,
  skillMutations,
  skillObjects,
  skills,
  skillVersions,
  toolApprovals,
  toolExecutions,
};

export type ControlPlaneDatabaseSchema = typeof controlPlaneSchema;
export type StoredConnectionAuthorizationOutcome = Exclude<
  ConnectionAuthorizationOutcome,
  "untracked"
>;
