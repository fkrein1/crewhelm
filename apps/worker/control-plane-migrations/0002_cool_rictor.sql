CREATE TABLE `capability_grants` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`connection_id` text NOT NULL,
	`grant` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "capability_grants_agent_revision_positive" CHECK("capability_grants"."agent_revision" > 0),
	CONSTRAINT "capability_grants_grant_json" CHECK(json_valid("capability_grants"."grant")),
	CONSTRAINT "capability_grants_status" CHECK("capability_grants"."status" IN ('active', 'revoked')),
	CONSTRAINT "capability_grants_created_at_positive" CHECK("capability_grants"."created_at" > 0),
	CONSTRAINT "capability_grants_state" CHECK((
        ("capability_grants"."status" = 'active' AND "capability_grants"."revoked_at" IS NULL)
        OR ("capability_grants"."status" = 'revoked'
          AND "capability_grants"."revoked_at" IS NOT NULL
          AND "capability_grants"."revoked_at" >= "capability_grants"."created_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `capability_grants_agent_revision` ON `capability_grants` (`agent_id`,`agent_revision`);--> statement-breakpoint
CREATE INDEX `capability_grants_connection` ON `capability_grants` (`connection_id`);--> statement-breakpoint
CREATE TABLE `tool_approvals` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`client_id` text NOT NULL,
	`decision` text NOT NULL,
	`expires_at` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_approvals_action_digest_length" CHECK(length("tool_approvals"."action_digest") = 64),
	CONSTRAINT "tool_approvals_decision" CHECK("tool_approvals"."decision" IN ('approved', 'rejected')),
	CONSTRAINT "tool_approvals_requested_at_positive" CHECK("tool_approvals"."requested_at" > 0),
	CONSTRAINT "tool_approvals_decided_after_request" CHECK("tool_approvals"."decided_at" >= "tool_approvals"."requested_at"),
	CONSTRAINT "tool_approvals_expiry_after_decision" CHECK("tool_approvals"."expires_at" > "tool_approvals"."decided_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_approvals_tool_call_id_unique` ON `tool_approvals` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `tool_approvals_run` ON `tool_approvals` (`run_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `tool_executions` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`grant_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`cost_microusd` integer NOT NULL,
	`output_bytes` integer,
	`expires_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `capability_grants`(`grant_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_executions_action_digest_length" CHECK(length("tool_executions"."action_digest") = 64),
	CONSTRAINT "tool_executions_nonce_digest_length" CHECK(length("tool_executions"."nonce_digest") = 43),
	CONSTRAINT "tool_executions_status" CHECK("tool_executions"."status" IN ('reserved', 'completed', 'failed', 'unknown')),
	CONSTRAINT "tool_executions_cost_nonnegative" CHECK("tool_executions"."cost_microusd" >= 0),
	CONSTRAINT "tool_executions_output_nonnegative" CHECK("tool_executions"."output_bytes" IS NULL OR "tool_executions"."output_bytes" >= 0),
	CONSTRAINT "tool_executions_started_at_positive" CHECK("tool_executions"."started_at" > 0),
	CONSTRAINT "tool_executions_expiry_after_start" CHECK("tool_executions"."expires_at" > "tool_executions"."started_at"),
	CONSTRAINT "tool_executions_state" CHECK((
        ("tool_executions"."status" = 'reserved'
          AND "tool_executions"."output_bytes" IS NULL
          AND "tool_executions"."completed_at" IS NULL)
        OR ("tool_executions"."status" IN ('completed', 'failed', 'unknown')
          AND "tool_executions"."output_bytes" IS NOT NULL
          AND "tool_executions"."completed_at" IS NOT NULL
          AND "tool_executions"."completed_at" >= "tool_executions"."started_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `tool_executions_run` ON `tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_grant_status` ON `tool_executions` (`grant_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`instructions` text NOT NULL,
	`execution_limits` text NOT NULL,
	`capability_grants` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_positive" CHECK("__new_agent_revisions"."revision" > 0),
	CONSTRAINT "agent_revisions_capability_grants_json" CHECK(json_valid("__new_agent_revisions"."capability_grants")),
	CONSTRAINT "agent_revisions_created_at_positive" CHECK("__new_agent_revisions"."created_at" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_revisions`("agent_id", "revision", "name", "model", "instructions", "execution_limits", "capability_grants", "created_at") SELECT "agent_id", "revision", "name", "model", "instructions", "execution_limits", "capability_grants", "created_at" FROM `agent_revisions`;--> statement-breakpoint
DROP TABLE `agent_revisions`;--> statement-breakpoint
ALTER TABLE `__new_agent_revisions` RENAME TO `agent_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "connections_provider_composio" CHECK("__new_connections"."provider" = 'composio'),
	CONSTRAINT "connections_status" CHECK("__new_connections"."status" IN ('initiated', 'active', 'revoked', 'unavailable')),
	CONSTRAINT "connections_created_at_positive" CHECK("__new_connections"."created_at" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_connections`("connection_id", "provider", "provider_connection_id", "auth_config_id", "status", "created_at") SELECT "connection_id", "provider", "provider_connection_id", "auth_config_id", "status", "created_at" FROM `connections`;--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_connection_id_unique` ON `connections` (`provider_connection_id`);--> statement-breakpoint
CREATE TABLE `__new_run_admissions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`prompt_digest` text NOT NULL,
	`budget_reservation` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`cleanup_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`redeemed_at` integer,
	`model_call_consumed_at` integer,
	`model_calls_consumed` integer DEFAULT 0 NOT NULL,
	`tool_calls_consumed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_admissions_request_digest_length" CHECK(length("__new_run_admissions"."request_digest") = 43),
	CONSTRAINT "run_admissions_agent_revision_positive" CHECK("__new_run_admissions"."agent_revision" > 0),
	CONSTRAINT "run_admissions_prompt_digest_length" CHECK(length("__new_run_admissions"."prompt_digest") = 64),
	CONSTRAINT "run_admissions_nonce_digest_length" CHECK(length("__new_run_admissions"."nonce_digest") = 43),
	CONSTRAINT "run_admissions_status" CHECK("__new_run_admissions"."status" IN ('issued', 'redeemed', 'expired')),
	CONSTRAINT "run_admissions_expires_at_positive" CHECK("__new_run_admissions"."expires_at" > 0),
	CONSTRAINT "run_admissions_cleanup_after_expiry" CHECK("__new_run_admissions"."cleanup_at" > "__new_run_admissions"."expires_at"),
	CONSTRAINT "run_admissions_created_at_positive" CHECK("__new_run_admissions"."created_at" > 0),
	CONSTRAINT "run_admissions_model_call_consumed_at_positive" CHECK("__new_run_admissions"."model_call_consumed_at" IS NULL OR "__new_run_admissions"."model_call_consumed_at" > 0),
	CONSTRAINT "run_admissions_model_calls_consumed" CHECK("__new_run_admissions"."model_calls_consumed" >= 0),
	CONSTRAINT "run_admissions_tool_calls_consumed" CHECK("__new_run_admissions"."tool_calls_consumed" >= 0),
	CONSTRAINT "run_admissions_state" CHECK((
        ("__new_run_admissions"."status" = 'issued'
          AND "__new_run_admissions"."redeemed_at" IS NULL
          AND "__new_run_admissions"."model_call_consumed_at" IS NULL
          AND "__new_run_admissions"."model_calls_consumed" = 0)
        OR ("__new_run_admissions"."status" = 'redeemed'
          AND "__new_run_admissions"."redeemed_at" IS NOT NULL
          AND "__new_run_admissions"."model_calls_consumed" <= json_extract(
            "__new_run_admissions"."budget_reservation",
            '$.maxModelCalls'
          )
          AND (("__new_run_admissions"."model_calls_consumed" = 0 AND "__new_run_admissions"."model_call_consumed_at" IS NULL)
            OR ("__new_run_admissions"."model_calls_consumed" > 0
              AND "__new_run_admissions"."model_call_consumed_at" >= "__new_run_admissions"."redeemed_at")))
        OR ("__new_run_admissions"."status" = 'expired'
          AND "__new_run_admissions"."redeemed_at" IS NULL
          AND "__new_run_admissions"."model_call_consumed_at" IS NULL
          AND "__new_run_admissions"."model_calls_consumed" = 0)
      ))
);
--> statement-breakpoint
INSERT INTO `__new_run_admissions`("client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed") SELECT "client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", json_set("budget_reservation", '$.toolGrants', json('[]')), "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "model_call_consumed_at", CASE WHEN "model_call_consumed_at" IS NULL THEN 0 ELSE 1 END, 0 FROM `run_admissions`;--> statement-breakpoint
DROP TABLE `run_admissions`;--> statement-breakpoint
ALTER TABLE `__new_run_admissions` RENAME TO `run_admissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';
