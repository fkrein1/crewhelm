CREATE TABLE `runtime_tool_executions` (
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
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "runtime_tool_executions_action_digest_length" CHECK(length("runtime_tool_executions"."action_digest") = 64),
	CONSTRAINT "runtime_tool_executions_input_digest_length" CHECK(length("runtime_tool_executions"."input_digest") = 64),
	CONSTRAINT "runtime_tool_executions_nonce_digest_length" CHECK(length("runtime_tool_executions"."nonce_digest") = 43),
	CONSTRAINT "runtime_tool_executions_status" CHECK("runtime_tool_executions"."status" IN ('reserved', 'completed', 'failed', 'unknown')),
	CONSTRAINT "runtime_tool_executions_output_nonnegative" CHECK("runtime_tool_executions"."output_bytes" IS NULL OR "runtime_tool_executions"."output_bytes" >= 0),
	CONSTRAINT "runtime_tool_executions_started_at_positive" CHECK("runtime_tool_executions"."started_at" > 0),
	CONSTRAINT "runtime_tool_executions_dispatched_at_positive" CHECK("runtime_tool_executions"."dispatched_at" IS NULL OR "runtime_tool_executions"."dispatched_at" > 0),
	CONSTRAINT "runtime_tool_executions_dispatch_after_start" CHECK("runtime_tool_executions"."dispatched_at" IS NULL OR "runtime_tool_executions"."dispatched_at" >= "runtime_tool_executions"."started_at"),
	CONSTRAINT "runtime_tool_executions_expiry_after_start" CHECK("runtime_tool_executions"."expires_at" > "runtime_tool_executions"."started_at"),
	CONSTRAINT "runtime_tool_executions_completion_after_dispatch" CHECK("runtime_tool_executions"."completed_at" IS NULL
        OR "runtime_tool_executions"."dispatched_at" IS NULL
        OR "runtime_tool_executions"."completed_at" >= "runtime_tool_executions"."dispatched_at"),
	CONSTRAINT "runtime_tool_executions_state" CHECK((
        ("runtime_tool_executions"."status" = 'reserved'
          AND "runtime_tool_executions"."output_bytes" IS NULL
          AND "runtime_tool_executions"."completed_at" IS NULL)
        OR ("runtime_tool_executions"."status" IN ('completed', 'failed', 'unknown')
          AND "runtime_tool_executions"."output_bytes" IS NOT NULL
          AND "runtime_tool_executions"."completed_at" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_run` ON `runtime_tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_expiry` ON `runtime_tool_executions` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `runtime_tool_executions_run_input` ON `runtime_tool_executions` (`run_id`,`tool_id`,`input_digest`);