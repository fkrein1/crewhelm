PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtime_tool_executions` (
	`tool_call_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`input_digest` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`output_bytes` integer,
	`expires_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`dispatched_at` integer,
	`completed_at` integer,
	`cleanup_at` integer,
	`cleanup_retry_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_tool_executions_action_digest_length" CHECK(length("__new_runtime_tool_executions"."action_digest") = 64),
	CONSTRAINT "runtime_tool_executions_input_digest_length" CHECK(length("__new_runtime_tool_executions"."input_digest") = 64),
	CONSTRAINT "runtime_tool_executions_nonce_digest_length" CHECK(length("__new_runtime_tool_executions"."nonce_digest") = 43),
	CONSTRAINT "runtime_tool_executions_status" CHECK("__new_runtime_tool_executions"."status" IN ('reserved', 'completed', 'failed', 'unknown')),
	CONSTRAINT "runtime_tool_executions_output_nonnegative" CHECK("__new_runtime_tool_executions"."output_bytes" IS NULL OR "__new_runtime_tool_executions"."output_bytes" >= 0),
	CONSTRAINT "runtime_tool_executions_started_at_positive" CHECK("__new_runtime_tool_executions"."started_at" > 0),
	CONSTRAINT "runtime_tool_executions_dispatched_at_positive" CHECK("__new_runtime_tool_executions"."dispatched_at" IS NULL OR "__new_runtime_tool_executions"."dispatched_at" > 0),
	CONSTRAINT "runtime_tool_executions_dispatch_after_start" CHECK("__new_runtime_tool_executions"."dispatched_at" IS NULL OR "__new_runtime_tool_executions"."dispatched_at" >= "__new_runtime_tool_executions"."started_at"),
	CONSTRAINT "runtime_tool_executions_expiry_after_start" CHECK("__new_runtime_tool_executions"."expires_at" > "__new_runtime_tool_executions"."started_at"),
	CONSTRAINT "runtime_tool_executions_completion_after_dispatch" CHECK("__new_runtime_tool_executions"."completed_at" IS NULL
        OR "__new_runtime_tool_executions"."dispatched_at" IS NULL
        OR "__new_runtime_tool_executions"."completed_at" >= "__new_runtime_tool_executions"."dispatched_at"),
	CONSTRAINT "runtime_tool_executions_cleanup_retry_positive" CHECK("__new_runtime_tool_executions"."cleanup_retry_at" > 0),
	CONSTRAINT "runtime_tool_executions_cleanup_after_start" CHECK("__new_runtime_tool_executions"."cleanup_at" IS NULL OR "__new_runtime_tool_executions"."cleanup_at" >= "__new_runtime_tool_executions"."started_at"),
	CONSTRAINT "runtime_tool_executions_state" CHECK((
        ("__new_runtime_tool_executions"."status" = 'reserved'
          AND "__new_runtime_tool_executions"."output_bytes" IS NULL
          AND "__new_runtime_tool_executions"."completed_at" IS NULL)
        OR ("__new_runtime_tool_executions"."status" IN ('completed', 'failed', 'unknown')
          AND "__new_runtime_tool_executions"."output_bytes" IS NOT NULL
          AND "__new_runtime_tool_executions"."completed_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
INSERT INTO `__new_runtime_tool_executions`("tool_call_id", "run_id", "tool_id", "action_digest", "input_digest", "nonce_digest", "status", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at", "cleanup_at", "cleanup_retry_at") SELECT "tool_call_id", "run_id", "tool_id", "action_digest", "input_digest", "nonce_digest", "status", "output_bytes", "expires_at", "started_at", "dispatched_at", "completed_at", NULL, "expires_at" + 30000 FROM `runtime_tool_executions`;--> statement-breakpoint
DROP TABLE `runtime_tool_executions`;--> statement-breakpoint
ALTER TABLE `__new_runtime_tool_executions` RENAME TO `runtime_tool_executions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_run` ON `runtime_tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_expiry` ON `runtime_tool_executions` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_run_input` ON `runtime_tool_executions` (`run_id`,`tool_id`,`input_digest`);
