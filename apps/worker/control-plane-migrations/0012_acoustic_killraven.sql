CREATE TABLE `agent_inbox_acknowledgements` (
	`item_id` text NOT NULL,
	`version` text NOT NULL,
	`acknowledged_at` integer NOT NULL,
	`cleanup_at` integer NOT NULL,
	`client_id` text NOT NULL,
	PRIMARY KEY(`item_id`, `version`),
	CONSTRAINT "agent_inbox_acknowledgements_acknowledged_at" CHECK("agent_inbox_acknowledgements"."acknowledged_at" > 0),
	CONSTRAINT "agent_inbox_acknowledgements_cleanup_after_acknowledgement" CHECK("agent_inbox_acknowledgements"."cleanup_at" > "agent_inbox_acknowledgements"."acknowledged_at")
);
--> statement-breakpoint
CREATE INDEX `agent_inbox_acknowledgements_cleanup` ON `agent_inbox_acknowledgements` (`cleanup_at`);--> statement-breakpoint
CREATE TABLE `agent_inbox_items` (
	`item_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`fleet_revision` integer NOT NULL,
	`schedule_revision` integer,
	`run_id` text,
	`trigger` text,
	`run_status` text,
	`kind` text NOT NULL,
	`approval_count` integer DEFAULT 0 NOT NULL,
	`request_preview` text NOT NULL,
	`result_preview` text,
	`reason` text,
	`scheduled_at` integer,
	`retry_at` integer,
	`occurred_at` integer NOT NULL,
	`version` text NOT NULL,
	`cleanup_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_inbox_items_agent_revision" CHECK("agent_inbox_items"."agent_revision" > 0),
	CONSTRAINT "agent_inbox_items_fleet_revision" CHECK("agent_inbox_items"."fleet_revision" > 0),
	CONSTRAINT "agent_inbox_items_schedule_revision" CHECK("agent_inbox_items"."schedule_revision" IS NULL OR "agent_inbox_items"."schedule_revision" > 0),
	CONSTRAINT "agent_inbox_items_kind" CHECK("agent_inbox_items"."kind" IN ('action_required', 'deferred', 'exception', 'outcome')),
	CONSTRAINT "agent_inbox_items_approval_count" CHECK("agent_inbox_items"."approval_count" BETWEEN 0 AND 100),
	CONSTRAINT "agent_inbox_items_request_preview" CHECK(length("agent_inbox_items"."request_preview") BETWEEN 1 AND 240),
	CONSTRAINT "agent_inbox_items_result_preview" CHECK("agent_inbox_items"."result_preview" IS NULL OR length("agent_inbox_items"."result_preview") BETWEEN 1 AND 240),
	CONSTRAINT "agent_inbox_items_reason" CHECK("agent_inbox_items"."reason" IS NULL OR "agent_inbox_items"."reason" IN (
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
      )),
	CONSTRAINT "agent_inbox_items_shape" CHECK((
        ("agent_inbox_items"."kind" = 'deferred'
          AND "agent_inbox_items"."run_id" IS NULL
          AND "agent_inbox_items"."trigger" IS NULL
          AND "agent_inbox_items"."run_status" IS NULL
          AND "agent_inbox_items"."schedule_revision" IS NOT NULL
          AND "agent_inbox_items"."reason" IS NOT NULL
          AND "agent_inbox_items"."scheduled_at" IS NOT NULL
          AND "agent_inbox_items"."approval_count" = 0
          AND "agent_inbox_items"."result_preview" IS NULL)
        OR
        ("agent_inbox_items"."kind" <> 'deferred'
          AND "agent_inbox_items"."run_id" IS NOT NULL
          AND "agent_inbox_items"."trigger" IS NOT NULL
          AND "agent_inbox_items"."run_status" IS NOT NULL
          AND "agent_inbox_items"."schedule_revision" IS NULL
          AND "agent_inbox_items"."reason" IS NULL
          AND "agent_inbox_items"."scheduled_at" IS NULL
          AND "agent_inbox_items"."retry_at" IS NULL
          AND (("agent_inbox_items"."kind" = 'action_required' AND "agent_inbox_items"."approval_count" > 0)
            OR ("agent_inbox_items"."kind" <> 'action_required' AND "agent_inbox_items"."approval_count" = 0))
          AND (("agent_inbox_items"."kind" = 'action_required' AND "agent_inbox_items"."run_status" = 'running')
            OR ("agent_inbox_items"."kind" = 'exception' AND "agent_inbox_items"."run_status" = 'failed')
            OR ("agent_inbox_items"."kind" = 'outcome'
              AND "agent_inbox_items"."run_status" IN ('cancelled', 'completed'))))
      )),
	CONSTRAINT "agent_inbox_items_scheduled_at" CHECK("agent_inbox_items"."scheduled_at" IS NULL OR "agent_inbox_items"."scheduled_at" > 0),
	CONSTRAINT "agent_inbox_items_retry_at" CHECK("agent_inbox_items"."retry_at" IS NULL OR "agent_inbox_items"."retry_at" > "agent_inbox_items"."scheduled_at"),
	CONSTRAINT "agent_inbox_items_occurred_at" CHECK("agent_inbox_items"."occurred_at" > 0),
	CONSTRAINT "agent_inbox_items_cleanup_after_occurrence" CHECK("agent_inbox_items"."cleanup_at" > "agent_inbox_items"."occurred_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_items_run` ON `agent_inbox_items` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_items_schedule_occurrence` ON `agent_inbox_items` (`agent_id`,`schedule_revision`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_agent_occurred` ON `agent_inbox_items` (`agent_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_cleanup` ON `agent_inbox_items` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_kind_occurred` ON `agent_inbox_items` (`kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_occurred` ON `agent_inbox_items` (`occurred_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run_admissions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`prompt` text,
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
	CONSTRAINT "run_admissions_prompt_length" CHECK("__new_run_admissions"."prompt" IS NULL OR length("__new_run_admissions"."prompt") BETWEEN 1 AND 16384),
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
INSERT INTO `__new_run_admissions`("client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt", "prompt_digest", "trigger", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed") SELECT "client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", NULL, "prompt_digest", "trigger", "budget_reservation", "nonce_digest", "status", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed" FROM `run_admissions`;--> statement-breakpoint
DROP TABLE `run_admissions`;--> statement-breakpoint
ALTER TABLE `__new_run_admissions` RENAME TO `run_admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';
