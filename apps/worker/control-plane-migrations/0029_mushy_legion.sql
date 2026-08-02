CREATE TABLE `agent_event_trigger_occurrences` (
	`event_trigger_id` text NOT NULL,
	`event_trigger_revision` integer NOT NULL,
	`agent_id` text NOT NULL,
	`event_id` text NOT NULL,
	`event_data` text NOT NULL,
	`scheduled_at` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`next_attempt_at` integer,
	`attempts` integer NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`reason` text,
	PRIMARY KEY(`event_trigger_id`, `event_id`),
	FOREIGN KEY (`event_trigger_id`,`event_trigger_revision`) REFERENCES `agent_event_trigger_revisions`(`event_trigger_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_event_trigger_occurrences_revision_positive" CHECK("agent_event_trigger_occurrences"."event_trigger_revision" > 0),
	CONSTRAINT "agent_event_trigger_occurrences_scheduled_at_positive" CHECK("agent_event_trigger_occurrences"."scheduled_at" > 0),
	CONSTRAINT "agent_event_trigger_occurrences_occurred_at_positive" CHECK("agent_event_trigger_occurrences"."occurred_at" > 0),
	CONSTRAINT "agent_event_trigger_occurrences_attempts_positive" CHECK("agent_event_trigger_occurrences"."attempts" > 0),
	CONSTRAINT "agent_event_trigger_occurrences_event_data_json" CHECK(json_valid("agent_event_trigger_occurrences"."event_data")),
	CONSTRAINT "agent_event_trigger_occurrences_status" CHECK("agent_event_trigger_occurrences"."status" IN ('pending', 'dispatched', 'skipped')),
	CONSTRAINT "agent_event_trigger_occurrences_state" CHECK((
        ("agent_event_trigger_occurrences"."status" = 'pending'
          AND "agent_event_trigger_occurrences"."next_attempt_at" IS NOT NULL
          AND "agent_event_trigger_occurrences"."run_id" IS NULL
          AND "agent_event_trigger_occurrences"."reason" IS NULL)
        OR ("agent_event_trigger_occurrences"."status" = 'dispatched'
          AND "agent_event_trigger_occurrences"."next_attempt_at" IS NULL
          AND "agent_event_trigger_occurrences"."run_id" IS NOT NULL
          AND "agent_event_trigger_occurrences"."reason" IS NULL)
        OR ("agent_event_trigger_occurrences"."status" = 'skipped'
          AND "agent_event_trigger_occurrences"."next_attempt_at" IS NULL
          AND "agent_event_trigger_occurrences"."run_id" IS NULL
          AND "agent_event_trigger_occurrences"."reason" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `agent_event_trigger_occurrences_pending` ON `agent_event_trigger_occurrences` (`next_attempt_at`) WHERE "agent_event_trigger_occurrences"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `agent_event_trigger_occurrences_history` ON `agent_event_trigger_occurrences` (`event_trigger_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `agent_event_trigger_revisions` (
	`event_trigger_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`agent_revision` integer NOT NULL,
	`definition` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`event_trigger_id`, `revision`),
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_event_trigger_revisions_revision_positive" CHECK("agent_event_trigger_revisions"."revision" > 0),
	CONSTRAINT "agent_event_trigger_revisions_agent_revision_positive" CHECK("agent_event_trigger_revisions"."agent_revision" > 0),
	CONSTRAINT "agent_event_trigger_revisions_definition_json" CHECK("agent_event_trigger_revisions"."definition" IS NULL OR json_valid("agent_event_trigger_revisions"."definition")),
	CONSTRAINT "agent_event_trigger_revisions_created_at_positive" CHECK("agent_event_trigger_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_event_trigger_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`action` text NOT NULL,
	`event_trigger_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`event_trigger_id`,`revision`) REFERENCES `agent_event_trigger_revisions`(`event_trigger_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_event_trigger_updates_request_digest_length" CHECK(length("agent_event_trigger_updates"."request_digest") = 43),
	CONSTRAINT "agent_event_trigger_updates_action" CHECK("agent_event_trigger_updates"."action" IN ('create', 'update', 'pause', 'resume', 'delete')),
	CONSTRAINT "agent_event_trigger_updates_revision_positive" CHECK("agent_event_trigger_updates"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_event_triggers` (
	`event_trigger_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`current_revision` integer NOT NULL,
	`connection_id` text NOT NULL,
	`source_slug` text NOT NULL,
	`status` text NOT NULL,
	`provider_trigger_id` text,
	`provider_operation` text NOT NULL,
	`provider_attempts` integer DEFAULT 0 NOT NULL,
	`provider_retry_at` integer,
	`last_run_id` text,
	`last_dispatched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_trigger_id`,`current_revision`) REFERENCES `agent_event_trigger_revisions`(`event_trigger_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_event_triggers_current_revision_positive" CHECK("agent_event_triggers"."current_revision" > 0),
	CONSTRAINT "agent_event_triggers_provider_attempts" CHECK("agent_event_triggers"."provider_attempts" BETWEEN 0 AND 2147483647),
	CONSTRAINT "agent_event_triggers_status" CHECK("agent_event_triggers"."status" IN ('active', 'paused', 'deleted')),
	CONSTRAINT "agent_event_triggers_provider_operation" CHECK("agent_event_triggers"."provider_operation" IN ('stable', 'creating', 'pausing', 'resuming', 'deleting')),
	CONSTRAINT "agent_event_triggers_created_at_positive" CHECK("agent_event_triggers"."created_at" > 0),
	CONSTRAINT "agent_event_triggers_dispatch_state" CHECK((("agent_event_triggers"."last_run_id" IS NULL AND "agent_event_triggers"."last_dispatched_at" IS NULL)
        OR ("agent_event_triggers"."last_run_id" IS NOT NULL
          AND "agent_event_triggers"."last_dispatched_at" IS NOT NULL
          AND "agent_event_triggers"."last_dispatched_at" >= "agent_event_triggers"."created_at"))),
	CONSTRAINT "agent_event_triggers_provider_state" CHECK((
        ("agent_event_triggers"."provider_operation" = 'creating' AND "agent_event_triggers"."provider_trigger_id" IS NULL)
        OR ("agent_event_triggers"."provider_operation" IN ('stable', 'pausing', 'resuming', 'deleting')
          AND ("agent_event_triggers"."status" = 'deleted' OR "agent_event_triggers"."provider_trigger_id" IS NOT NULL))
      )),
	CONSTRAINT "agent_event_triggers_provider_retry_state" CHECK((
        ("agent_event_triggers"."provider_operation" = 'stable'
          AND "agent_event_triggers"."provider_attempts" = 0
          AND "agent_event_triggers"."provider_retry_at" IS NULL)
        OR ("agent_event_triggers"."provider_operation" != 'stable'
          AND "agent_event_triggers"."provider_attempts" BETWEEN 0 AND 4
          AND "agent_event_triggers"."provider_retry_at" IS NOT NULL)
        OR ("agent_event_triggers"."provider_operation" != 'stable'
          AND "agent_event_triggers"."provider_attempts" >= 5
          AND "agent_event_triggers"."provider_retry_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_event_triggers_provider_trigger_id_unique` ON `agent_event_triggers` (`provider_trigger_id`);--> statement-breakpoint
CREATE INDEX `agent_event_triggers_agent` ON `agent_event_triggers` (`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_event_triggers_active_source` ON `agent_event_triggers` (`connection_id`,`source_slug`) WHERE "agent_event_triggers"."status" != 'deleted';--> statement-breakpoint
CREATE INDEX `agent_event_triggers_operation` ON `agent_event_triggers` (`provider_operation`) WHERE "agent_event_triggers"."provider_operation" != 'stable';--> statement-breakpoint
CREATE TABLE `composio_event_trigger_webhook` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_nonce` text NOT NULL,
	`url` text NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "composio_event_trigger_webhook_singleton" CHECK("composio_event_trigger_webhook"."singleton" = 1),
	CONSTRAINT "composio_event_trigger_webhook_updated_at_positive" CHECK("composio_event_trigger_webhook"."updated_at" > 0)
);
