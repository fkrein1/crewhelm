import type {
  Agent,
  AgentBlueprintPackage,
  AgentBlueprintProvenance,
  AgentCapabilityConfigurations,
  AgentInboxDeferredReason,
  AgentExecutionLimits,
  AgentScheduleConfiguration,
  AgentWorkflowAggregateBudget,
  ComposioToolCapabilityGrant,
  ConnectionAuthorizationOutcome,
  FleetConfigurationData,
  RunBudgetReservation,
  RunSession,
  SkillProvenance,
  SkillWarning,
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
    provider: text("provider", { enum: ["composio"] }).notNull(),
    providerConnectionId: text("provider_connection_id").notNull().unique(),
    authConfigId: text("auth_config_id").notNull(),
    accountLabel: text("account_label"),
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

export const agentScheduleRevisions = sqliteTable(
  "agent_schedule_revisions",
  {
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    configuration: text("configuration", {
      mode: "json",
    }).$type<AgentScheduleConfiguration | null>(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.revision] }),
    foreignKey({
      columns: [table.agentId, table.agentRevision],
      foreignColumns: [agentRevisions.agentId, agentRevisions.revision],
    }).onDelete("restrict"),
    check("agent_schedule_revisions_revision_positive", sql`${table.revision} > 0`),
    check("agent_schedule_revisions_agent_revision_positive", sql`${table.agentRevision} > 0`),
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
    agentId: text("agent_id").primaryKey(),
    currentRevision: integer("current_revision").notNull(),
    status: text("status", { enum: ["active", "paused"] }).notNull(),
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
      columns: [table.agentId, table.currentRevision],
      foreignColumns: [agentScheduleRevisions.agentId, agentScheduleRevisions.revision],
    }).onDelete("restrict"),
    index("agent_schedules_due")
      .on(table.nextRunAt)
      .where(sql`${table.status} = 'active'`),
    check("agent_schedules_current_revision_positive", sql`${table.currentRevision} > 0`),
    check("agent_schedules_status", sql`${table.status} IN ('active', 'paused')`),
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
        OR (${table.status} = 'paused' AND ${table.nextRunAt} IS NULL))`,
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

export const agentWorkflows = sqliteTable(
  "agent_workflows",
  {
    workflowId: text("workflow_id").primaryKey(),
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    fleetRevision: integer("fleet_revision").notNull(),
    objective: text("objective").notNull(),
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
        OR (${table.failureCode} IN ('agent_unavailable', 'budget_exhausted', 'capability_unavailable', 'coordinator_failed', 'model_unavailable', 'revision_conflict', 'run_failed', 'workflow_unavailable')
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

export const runAdmissions = sqliteTable(
  "run_admissions",
  {
    clientId: text("client_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    runId: text("run_id").notNull(),
    agentId: text("agent_id").notNull(),
    agentRevision: integer("agent_revision").notNull(),
    prompt: text("prompt"),
    promptDigest: text("prompt_digest").notNull(),
    scheduleRevision: integer("schedule_revision"),
    trigger: text("trigger", { enum: ["manual", "schedule", "workflow"] })
      .notNull()
      .default("manual"),
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
    index("run_admissions_cleanup").on(table.cleanupAt),
    index("run_admissions_expiry")
      .on(table.expiresAt)
      .where(sql`${table.status} = 'issued'`),
    check("run_admissions_request_digest_length", sql`length(${table.requestDigest}) = 43`),
    check("run_admissions_agent_revision_positive", sql`${table.agentRevision} > 0`),
    check(
      "run_admissions_prompt_length",
      sql`${table.prompt} IS NULL OR length(${table.prompt}) BETWEEN 1 AND 16384`,
    ),
    check("run_admissions_prompt_digest_length", sql`length(${table.promptDigest}) = 64`),
    check(
      "run_admissions_schedule_revision_positive",
      sql`${table.scheduleRevision} IS NULL OR ${table.scheduleRevision} > 0`,
    ),
    check("run_admissions_trigger", sql`${table.trigger} IN ('manual', 'schedule', 'workflow')`),
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
    scheduleRevision: integer("schedule_revision"),
    runId: text("run_id"),
    trigger: text("trigger", { enum: ["manual", "schedule", "workflow"] }),
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
  agentInboxAcknowledgements,
  agentInboxItems,
  agentRevisions,
  agentScheduleRevisions,
  agentSchedules,
  agentScheduleUpdates,
  agentWorkflowDeletions,
  agentWorkflowStages,
  agentWorkflows,
  agentUpdates,
  agents,
  auditEvents,
  capabilityGrants,
  connectionAuthorizationReturns,
  connectionLinkRequests,
  connections,
  controlPlane,
  controlPlaneMigrations,
  fleetConfigurationRevisions,
  fleetConfigurations,
  fleetConfigurationUpdates,
  integrationUsageEvents,
  integrationEnablementRequests,
  runAdmissions,
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
