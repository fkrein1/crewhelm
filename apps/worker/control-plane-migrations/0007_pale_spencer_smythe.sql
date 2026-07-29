CREATE TABLE `agent_schedule_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`agent_revision` integer NOT NULL,
	`configuration` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedule_revisions_revision_positive" CHECK("agent_schedule_revisions"."revision" > 0),
	CONSTRAINT "agent_schedule_revisions_agent_revision_positive" CHECK("agent_schedule_revisions"."agent_revision" > 0),
	CONSTRAINT "agent_schedule_revisions_configuration_json" CHECK("agent_schedule_revisions"."configuration" IS NULL OR json_valid("agent_schedule_revisions"."configuration")),
	CONSTRAINT "agent_schedule_revisions_created_at_positive" CHECK("agent_schedule_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_schedule_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`agent_id`,`revision`) REFERENCES `agent_schedule_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedule_updates_request_digest_length" CHECK(length("agent_schedule_updates"."request_digest") = 43),
	CONSTRAINT "agent_schedule_updates_revision_positive" CHECK("agent_schedule_updates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_schedule_updates_agent_revision` ON `agent_schedule_updates` (`agent_id`,`revision`);--> statement-breakpoint
CREATE TABLE `agent_schedules` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`status` text NOT NULL,
	`next_run_at` integer,
	`last_run_id` text,
	`last_dispatched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_id`,`current_revision`) REFERENCES `agent_schedule_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedules_current_revision_positive" CHECK("agent_schedules"."current_revision" > 0),
	CONSTRAINT "agent_schedules_status" CHECK("agent_schedules"."status" IN ('active', 'paused')),
	CONSTRAINT "agent_schedules_created_at_positive" CHECK("agent_schedules"."created_at" > 0),
	CONSTRAINT "agent_schedules_dispatch_state" CHECK((("agent_schedules"."last_run_id" IS NULL AND "agent_schedules"."last_dispatched_at" IS NULL)
        OR ("agent_schedules"."last_run_id" IS NOT NULL
          AND "agent_schedules"."last_dispatched_at" IS NOT NULL
          AND "agent_schedules"."last_dispatched_at" >= "agent_schedules"."created_at"))),
	CONSTRAINT "agent_schedules_state" CHECK((("agent_schedules"."status" = 'active' AND "agent_schedules"."next_run_at" IS NOT NULL)
        OR ("agent_schedules"."status" = 'paused' AND "agent_schedules"."next_run_at" IS NULL)))
);
--> statement-breakpoint
CREATE INDEX `agent_schedules_due` ON `agent_schedules` (`next_run_at`) WHERE "agent_schedules"."status" = 'active';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run_admissions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`prompt_digest` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
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
	CONSTRAINT "run_admissions_trigger" CHECK("__new_run_admissions"."trigger" IN ('manual', 'schedule')),
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
INSERT INTO `__new_run_admissions`("client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", "trigger", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed") SELECT "client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt_digest", 'manual', "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed" FROM `run_admissions`;--> statement-breakpoint
DROP TABLE `run_admissions`;--> statement-breakpoint
ALTER TABLE `__new_run_admissions` RENAME TO `run_admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';
