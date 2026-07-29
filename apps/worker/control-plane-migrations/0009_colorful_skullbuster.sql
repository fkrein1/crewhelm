CREATE TABLE `ai_gateway_calls` (
	`gateway_log_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`cost_microusd` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`recorded_at` integer NOT NULL,
	`settled_at` integer,
	`next_reconciliation_at` integer NOT NULL,
	`reconciliation_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_gateway_calls_status" CHECK("ai_gateway_calls"."status" IN ('pending', 'settled')),
	CONSTRAINT "ai_gateway_calls_cost_nonnegative" CHECK("ai_gateway_calls"."cost_microusd" IS NULL OR "ai_gateway_calls"."cost_microusd" >= 0),
	CONSTRAINT "ai_gateway_calls_tokens_nonnegative" CHECK(("ai_gateway_calls"."input_tokens" IS NULL OR "ai_gateway_calls"."input_tokens" >= 0)
        AND ("ai_gateway_calls"."output_tokens" IS NULL OR "ai_gateway_calls"."output_tokens" >= 0)),
	CONSTRAINT "ai_gateway_calls_recorded_at_positive" CHECK("ai_gateway_calls"."recorded_at" > 0),
	CONSTRAINT "ai_gateway_calls_settlement_state" CHECK((("ai_gateway_calls"."status" = 'pending'
          AND "ai_gateway_calls"."cost_microusd" IS NULL
          AND "ai_gateway_calls"."settled_at" IS NULL)
        OR ("ai_gateway_calls"."status" = 'settled'
          AND "ai_gateway_calls"."cost_microusd" IS NOT NULL
          AND "ai_gateway_calls"."settled_at" IS NOT NULL
          AND "ai_gateway_calls"."settled_at" >= "ai_gateway_calls"."recorded_at"))),
	CONSTRAINT "ai_gateway_calls_reconciliation_positive" CHECK("ai_gateway_calls"."next_reconciliation_at" > 0 AND "ai_gateway_calls"."reconciliation_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `ai_gateway_calls_run` ON `ai_gateway_calls` (`run_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `ai_gateway_calls_reconciliation` ON `ai_gateway_calls` (`next_reconciliation_at`) WHERE "ai_gateway_calls"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `fleet_configuration_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`configuration` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "fleet_configuration_revisions_revision_positive" CHECK("fleet_configuration_revisions"."revision" > 0),
	CONSTRAINT "fleet_configuration_revisions_configuration_json" CHECK(json_valid("fleet_configuration_revisions"."configuration")),
	CONSTRAINT "fleet_configuration_revisions_created_at_positive" CHECK("fleet_configuration_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `fleet_configuration_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`revision`) REFERENCES `fleet_configuration_revisions`(`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "fleet_configuration_updates_request_digest_length" CHECK(length("fleet_configuration_updates"."request_digest") = 43),
	CONSTRAINT "fleet_configuration_updates_revision_positive" CHECK("fleet_configuration_updates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fleet_configuration_updates_revision` ON `fleet_configuration_updates` (`revision`);--> statement-breakpoint
CREATE TABLE `fleet_configurations` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	CONSTRAINT "fleet_configurations_singleton" CHECK("fleet_configurations"."singleton" = 1),
	CONSTRAINT "fleet_configurations_current_revision_positive" CHECK("fleet_configurations"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `integration_usage_events` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	CONSTRAINT "integration_usage_events_recorded_at_positive" CHECK("integration_usage_events"."recorded_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `integration_usage_events_recorded_at` ON `integration_usage_events` (`recorded_at`);--> statement-breakpoint
CREATE INDEX `integration_usage_events_agent` ON `integration_usage_events` (`agent_id`,`recorded_at`);--> statement-breakpoint
UPDATE `run_admissions`
SET `budget_reservation` = json_set(
	`budget_reservation`,
	'$.aiSpendReservationMicrousd', 50000,
	'$.fleetConfigurationRevision', 1,
	'$.integrationLimits', json('{"callsPerDay":300,"callsPerThirtyDays":8000,"duplicateToolCallLimit":2,"maxCallsPerRun":8,"maxCallsPerToolPerRun":2,"maxConcurrencyPerGrant":1}')
)
WHERE json_type(`budget_reservation`, '$.aiSpendReservationMicrousd') IS NULL
	OR json_type(`budget_reservation`, '$.fleetConfigurationRevision') IS NULL
	OR json_type(`budget_reservation`, '$.integrationLimits') IS NULL;
--> statement-breakpoint
ALTER TABLE `tool_executions` ADD `input_digest` text;
--> statement-breakpoint
UPDATE `tool_executions`
SET `input_digest` = '0000000000000000000000000000000000000000000000000000000000000000'
WHERE `input_digest` IS NULL;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tool_executions` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`effect_digest` text NOT NULL,
	`input_digest` text NOT NULL,
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
	CONSTRAINT "tool_executions_input_digest_length" CHECK(length("__new_tool_executions"."input_digest") = 64),
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
INSERT INTO `__new_tool_executions`("tool_call_id", "run_id", "grant_id", "action_digest", "effect_digest", "input_digest", "nonce_digest", "status", "cost_microusd", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at", "reconciliation", "reconciled_at") SELECT "tool_call_id", "run_id", "grant_id", "action_digest", "effect_digest", "input_digest", "nonce_digest", "status", "cost_microusd", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at", "reconciliation", "reconciled_at" FROM `tool_executions`;--> statement-breakpoint
DROP TABLE `tool_executions`;--> statement-breakpoint
ALTER TABLE `__new_tool_executions` RENAME TO `tool_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tool_executions_run` ON `tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_grant_status` ON `tool_executions` (`grant_id`,`status`);--> statement-breakpoint
CREATE INDEX `tool_executions_effect_status` ON `tool_executions` (`effect_digest`,`status`);--> statement-breakpoint
CREATE INDEX `tool_executions_started_at` ON `tool_executions` (`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_run_input` ON `tool_executions` (`run_id`,`grant_id`,`input_digest`);
