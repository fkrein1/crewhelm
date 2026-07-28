PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "agents_current_revision_positive" CHECK("__new_agents"."current_revision" > 0),
	CONSTRAINT "agents_status" CHECK("__new_agents"."status" IN ('active', 'disabled')),
	CONSTRAINT "agents_created_at_positive" CHECK("__new_agents"."created_at" > 0),
	CONSTRAINT "agents_state" CHECK((
        ("__new_agents"."status" = 'active' AND "__new_agents"."disabled_at" IS NULL)
        OR ("__new_agents"."status" = 'disabled'
          AND "__new_agents"."disabled_at" IS NOT NULL
          AND "__new_agents"."disabled_at" >= "__new_agents"."created_at")
      ))
);
--> statement-breakpoint
INSERT INTO `__new_agents`("agent_id", "current_revision", "status", "created_at", "disabled_at")
SELECT "agent_id", "current_revision", 'active', "created_at", NULL FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "connections_provider_composio" CHECK("__new_connections"."provider" = 'composio'),
	CONSTRAINT "connections_status" CHECK("__new_connections"."status" IN ('initiated', 'active', 'revoked', 'unavailable')),
	CONSTRAINT "connections_created_at_positive" CHECK("__new_connections"."created_at" > 0),
	CONSTRAINT "connections_revocation_state" CHECK((
        ("__new_connections"."status" = 'revoked'
          AND "__new_connections"."revoked_at" IS NOT NULL
          AND "__new_connections"."revoked_at" >= "__new_connections"."created_at")
        OR ("__new_connections"."status" != 'revoked' AND "__new_connections"."revoked_at" IS NULL)
      ))
);
--> statement-breakpoint
INSERT INTO `__new_connections`("connection_id", "provider", "provider_connection_id", "auth_config_id", "status", "created_at", "revoked_at")
SELECT "connection_id", "provider", "provider_connection_id", "auth_config_id", "status", "created_at",
	CASE WHEN "status" = 'revoked' THEN "created_at" ELSE NULL END
FROM `connections`;--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_connection_id_unique` ON `connections` (`provider_connection_id`);--> statement-breakpoint
ALTER TABLE `tool_approvals` ADD `grant_id` text REFERENCES capability_grants(grant_id);--> statement-breakpoint
CREATE TABLE `__new_tool_executions` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`effect_digest` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`cost_microusd` integer NOT NULL,
	`output_bytes` integer,
	`expires_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`dispatched_at` integer,
	`completed_at` integer,
	`reconciliation` text,
	`reconciled_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `capability_grants`(`grant_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_executions_action_digest_length" CHECK(length("__new_tool_executions"."action_digest") = 64),
	CONSTRAINT "tool_executions_effect_digest_length" CHECK(length("__new_tool_executions"."effect_digest") = 64),
	CONSTRAINT "tool_executions_nonce_digest_length" CHECK(length("__new_tool_executions"."nonce_digest") = 43),
	CONSTRAINT "tool_executions_status" CHECK("__new_tool_executions"."status" IN ('reserved', 'completed', 'failed', 'unknown')),
	CONSTRAINT "tool_executions_cost_nonnegative" CHECK("__new_tool_executions"."cost_microusd" >= 0),
	CONSTRAINT "tool_executions_output_nonnegative" CHECK("__new_tool_executions"."output_bytes" IS NULL OR "__new_tool_executions"."output_bytes" >= 0),
	CONSTRAINT "tool_executions_started_at_positive" CHECK("__new_tool_executions"."started_at" > 0),
	CONSTRAINT "tool_executions_dispatched_at_positive" CHECK("__new_tool_executions"."dispatched_at" IS NULL OR "__new_tool_executions"."dispatched_at" > 0),
	CONSTRAINT "tool_executions_dispatch_after_start" CHECK("__new_tool_executions"."dispatched_at" IS NULL OR "__new_tool_executions"."dispatched_at" >= "__new_tool_executions"."started_at"),
	CONSTRAINT "tool_executions_expiry_after_start" CHECK("__new_tool_executions"."expires_at" > "__new_tool_executions"."started_at"),
	CONSTRAINT "tool_executions_completion_after_dispatch" CHECK("__new_tool_executions"."completed_at" IS NULL
        OR "__new_tool_executions"."dispatched_at" IS NULL
        OR "__new_tool_executions"."completed_at" >= "__new_tool_executions"."dispatched_at"),
	CONSTRAINT "tool_executions_reconciliation" CHECK("__new_tool_executions"."reconciliation" IS NULL
        OR "__new_tool_executions"."reconciliation" IN ('applied', 'not_applied')),
	CONSTRAINT "tool_executions_reconciliation_state" CHECK((
        ("__new_tool_executions"."reconciliation" IS NULL AND "__new_tool_executions"."reconciled_at" IS NULL)
        OR ("__new_tool_executions"."reconciliation" = 'applied'
          AND "__new_tool_executions"."status" = 'completed'
          AND "__new_tool_executions"."reconciled_at" IS NOT NULL
          AND "__new_tool_executions"."completed_at" IS NOT NULL
          AND "__new_tool_executions"."reconciled_at" >= "__new_tool_executions"."completed_at")
        OR ("__new_tool_executions"."reconciliation" = 'not_applied'
          AND "__new_tool_executions"."status" = 'failed'
          AND "__new_tool_executions"."reconciled_at" IS NOT NULL
          AND "__new_tool_executions"."completed_at" IS NOT NULL
          AND "__new_tool_executions"."reconciled_at" >= "__new_tool_executions"."completed_at")
      )),
	CONSTRAINT "tool_executions_state" CHECK((
        ("__new_tool_executions"."status" = 'reserved'
          AND "__new_tool_executions"."output_bytes" IS NULL
          AND "__new_tool_executions"."completed_at" IS NULL)
        OR ("__new_tool_executions"."status" = 'completed'
          AND "__new_tool_executions"."dispatched_at" IS NOT NULL
          AND "__new_tool_executions"."output_bytes" IS NOT NULL
          AND "__new_tool_executions"."completed_at" IS NOT NULL
          AND "__new_tool_executions"."completed_at" >= "__new_tool_executions"."started_at")
        OR ("__new_tool_executions"."status" IN ('failed', 'unknown')
          AND "__new_tool_executions"."output_bytes" IS NOT NULL
          AND "__new_tool_executions"."completed_at" IS NOT NULL
          AND "__new_tool_executions"."completed_at" >= "__new_tool_executions"."started_at")
      ))
);
--> statement-breakpoint
INSERT INTO `__new_tool_executions`("tool_call_id", "run_id", "grant_id", "action_digest", "effect_digest", "nonce_digest", "status", "cost_microusd", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at", "reconciliation", "reconciled_at")
SELECT "tool_call_id", "run_id", "grant_id", "action_digest",
	CASE WHEN "status" = 'unknown'
		THEN '0000000000000000000000000000000000000000000000000000000000000000'
		ELSE "action_digest"
	END,
	"nonce_digest", "status",
	"cost_microusd", "output_bytes", "expires_at", "started_at", "dispatched_at",
	"completed_at", NULL, NULL
FROM `tool_executions`;--> statement-breakpoint
DROP TABLE `tool_executions`;--> statement-breakpoint
ALTER TABLE `__new_tool_executions` RENAME TO `tool_executions`;--> statement-breakpoint
CREATE INDEX `tool_executions_run` ON `tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_grant_status` ON `tool_executions` (`grant_id`,`status`);--> statement-breakpoint
CREATE INDEX `tool_executions_effect_status` ON `tool_executions` (`effect_digest`,`status`);
