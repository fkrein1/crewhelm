PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tool_executions` (
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
	`dispatched_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `capability_grants`(`grant_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_executions_action_digest_length" CHECK(length("__new_tool_executions"."action_digest") = 64),
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
INSERT INTO `__new_tool_executions`("tool_call_id", "run_id", "grant_id", "action_digest", "nonce_digest", "status", "cost_microusd", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at") SELECT "tool_call_id", "run_id", "grant_id", "action_digest", "nonce_digest", "status", "cost_microusd", "output_bytes", "expires_at", "started_at", CASE WHEN "status" = 'completed' THEN "started_at" ELSE NULL END, "completed_at" FROM `tool_executions`;--> statement-breakpoint
DROP TABLE `tool_executions`;--> statement-breakpoint
ALTER TABLE `__new_tool_executions` RENAME TO `tool_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tool_executions_run` ON `tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_grant_status` ON `tool_executions` (`grant_id`,`status`);--> statement-breakpoint
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
	`cancellation_requested_at` integer,
	`cancelled_at` integer,
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
	CONSTRAINT "run_admissions_cancellation_requested_at_positive" CHECK("__new_run_admissions"."cancellation_requested_at" IS NULL OR "__new_run_admissions"."cancellation_requested_at" > 0),
	CONSTRAINT "run_admissions_cancelled_at_positive" CHECK("__new_run_admissions"."cancelled_at" IS NULL OR "__new_run_admissions"."cancelled_at" > 0),
	CONSTRAINT "run_admissions_cancellation_state" CHECK((
        ("__new_run_admissions"."cancellation_requested_at" IS NULL AND "__new_run_admissions"."cancelled_at" IS NULL)
        OR ("__new_run_admissions"."cancellation_requested_at" IS NOT NULL
          AND "__new_run_admissions"."cancellation_requested_at" >= "__new_run_admissions"."created_at"
          AND ("__new_run_admissions"."cancelled_at" IS NULL
            OR "__new_run_admissions"."cancelled_at" >= "__new_run_admissions"."cancellation_requested_at"))
      )),
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
INSERT INTO `__new_run_admissions`("client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed") SELECT "client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", NULL, NULL, "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed" FROM `run_admissions`;--> statement-breakpoint
DROP TABLE `run_admissions`;--> statement-breakpoint
ALTER TABLE `__new_run_admissions` RENAME TO `run_admissions`;--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';
