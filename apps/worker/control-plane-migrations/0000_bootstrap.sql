CREATE TABLE `agent_blueprint_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`blueprint_id`,`version`) REFERENCES `agent_blueprint_versions`(`blueprint_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_blueprint_mutations_request_digest_length" CHECK(length("agent_blueprint_mutations"."request_digest") = 43),
	CONSTRAINT "agent_blueprint_mutations_operation" CHECK("agent_blueprint_mutations"."operation" IN ('publish', 'retire')),
	CONSTRAINT "agent_blueprint_mutations_version_positive" CHECK("agent_blueprint_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_blueprint_versions` (
	`blueprint_id` text NOT NULL,
	`version` integer NOT NULL,
	`package` text NOT NULL,
	`package_digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blueprint_id`, `version`),
	FOREIGN KEY (`blueprint_id`) REFERENCES `agent_blueprints`(`blueprint_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_blueprint_versions_version_positive" CHECK("agent_blueprint_versions"."version" > 0),
	CONSTRAINT "agent_blueprint_versions_package_json" CHECK(json_valid("agent_blueprint_versions"."package")),
	CONSTRAINT "agent_blueprint_versions_package_digest_length" CHECK(length("agent_blueprint_versions"."package_digest") = 64),
	CONSTRAINT "agent_blueprint_versions_size_bytes_positive" CHECK("agent_blueprint_versions"."size_bytes" > 0),
	CONSTRAINT "agent_blueprint_versions_created_at_positive" CHECK("agent_blueprint_versions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_blueprints` (
	`blueprint_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	CONSTRAINT "agent_blueprints_current_version_positive" CHECK("agent_blueprints"."current_version" > 0),
	CONSTRAINT "agent_blueprints_status" CHECK("agent_blueprints"."status" IN ('active', 'retired')),
	CONSTRAINT "agent_blueprints_created_at_positive" CHECK("agent_blueprints"."created_at" > 0),
	CONSTRAINT "agent_blueprints_updated_after_creation" CHECK("agent_blueprints"."updated_at" >= "agent_blueprints"."created_at"),
	CONSTRAINT "agent_blueprints_state" CHECK((
        ("agent_blueprints"."status" = 'active' AND "agent_blueprints"."retired_at" IS NULL)
        OR ("agent_blueprints"."status" = 'retired'
          AND "agent_blueprints"."retired_at" IS NOT NULL
          AND "agent_blueprints"."retired_at" >= "agent_blueprints"."created_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `agent_blueprints_status_id` ON `agent_blueprints` (`status`,`blueprint_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_blueprints_active_name` ON `agent_blueprints` (`name`) WHERE "agent_blueprints"."status" = 'active';--> statement-breakpoint
CREATE TABLE `agent_creations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`agent_id`,`revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_creations_request_digest_length" CHECK(length("agent_creations"."request_digest") = 43),
	CONSTRAINT "agent_creations_revision_positive" CHECK("agent_creations"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_creations_agent_revision` ON `agent_creations` (`agent_id`,`revision`);--> statement-breakpoint
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
	`schedule_id` text,
	`schedule_revision` integer,
	`run_id` text,
	`trigger` text,
	`event_trigger_event_id` text,
	`event_trigger_id` text,
	`event_trigger_revision` integer,
	`event_trigger_source_kind` text,
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
	CONSTRAINT "agent_inbox_items_schedule_identity" CHECK(("agent_inbox_items"."schedule_id" IS NULL) = ("agent_inbox_items"."schedule_revision" IS NULL)),
	CONSTRAINT "agent_inbox_items_event_trigger_identity" CHECK((
        ("agent_inbox_items"."event_trigger_id" IS NULL
          AND "agent_inbox_items"."event_trigger_revision" IS NULL
          AND "agent_inbox_items"."event_trigger_event_id" IS NULL
          AND "agent_inbox_items"."event_trigger_source_kind" IS NULL
          AND ("agent_inbox_items"."trigger" IS NULL OR "agent_inbox_items"."trigger" <> 'event_trigger'))
        OR ("agent_inbox_items"."event_trigger_id" IS NOT NULL
          AND "agent_inbox_items"."event_trigger_revision" IS NOT NULL
          AND "agent_inbox_items"."event_trigger_event_id" IS NOT NULL
          AND "agent_inbox_items"."event_trigger_source_kind" = 'connection_event'
          AND "agent_inbox_items"."trigger" = 'event_trigger')
      )),
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
CREATE TABLE `agent_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`capabilities` text NOT NULL,
	`instructions` text NOT NULL,
	`execution_limits` text NOT NULL,
	`capability_grants` text NOT NULL,
	`blueprint_provenance` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_positive" CHECK("agent_revisions"."revision" > 0),
	CONSTRAINT "agent_revisions_capabilities_json" CHECK(json_valid("agent_revisions"."capabilities")),
	CONSTRAINT "agent_revisions_capability_grants_json" CHECK(json_valid("agent_revisions"."capability_grants")),
	CONSTRAINT "agent_revisions_blueprint_provenance_json" CHECK("agent_revisions"."blueprint_provenance" IS NULL OR json_valid("agent_revisions"."blueprint_provenance")),
	CONSTRAINT "agent_revisions_created_at_positive" CHECK("agent_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_schedule_occurrences` (
	`schedule_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`schedule_revision` integer NOT NULL,
	`scheduled_at` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`next_attempt_at` integer,
	`attempts` integer NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`reason` text,
	PRIMARY KEY(`schedule_id`, `schedule_revision`, `scheduled_at`),
	FOREIGN KEY (`schedule_id`,`agent_id`,`schedule_revision`) REFERENCES `agent_schedule_revisions`(`schedule_id`,`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedule_occurrences_revision_positive" CHECK("agent_schedule_occurrences"."schedule_revision" > 0),
	CONSTRAINT "agent_schedule_occurrences_scheduled_at_positive" CHECK("agent_schedule_occurrences"."scheduled_at" > 0),
	CONSTRAINT "agent_schedule_occurrences_occurred_at_positive" CHECK("agent_schedule_occurrences"."occurred_at" > 0),
	CONSTRAINT "agent_schedule_occurrences_attempts_positive" CHECK("agent_schedule_occurrences"."attempts" > 0),
	CONSTRAINT "agent_schedule_occurrences_status" CHECK("agent_schedule_occurrences"."status" IN ('pending', 'dispatched', 'skipped')),
	CONSTRAINT "agent_schedule_occurrences_state" CHECK((
        ("agent_schedule_occurrences"."status" = 'pending'
          AND "agent_schedule_occurrences"."next_attempt_at" IS NOT NULL
          AND "agent_schedule_occurrences"."run_id" IS NULL
          AND "agent_schedule_occurrences"."reason" IS NULL)
        OR ("agent_schedule_occurrences"."status" = 'dispatched'
          AND "agent_schedule_occurrences"."next_attempt_at" IS NULL
          AND "agent_schedule_occurrences"."run_id" IS NOT NULL
          AND "agent_schedule_occurrences"."reason" IS NULL)
        OR ("agent_schedule_occurrences"."status" = 'skipped'
          AND "agent_schedule_occurrences"."next_attempt_at" IS NULL
          AND "agent_schedule_occurrences"."run_id" IS NULL
          AND "agent_schedule_occurrences"."reason" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE INDEX `agent_schedule_occurrences_pending` ON `agent_schedule_occurrences` (`next_attempt_at`) WHERE "agent_schedule_occurrences"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `agent_schedule_occurrences_history` ON `agent_schedule_occurrences` (`schedule_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `agent_schedule_revisions` (
	`schedule_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`agent_revision` integer NOT NULL,
	`name` text NOT NULL,
	`configuration` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedule_revisions_revision_positive" CHECK("agent_schedule_revisions"."revision" > 0),
	CONSTRAINT "agent_schedule_revisions_agent_revision_positive" CHECK("agent_schedule_revisions"."agent_revision" > 0),
	CONSTRAINT "agent_schedule_revisions_name_length" CHECK(length("agent_schedule_revisions"."name") BETWEEN 1 AND 80),
	CONSTRAINT "agent_schedule_revisions_configuration_json" CHECK("agent_schedule_revisions"."configuration" IS NULL OR json_valid("agent_schedule_revisions"."configuration")),
	CONSTRAINT "agent_schedule_revisions_created_at_positive" CHECK("agent_schedule_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_schedule_revisions_schedule_revision` ON `agent_schedule_revisions` (`schedule_id`,`agent_id`,`revision`);--> statement-breakpoint
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
	`schedule_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`current_revision` integer NOT NULL,
	`status` text NOT NULL,
	`next_run_at` integer,
	`last_run_id` text,
	`last_dispatched_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`schedule_id`,`agent_id`,`current_revision`) REFERENCES `agent_schedule_revisions`(`schedule_id`,`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_schedules_current_revision_positive" CHECK("agent_schedules"."current_revision" > 0),
	CONSTRAINT "agent_schedules_status" CHECK("agent_schedules"."status" IN ('active', 'paused', 'deleted')),
	CONSTRAINT "agent_schedules_created_at_positive" CHECK("agent_schedules"."created_at" > 0),
	CONSTRAINT "agent_schedules_dispatch_state" CHECK((("agent_schedules"."last_run_id" IS NULL AND "agent_schedules"."last_dispatched_at" IS NULL)
        OR ("agent_schedules"."last_run_id" IS NOT NULL
          AND "agent_schedules"."last_dispatched_at" IS NOT NULL
          AND "agent_schedules"."last_dispatched_at" >= "agent_schedules"."created_at"))),
	CONSTRAINT "agent_schedules_state" CHECK((("agent_schedules"."status" = 'active' AND "agent_schedules"."next_run_at" IS NOT NULL)
        OR ("agent_schedules"."status" IN ('paused', 'deleted') AND "agent_schedules"."next_run_at" IS NULL)))
);
--> statement-breakpoint
CREATE INDEX `agent_schedules_agent` ON `agent_schedules` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_schedules_due` ON `agent_schedules` (`next_run_at`) WHERE "agent_schedules"."status" = 'active';--> statement-breakpoint
CREATE TABLE `agent_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`agent_id`,`revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_updates_request_digest_length" CHECK(length("agent_updates"."request_digest") = 43),
	CONSTRAINT "agent_updates_revision_after_initial" CHECK("agent_updates"."revision" > 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_updates_agent_revision` ON `agent_updates` (`agent_id`,`revision`);--> statement-breakpoint
CREATE TABLE `agent_workflow_deletions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`workflow_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`start_client_id` text NOT NULL,
	`start_idempotency_key` text NOT NULL,
	`start_request_digest` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`cleanup_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	CONSTRAINT "agent_workflow_deletions_revision_positive" CHECK("agent_workflow_deletions"."expected_revision" > 0),
	CONSTRAINT "agent_workflow_deletions_start_request_digest_length" CHECK(length("agent_workflow_deletions"."start_request_digest") = 43),
	CONSTRAINT "agent_workflow_deletions_deleted_at_positive" CHECK("agent_workflow_deletions"."deleted_at" > 0),
	CONSTRAINT "agent_workflow_deletions_cleanup_after_deletion" CHECK("agent_workflow_deletions"."cleanup_at" > "agent_workflow_deletions"."deleted_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflow_deletions_start_idempotency` ON `agent_workflow_deletions` (`start_client_id`,`start_idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_workflow_deletions_cleanup` ON `agent_workflow_deletions` (`cleanup_at`);--> statement-breakpoint
CREATE TABLE `agent_workflow_stages` (
	`workflow_id` text NOT NULL,
	`stage_index` integer NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`prompt_digest` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`started_at` integer,
	`completed_at` integer,
	PRIMARY KEY(`workflow_id`, `stage_index`),
	FOREIGN KEY (`workflow_id`) REFERENCES `agent_workflows`(`workflow_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_workflow_stages_index" CHECK("agent_workflow_stages"."stage_index" BETWEEN 0 AND 7),
	CONSTRAINT "agent_workflow_stages_name_length" CHECK(length("agent_workflow_stages"."name") BETWEEN 1 AND 80),
	CONSTRAINT "agent_workflow_stages_prompt_length" CHECK(length("agent_workflow_stages"."prompt") BETWEEN 1 AND 11264),
	CONSTRAINT "agent_workflow_stages_prompt_digest_length" CHECK(length("agent_workflow_stages"."prompt_digest") = 64),
	CONSTRAINT "agent_workflow_stages_status" CHECK("agent_workflow_stages"."status" IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_workflow_stages_state" CHECK((("agent_workflow_stages"."status" = 'pending'
          AND "agent_workflow_stages"."run_id" IS NULL
          AND "agent_workflow_stages"."started_at" IS NULL
          AND "agent_workflow_stages"."completed_at" IS NULL)
        OR ("agent_workflow_stages"."status" IN ('running', 'waiting')
          AND "agent_workflow_stages"."run_id" IS NOT NULL
          AND "agent_workflow_stages"."started_at" IS NOT NULL
          AND "agent_workflow_stages"."completed_at" IS NULL)
        OR ("agent_workflow_stages"."status" IN ('completed', 'cancelled')
          AND "agent_workflow_stages"."run_id" IS NOT NULL
          AND "agent_workflow_stages"."started_at" IS NOT NULL
          AND "agent_workflow_stages"."completed_at" IS NOT NULL
          AND "agent_workflow_stages"."completed_at" >= "agent_workflow_stages"."started_at")
        OR ("agent_workflow_stages"."status" = 'failed'
          AND "agent_workflow_stages"."completed_at" IS NOT NULL
          AND (("agent_workflow_stages"."run_id" IS NULL AND "agent_workflow_stages"."started_at" IS NULL)
            OR ("agent_workflow_stages"."run_id" IS NOT NULL
              AND "agent_workflow_stages"."started_at" IS NOT NULL
              AND "agent_workflow_stages"."completed_at" >= "agent_workflow_stages"."started_at")))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflow_stages_run` ON `agent_workflow_stages` (`run_id`);--> statement-breakpoint
CREATE TABLE `agent_workflows` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`brief_context` text,
	`fleet_revision` integer NOT NULL,
	`objective` text NOT NULL,
	`output_contract` text,
	`budget` text NOT NULL,
	`status` text NOT NULL,
	`workflow_revision` integer NOT NULL,
	`stage_count` integer NOT NULL,
	`completed_stages` integer DEFAULT 0 NOT NULL,
	`current_stage_index` integer,
	`current_run_id` text,
	`session` text,
	`failure_code` text,
	`failure_stage_index` integer,
	`cancellation_requested_at` integer,
	`deleting_at` integer,
	`deliverable` text,
	`deliverable_object_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`cleanup_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fleet_revision`) REFERENCES `fleet_configuration_revisions`(`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_workflows_request_digest_length" CHECK(length("agent_workflows"."request_digest") = 43),
	CONSTRAINT "agent_workflows_objective_length" CHECK(length("agent_workflows"."objective") BETWEEN 1 AND 4096),
	CONSTRAINT "agent_workflows_budget_json" CHECK(json_valid("agent_workflows"."budget")),
	CONSTRAINT "agent_workflows_output_contract_json" CHECK("agent_workflows"."output_contract" IS NULL OR json_valid("agent_workflows"."output_contract")),
	CONSTRAINT "agent_workflows_brief_context_json" CHECK("agent_workflows"."brief_context" IS NULL OR json_valid("agent_workflows"."brief_context")),
	CONSTRAINT "agent_workflows_deliverable_json" CHECK("agent_workflows"."deliverable" IS NULL OR json_valid("agent_workflows"."deliverable")),
	CONSTRAINT "agent_workflows_deliverable_state" CHECK(("agent_workflows"."deliverable" IS NULL AND "agent_workflows"."deliverable_object_key" IS NULL)
        OR ("agent_workflows"."deliverable" IS NOT NULL AND "agent_workflows"."deliverable_object_key" IS NOT NULL)),
	CONSTRAINT "agent_workflows_status" CHECK("agent_workflows"."status" IN ('queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_workflows_revision_positive" CHECK("agent_workflows"."workflow_revision" > 0),
	CONSTRAINT "agent_workflows_stage_count" CHECK("agent_workflows"."stage_count" BETWEEN 2 AND 8),
	CONSTRAINT "agent_workflows_completed_stages" CHECK("agent_workflows"."completed_stages" BETWEEN 0 AND "agent_workflows"."stage_count"),
	CONSTRAINT "agent_workflows_current_stage" CHECK("agent_workflows"."current_stage_index" IS NULL OR "agent_workflows"."current_stage_index" BETWEEN 0 AND "agent_workflows"."stage_count" - 1),
	CONSTRAINT "agent_workflows_session_json" CHECK("agent_workflows"."session" IS NULL OR json_valid("agent_workflows"."session")),
	CONSTRAINT "agent_workflows_failure" CHECK(("agent_workflows"."failure_code" IS NULL AND "agent_workflows"."failure_stage_index" IS NULL)
        OR ("agent_workflows"."failure_code" IN ('agent_unavailable', 'brief_unavailable', 'budget_exhausted', 'capability_unavailable', 'coordinator_failed', 'model_unavailable', 'revision_conflict', 'run_failed', 'workflow_unavailable')
          AND "agent_workflows"."failure_stage_index" BETWEEN 0 AND "agent_workflows"."stage_count" - 1)),
	CONSTRAINT "agent_workflows_created_at_positive" CHECK("agent_workflows"."created_at" > 0),
	CONSTRAINT "agent_workflows_updated_after_creation" CHECK("agent_workflows"."updated_at" >= "agent_workflows"."created_at"),
	CONSTRAINT "agent_workflows_cleanup_after_creation" CHECK("agent_workflows"."cleanup_at" > "agent_workflows"."created_at"),
	CONSTRAINT "agent_workflows_terminal_state" CHECK((("agent_workflows"."status" IN ('completed', 'failed', 'cancelled')
          AND "agent_workflows"."completed_at" IS NOT NULL
          AND "agent_workflows"."completed_at" >= "agent_workflows"."created_at")
        OR ("agent_workflows"."status" NOT IN ('completed', 'failed', 'cancelled')
          AND "agent_workflows"."completed_at" IS NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflows_client_idempotency` ON `agent_workflows` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_workflows_agent_created` ON `agent_workflows` (`agent_id`,`workflow_id`);--> statement-breakpoint
CREATE INDEX `agent_workflows_cleanup` ON `agent_workflows` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `agent_workflows_status_updated` ON `agent_workflows` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "agents_current_revision_positive" CHECK("agents"."current_revision" > 0),
	CONSTRAINT "agents_status" CHECK("agents"."status" IN ('active', 'disabled')),
	CONSTRAINT "agents_created_at_positive" CHECK("agents"."created_at" > 0),
	CONSTRAINT "agents_state" CHECK((
        ("agents"."status" = 'active' AND "agents"."disabled_at" IS NULL)
        OR ("agents"."status" = 'disabled'
          AND "agents"."disabled_at" IS NOT NULL
          AND "agents"."disabled_at" >= "agents"."created_at")
      ))
);
--> statement-breakpoint
CREATE TABLE `ai_gateway_calls` (
	`gateway_log_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`reservation_microusd` integer NOT NULL,
	`cost_microusd` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`recorded_at` integer NOT NULL,
	`settled_at` integer,
	`next_reconciliation_at` integer NOT NULL,
	`reconciliation_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_gateway_calls_status" CHECK("ai_gateway_calls"."status" IN ('pending', 'settled')),
	CONSTRAINT "ai_gateway_calls_cost_nonnegative" CHECK("ai_gateway_calls"."cost_microusd" IS NULL OR "ai_gateway_calls"."cost_microusd" >= 0),
	CONSTRAINT "ai_gateway_calls_reservation_positive" CHECK("ai_gateway_calls"."reservation_microusd" > 0),
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
CREATE TABLE `audit_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`client_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_events_occurred_at_positive" CHECK("audit_events"."occurred_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `brief_deletions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`brief_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	CONSTRAINT "brief_deletions_request_digest_length" CHECK(length("brief_deletions"."request_digest") = 43),
	CONSTRAINT "brief_deletions_revision_positive" CHECK("brief_deletions"."expected_revision" > 0),
	CONSTRAINT "brief_deletions_deleted_at_positive" CHECK("brief_deletions"."deleted_at" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_deletions_brief_id_unique` ON `brief_deletions` (`brief_id`);--> statement-breakpoint
CREATE TABLE `brief_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`brief_id` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	CONSTRAINT "brief_mutations_request_digest_length" CHECK(length("brief_mutations"."request_digest") = 43),
	CONSTRAINT "brief_mutations_operation" CHECK("brief_mutations"."operation" IN ('create', 'revise')),
	CONSTRAINT "brief_mutations_revision_positive" CHECK("brief_mutations"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `brief_versions` (
	`brief_id` text NOT NULL,
	`revision` integer NOT NULL,
	`digest` text NOT NULL,
	`media_type` text NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`brief_id`, `revision`),
	FOREIGN KEY (`brief_id`) REFERENCES `briefs`(`brief_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "brief_versions_revision_positive" CHECK("brief_versions"."revision" > 0),
	CONSTRAINT "brief_versions_digest_length" CHECK(length("brief_versions"."digest") = 64),
	CONSTRAINT "brief_versions_media_type" CHECK("brief_versions"."media_type" IN ('application/json', 'text/markdown', 'text/plain')),
	CONSTRAINT "brief_versions_size_bytes" CHECK("brief_versions"."size_bytes" BETWEEN 1 AND 32768),
	CONSTRAINT "brief_versions_created_at_positive" CHECK("brief_versions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `briefs` (
	`brief_id` text PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleting_at` integer,
	CONSTRAINT "briefs_current_revision_positive" CHECK("briefs"."current_revision" > 0),
	CONSTRAINT "briefs_status" CHECK("briefs"."status" IN ('active', 'deleting')),
	CONSTRAINT "briefs_created_at_positive" CHECK("briefs"."created_at" > 0),
	CONSTRAINT "briefs_updated_after_creation" CHECK("briefs"."updated_at" >= "briefs"."created_at"),
	CONSTRAINT "briefs_state" CHECK(("briefs"."status" = 'active' AND "briefs"."deleting_at" IS NULL)
        OR ("briefs"."status" = 'deleting' AND "briefs"."deleting_at" IS NOT NULL
          AND "briefs"."deleting_at" >= "briefs"."created_at"))
);
--> statement-breakpoint
CREATE INDEX `briefs_status_id` ON `briefs` (`status`,`brief_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `briefs_active_name` ON `briefs` (`name`) WHERE "briefs"."status" = 'active';--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE `connection_authorization_returns` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`token_digest` text NOT NULL,
	`status` text NOT NULL,
	`connection_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`reservation_id`) REFERENCES `connection_link_requests`(`reservation_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connection_authorization_returns_token_digest_length" CHECK(length("connection_authorization_returns"."token_digest") = 43),
	CONSTRAINT "connection_authorization_returns_status" CHECK("connection_authorization_returns"."status" IN ('pending', 'returned', 'failed', 'expired')),
	CONSTRAINT "connection_authorization_returns_expires_at_positive" CHECK("connection_authorization_returns"."expires_at" > 0),
	CONSTRAINT "connection_authorization_returns_created_at_positive" CHECK("connection_authorization_returns"."created_at" > 0),
	CONSTRAINT "connection_authorization_returns_state" CHECK((
        ("connection_authorization_returns"."status" = 'pending' AND "connection_authorization_returns"."completed_at" IS NULL)
        OR
        ("connection_authorization_returns"."status" IN ('returned', 'failed')
          AND "connection_authorization_returns"."connection_id" IS NOT NULL
          AND "connection_authorization_returns"."completed_at" IS NOT NULL)
        OR
        ("connection_authorization_returns"."status" = 'expired' AND "connection_authorization_returns"."completed_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_authorization_returns_token_digest_unique` ON `connection_authorization_returns` (`token_digest`);--> statement-breakpoint
CREATE INDEX `connection_authorization_returns_connection` ON `connection_authorization_returns` (`connection_id`,"created_at" DESC);--> statement-breakpoint
CREATE TABLE `connection_link_requests` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`status` text NOT NULL,
	`recover_after` integer NOT NULL,
	`connection_id` text,
	`redirect_url` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "connection_link_requests_request_digest_length" CHECK(length("connection_link_requests"."request_digest") = 43),
	CONSTRAINT "connection_link_requests_recover_after_positive" CHECK("connection_link_requests"."recover_after" > 0),
	CONSTRAINT "connection_link_requests_created_at_positive" CHECK("connection_link_requests"."created_at" > 0),
	CONSTRAINT "connection_link_requests_state" CHECK((
        ("connection_link_requests"."status" = 'completed'
          AND "connection_link_requests"."connection_id" IS NOT NULL
          AND "connection_link_requests"."redirect_url" IS NOT NULL
          AND "connection_link_requests"."expires_at" IS NOT NULL
          AND "connection_link_requests"."completed_at" IS NOT NULL)
        OR
        ("connection_link_requests"."status" = 'expired'
          AND "connection_link_requests"."connection_id" IS NOT NULL
          AND "connection_link_requests"."redirect_url" IS NULL
          AND "connection_link_requests"."expires_at" IS NOT NULL
          AND "connection_link_requests"."completed_at" IS NOT NULL)
        OR
        ("connection_link_requests"."status" IN ('pending', 'abandoned')
          AND "connection_link_requests"."connection_id" IS NULL
          AND "connection_link_requests"."redirect_url" IS NULL
          AND "connection_link_requests"."expires_at" IS NULL
          AND "connection_link_requests"."completed_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_link_requests_reservation_id_unique` ON `connection_link_requests` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `connection_link_requests_pending_auth_config` ON `connection_link_requests` (`auth_config_id`,`recover_after`) WHERE "connection_link_requests"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_connection_id` text,
	`auth_config_id` text,
	`account_label` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "connections_provider_details" CHECK((
        ("connections"."provider" = 'composio'
          AND "connections"."provider_connection_id" IS NOT NULL
          AND "connections"."auth_config_id" IS NOT NULL)
        OR ("connections"."provider" = 'remote_mcp'
          AND "connections"."provider_connection_id" IS NULL
          AND "connections"."auth_config_id" IS NULL)
      )),
	CONSTRAINT "connections_status" CHECK("connections"."status" IN ('initiated', 'active', 'revoked', 'unavailable')),
	CONSTRAINT "connections_created_at_positive" CHECK("connections"."created_at" > 0),
	CONSTRAINT "connections_account_label" CHECK("connections"."account_label" IS NULL
        OR (length("connections"."account_label") BETWEEN 1 AND 160
          AND "connections"."account_label" NOT GLOB '*[^ -~]*')),
	CONSTRAINT "connections_revocation_state" CHECK((
        ("connections"."status" = 'revoked'
          AND "connections"."revoked_at" IS NOT NULL
          AND "connections"."revoked_at" >= "connections"."created_at")
        OR ("connections"."status" != 'revoked' AND "connections"."revoked_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_connection_id_unique` ON `connections` (`provider_connection_id`);--> statement-breakpoint
CREATE TABLE `control_plane` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	CONSTRAINT "control_plane_singleton" CHECK("control_plane"."singleton" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_owner_key_unique` ON `control_plane` (`owner_key`);--> statement-breakpoint
CREATE TABLE `control_plane_migrations` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` integer NOT NULL,
	CONSTRAINT "control_plane_migrations_version_positive" CHECK("control_plane_migrations"."version" > 0),
	CONSTRAINT "control_plane_migrations_checksum_length" CHECK(length("control_plane_migrations"."checksum") = 64),
	CONSTRAINT "control_plane_migrations_applied_at_positive" CHECK("control_plane_migrations"."applied_at" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `control_plane_migrations_name_unique` ON `control_plane_migrations` (`name`);--> statement-breakpoint
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
CREATE TABLE `integration_enablement_requests` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`integration_slug` text NOT NULL,
	`reservation_id` text NOT NULL,
	`status` text NOT NULL,
	`recover_after` integer NOT NULL,
	`auth_config_id` text,
	`auth_scheme` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	CONSTRAINT "integration_enablement_requests_request_digest_length" CHECK(length("integration_enablement_requests"."request_digest") = 43),
	CONSTRAINT "integration_enablement_requests_status" CHECK("integration_enablement_requests"."status" IN ('pending', 'completed', 'abandoned')),
	CONSTRAINT "integration_enablement_requests_recover_after_positive" CHECK("integration_enablement_requests"."recover_after" > 0),
	CONSTRAINT "integration_enablement_requests_created_at_positive" CHECK("integration_enablement_requests"."created_at" > 0),
	CONSTRAINT "integration_enablement_requests_state" CHECK((
        ("integration_enablement_requests"."status" = 'completed'
          AND "integration_enablement_requests"."auth_config_id" IS NOT NULL
          AND "integration_enablement_requests"."auth_scheme" IS NOT NULL
          AND "integration_enablement_requests"."completed_at" IS NOT NULL
          AND "integration_enablement_requests"."completed_at" >= "integration_enablement_requests"."created_at")
        OR
        ("integration_enablement_requests"."status" IN ('pending', 'abandoned')
          AND "integration_enablement_requests"."auth_config_id" IS NULL
          AND "integration_enablement_requests"."auth_scheme" IS NULL
          AND "integration_enablement_requests"."completed_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_enablement_requests_reservation_id_unique` ON `integration_enablement_requests` (`reservation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `integration_enablement_requests_pending_slug` ON `integration_enablement_requests` (`integration_slug`) WHERE "integration_enablement_requests"."status" = 'pending';--> statement-breakpoint
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
CREATE TABLE `mcp_authoring_drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`content_digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`last_idempotency_key` text,
	`last_request_digest` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mcp_authoring_drafts_request_digest_length" CHECK(length("mcp_authoring_drafts"."request_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_kind" CHECK("mcp_authoring_drafts"."kind" IN ('agent-blueprint-package', 'recipe-installation', 'recipe-publication', 'skill-package')),
	CONSTRAINT "mcp_authoring_drafts_revision_positive" CHECK("mcp_authoring_drafts"."revision" > 0),
	CONSTRAINT "mcp_authoring_drafts_content_json" CHECK(json_valid("mcp_authoring_drafts"."content")),
	CONSTRAINT "mcp_authoring_drafts_content_digest_length" CHECK(length("mcp_authoring_drafts"."content_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_size" CHECK("mcp_authoring_drafts"."size_bytes" BETWEEN 2 AND 163840),
	CONSTRAINT "mcp_authoring_drafts_last_request_digest" CHECK("mcp_authoring_drafts"."last_request_digest" IS NULL OR length("mcp_authoring_drafts"."last_request_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_expires_at_positive" CHECK("mcp_authoring_drafts"."expires_at" > 0),
	CONSTRAINT "mcp_authoring_drafts_created_at_positive" CHECK("mcp_authoring_drafts"."created_at" > 0),
	CONSTRAINT "mcp_authoring_drafts_updated_after_creation" CHECK("mcp_authoring_drafts"."updated_at" >= "mcp_authoring_drafts"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_authoring_drafts_client_idempotency` ON `mcp_authoring_drafts` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `mcp_authoring_drafts_client_expiry` ON `mcp_authoring_drafts` (`client_id`,`expires_at`);--> statement-breakpoint
CREATE TABLE `model_catalog_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`catalog` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "model_catalog_revisions_revision_positive" CHECK("model_catalog_revisions"."revision" > 0),
	CONSTRAINT "model_catalog_revisions_catalog_json" CHECK(json_valid("model_catalog_revisions"."catalog")),
	CONSTRAINT "model_catalog_revisions_created_at_positive" CHECK("model_catalog_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `model_catalog_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`revision`) REFERENCES `model_catalog_revisions`(`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "model_catalog_updates_request_digest_length" CHECK(length("model_catalog_updates"."request_digest") = 43),
	CONSTRAINT "model_catalog_updates_revision_positive" CHECK("model_catalog_updates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_catalog_updates_revision` ON `model_catalog_updates` (`revision`);--> statement-breakpoint
CREATE TABLE `model_catalogs` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	CONSTRAINT "model_catalogs_singleton" CHECK("model_catalogs"."singleton" = 1),
	CONSTRAINT "model_catalogs_current_revision_positive" CHECK("model_catalogs"."current_revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `provider_auth_configs` (
	`auth_config_id` text PRIMARY KEY NOT NULL,
	`integration_slug` text NOT NULL,
	`auth_scheme` text NOT NULL,
	`source` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "provider_auth_configs_integration_slug" CHECK(length("provider_auth_configs"."integration_slug") BETWEEN 1 AND 128),
	CONSTRAINT "provider_auth_configs_auth_scheme" CHECK("provider_auth_configs"."auth_scheme" IN ('OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC')),
	CONSTRAINT "provider_auth_configs_source" CHECK("provider_auth_configs"."source" IN ('composio_managed', 'crewhelm_custom')),
	CONSTRAINT "provider_auth_configs_display_name" CHECK(length("provider_auth_configs"."display_name") BETWEEN 1 AND 160),
	CONSTRAINT "provider_auth_configs_created_at_positive" CHECK("provider_auth_configs"."created_at" > 0),
	CONSTRAINT "provider_auth_configs_updated_after_creation" CHECK("provider_auth_configs"."updated_at" >= "provider_auth_configs"."created_at")
);
--> statement-breakpoint
CREATE INDEX `provider_auth_configs_integration` ON `provider_auth_configs` (`integration_slug`,`auth_config_id`);--> statement-breakpoint
CREATE TABLE `provider_auth_setup_requests` (
	`setup_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`capability_digest` text NOT NULL,
	`capability_expires_at` integer NOT NULL,
	`setup_expires_at` integer NOT NULL,
	`session_digest` text,
	`session_expires_at` integer,
	`plan` text NOT NULL,
	`status` text NOT NULL,
	`auth_config_id` text,
	`recover_after` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "provider_auth_setup_requests_request_digest" CHECK(length("provider_auth_setup_requests"."request_digest") = 64),
	CONSTRAINT "provider_auth_setup_requests_capability_digest" CHECK(length("provider_auth_setup_requests"."capability_digest") = 64),
	CONSTRAINT "provider_auth_setup_requests_session_digest" CHECK("provider_auth_setup_requests"."session_digest" IS NULL OR length("provider_auth_setup_requests"."session_digest") = 64),
	CONSTRAINT "provider_auth_setup_requests_plan_json" CHECK(json_valid("provider_auth_setup_requests"."plan")),
	CONSTRAINT "provider_auth_setup_requests_status" CHECK("provider_auth_setup_requests"."status" IN ('prepared', 'exchanged', 'submitting', 'configured', 'rejected', 'outcome_unknown')),
	CONSTRAINT "provider_auth_setup_requests_created_at" CHECK("provider_auth_setup_requests"."created_at" > 0),
	CONSTRAINT "provider_auth_setup_requests_updated_at" CHECK("provider_auth_setup_requests"."updated_at" >= "provider_auth_setup_requests"."created_at"),
	CONSTRAINT "provider_auth_setup_requests_expiry" CHECK("provider_auth_setup_requests"."capability_expires_at" > "provider_auth_setup_requests"."created_at" AND "provider_auth_setup_requests"."setup_expires_at" >= "provider_auth_setup_requests"."capability_expires_at"),
	CONSTRAINT "provider_auth_setup_requests_session_state" CHECK((
        ("provider_auth_setup_requests"."status" = 'prepared' AND "provider_auth_setup_requests"."session_digest" IS NULL AND "provider_auth_setup_requests"."session_expires_at" IS NULL)
        OR
        ("provider_auth_setup_requests"."status" <> 'prepared' AND "provider_auth_setup_requests"."session_digest" IS NOT NULL AND "provider_auth_setup_requests"."session_expires_at" IS NOT NULL)
      )),
	CONSTRAINT "provider_auth_setup_requests_completion_state" CHECK((
        ("provider_auth_setup_requests"."status" = 'configured' AND "provider_auth_setup_requests"."auth_config_id" IS NOT NULL)
        OR
        ("provider_auth_setup_requests"."status" <> 'configured' AND "provider_auth_setup_requests"."auth_config_id" IS NULL)
      )),
	CONSTRAINT "provider_auth_setup_requests_recovery_state" CHECK((
        ("provider_auth_setup_requests"."status" IN ('submitting', 'outcome_unknown') AND "provider_auth_setup_requests"."recover_after" IS NOT NULL)
        OR
        ("provider_auth_setup_requests"."status" NOT IN ('submitting', 'outcome_unknown') AND "provider_auth_setup_requests"."recover_after" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_auth_setup_requests_capability_digest_unique` ON `provider_auth_setup_requests` (`capability_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_auth_setup_requests_session_digest_unique` ON `provider_auth_setup_requests` (`session_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `provider_auth_setup_requests_client_idempotency` ON `provider_auth_setup_requests` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `provider_auth_setup_requests_status_expiry` ON `provider_auth_setup_requests` (`status`,`setup_expires_at`);--> statement-breakpoint
CREATE TABLE `recipe_installations` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`plan_digest` text NOT NULL,
	`plan` text NOT NULL,
	`skill_packages` text NOT NULL,
	`receipt` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "recipe_installations_request_digest_length" CHECK(length("recipe_installations"."request_digest") = 64),
	CONSTRAINT "recipe_installations_plan_digest_length" CHECK(length("recipe_installations"."plan_digest") = 64),
	CONSTRAINT "recipe_installations_plan_json" CHECK(json_valid("recipe_installations"."plan")),
	CONSTRAINT "recipe_installations_skill_packages_json" CHECK(json_valid("recipe_installations"."skill_packages")),
	CONSTRAINT "recipe_installations_receipt_json" CHECK(json_valid("recipe_installations"."receipt")),
	CONSTRAINT "recipe_installations_status" CHECK("recipe_installations"."status" IN ('installing', 'installed')),
	CONSTRAINT "recipe_installations_created_at_positive" CHECK("recipe_installations"."created_at" > 0),
	CONSTRAINT "recipe_installations_updated_after_creation" CHECK("recipe_installations"."updated_at" >= "recipe_installations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_installations_client_idempotency` ON `recipe_installations` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `recipe_installations_status_updated` ON `recipe_installations` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `remote_mcp_connection_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`connection_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_digest` text NOT NULL,
	`occurred_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connection_mutations_operation" CHECK("remote_mcp_connection_mutations"."operation" IN ('create', 'delete')),
	CONSTRAINT "remote_mcp_connection_mutations_request_digest" CHECK(length("remote_mcp_connection_mutations"."request_digest") = 64
        AND "remote_mcp_connection_mutations"."request_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connection_mutations_occurred_at" CHECK("remote_mcp_connection_mutations"."occurred_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `remote_mcp_connection_mutations_connection` ON `remote_mcp_connection_mutations` (`connection_id`);--> statement-breakpoint
CREATE TABLE `remote_mcp_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`auth_kind` text NOT NULL,
	`catalog` text NOT NULL,
	`catalog_bytes` integer NOT NULL,
	`snapshot_digest` text NOT NULL,
	`server_name` text NOT NULL,
	`server_version` text NOT NULL,
	`credential_ciphertext` text,
	`credential_nonce` text,
	`oauth_scopes` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connections_endpoint" CHECK(length("remote_mcp_connections"."endpoint") BETWEEN 1 AND 2048),
	CONSTRAINT "remote_mcp_connections_auth" CHECK((
        ("remote_mcp_connections"."auth_kind" = 'public'
          AND "remote_mcp_connections"."credential_ciphertext" IS NULL
          AND "remote_mcp_connections"."credential_nonce" IS NULL)
        OR ("remote_mcp_connections"."auth_kind" IN ('bearer', 'oauth')
          AND (("remote_mcp_connections"."credential_ciphertext" IS NOT NULL
              AND "remote_mcp_connections"."credential_nonce" IS NOT NULL)
            OR ("remote_mcp_connections"."credential_ciphertext" IS NULL
              AND "remote_mcp_connections"."credential_nonce" IS NULL)))
      )),
	CONSTRAINT "remote_mcp_connections_catalog_json" CHECK(json_valid("remote_mcp_connections"."catalog")),
	CONSTRAINT "remote_mcp_connections_oauth_scopes_json" CHECK(json_valid("remote_mcp_connections"."oauth_scopes") AND json_type("remote_mcp_connections"."oauth_scopes") = 'array'),
	CONSTRAINT "remote_mcp_connections_oauth_scopes_auth_kind" CHECK("remote_mcp_connections"."auth_kind" = 'oauth' OR json_array_length("remote_mcp_connections"."oauth_scopes") = 0),
	CONSTRAINT "remote_mcp_connections_catalog_bytes" CHECK("remote_mcp_connections"."catalog_bytes" BETWEEN 2 AND 524288),
	CONSTRAINT "remote_mcp_connections_snapshot_digest" CHECK(length("remote_mcp_connections"."snapshot_digest") = 64
        AND "remote_mcp_connections"."snapshot_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connections_server_name" CHECK(length("remote_mcp_connections"."server_name") BETWEEN 1 AND 160),
	CONSTRAINT "remote_mcp_connections_server_version" CHECK(length("remote_mcp_connections"."server_version") BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE TABLE `remote_mcp_oauth_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`connection_id` text,
	`endpoint` text NOT NULL,
	`account_label` text NOT NULL,
	`oauth_scopes` text NOT NULL,
	`snapshot_digest` text,
	`state_digest` text NOT NULL,
	`authorization_url` text,
	`credential_ciphertext` text,
	`credential_nonce` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_oauth_requests_operation" CHECK("remote_mcp_oauth_requests"."operation" IN ('create', 'reauthenticate')),
	CONSTRAINT "remote_mcp_oauth_requests_digest" CHECK(length("remote_mcp_oauth_requests"."request_digest") = 64
        AND "remote_mcp_oauth_requests"."request_digest" NOT GLOB '*[^0-9a-f]*'
        AND length("remote_mcp_oauth_requests"."state_digest") = 64
        AND "remote_mcp_oauth_requests"."state_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_oauth_requests_status" CHECK("remote_mcp_oauth_requests"."status" IN ('reserved', 'starting', 'pending', 'exchanging', 'completed', 'failed')),
	CONSTRAINT "remote_mcp_oauth_requests_credential_pair" CHECK(("remote_mcp_oauth_requests"."credential_ciphertext" IS NULL) = ("remote_mcp_oauth_requests"."credential_nonce" IS NULL)),
	CONSTRAINT "remote_mcp_oauth_requests_scopes_json" CHECK(json_valid("remote_mcp_oauth_requests"."oauth_scopes") AND json_type("remote_mcp_oauth_requests"."oauth_scopes") = 'array'),
	CONSTRAINT "remote_mcp_oauth_requests_target" CHECK(("remote_mcp_oauth_requests"."operation" = 'create'
          AND "remote_mcp_oauth_requests"."snapshot_digest" IS NULL
          AND (("remote_mcp_oauth_requests"."status" = 'completed' AND "remote_mcp_oauth_requests"."connection_id" IS NOT NULL)
            OR ("remote_mcp_oauth_requests"."status" != 'completed' AND "remote_mcp_oauth_requests"."connection_id" IS NULL)))
        OR ("remote_mcp_oauth_requests"."operation" = 'reauthenticate'
          AND "remote_mcp_oauth_requests"."connection_id" IS NOT NULL
          AND "remote_mcp_oauth_requests"."snapshot_digest" IS NOT NULL)),
	CONSTRAINT "remote_mcp_oauth_requests_times" CHECK("remote_mcp_oauth_requests"."created_at" > 0
        AND "remote_mcp_oauth_requests"."expires_at" > "remote_mcp_oauth_requests"."created_at"
        AND ("remote_mcp_oauth_requests"."completed_at" IS NULL OR "remote_mcp_oauth_requests"."completed_at" >= "remote_mcp_oauth_requests"."created_at")),
	CONSTRAINT "remote_mcp_oauth_requests_completion" CHECK((
        ("remote_mcp_oauth_requests"."status" IN ('completed', 'failed')
          AND "remote_mcp_oauth_requests"."completed_at" IS NOT NULL
          AND "remote_mcp_oauth_requests"."authorization_url" IS NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NULL)
        OR ("remote_mcp_oauth_requests"."status" NOT IN ('completed', 'failed') AND "remote_mcp_oauth_requests"."completed_at" IS NULL)
      )),
	CONSTRAINT "remote_mcp_oauth_requests_pending_material" CHECK((
        ("remote_mcp_oauth_requests"."status" IN ('pending', 'exchanging')
          AND "remote_mcp_oauth_requests"."authorization_url" IS NOT NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NOT NULL)
        OR ("remote_mcp_oauth_requests"."status" NOT IN ('pending', 'exchanging')
          AND "remote_mcp_oauth_requests"."authorization_url" IS NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_mcp_oauth_requests_client_idempotency` ON `remote_mcp_oauth_requests` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `remote_mcp_oauth_requests_expiry` ON `remote_mcp_oauth_requests` (`expires_at`);--> statement-breakpoint
CREATE TABLE `run_admissions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`brief_context` text,
	`prompt` text,
	`prompt_digest` text NOT NULL,
	`output_contract` text,
	`schedule_revision` integer,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`event_trigger_event_id` text,
	`event_trigger_id` text,
	`event_trigger_revision` integer,
	`event_trigger_source_kind` text,
	`budget_reservation` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`failure_code` text,
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
	FOREIGN KEY (`event_trigger_id`,`event_trigger_revision`) REFERENCES `agent_event_trigger_revisions`(`event_trigger_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_admissions_request_digest_length" CHECK(length("run_admissions"."request_digest") = 43),
	CONSTRAINT "run_admissions_agent_revision_positive" CHECK("run_admissions"."agent_revision" > 0),
	CONSTRAINT "run_admissions_brief_context_json" CHECK("run_admissions"."brief_context" IS NULL OR json_valid("run_admissions"."brief_context")),
	CONSTRAINT "run_admissions_prompt_length" CHECK("run_admissions"."prompt" IS NULL OR length("run_admissions"."prompt") BETWEEN 1 AND 16384),
	CONSTRAINT "run_admissions_prompt_digest_length" CHECK(length("run_admissions"."prompt_digest") = 64),
	CONSTRAINT "run_admissions_output_contract_json" CHECK("run_admissions"."output_contract" IS NULL OR json_valid("run_admissions"."output_contract")),
	CONSTRAINT "run_admissions_schedule_revision_positive" CHECK("run_admissions"."schedule_revision" IS NULL OR "run_admissions"."schedule_revision" > 0),
	CONSTRAINT "run_admissions_trigger" CHECK("run_admissions"."trigger" IN ('manual', 'schedule', 'event_trigger', 'workflow')),
	CONSTRAINT "run_admissions_event_trigger_identity" CHECK((
        ("run_admissions"."event_trigger_id" IS NULL
          AND "run_admissions"."event_trigger_revision" IS NULL
          AND "run_admissions"."event_trigger_event_id" IS NULL
          AND "run_admissions"."event_trigger_source_kind" IS NULL
          AND "run_admissions"."trigger" <> 'event_trigger')
        OR ("run_admissions"."event_trigger_id" IS NOT NULL
          AND "run_admissions"."event_trigger_revision" IS NOT NULL
          AND "run_admissions"."event_trigger_event_id" IS NOT NULL
          AND "run_admissions"."event_trigger_source_kind" = 'connection_event'
          AND "run_admissions"."trigger" = 'event_trigger')
      )),
	CONSTRAINT "run_admissions_event_trigger_revision_positive" CHECK("run_admissions"."event_trigger_revision" IS NULL OR "run_admissions"."event_trigger_revision" > 0),
	CONSTRAINT "run_admissions_nonce_digest_length" CHECK(length("run_admissions"."nonce_digest") = 43),
	CONSTRAINT "run_admissions_status" CHECK("run_admissions"."status" IN ('issued', 'redeemed', 'expired')),
	CONSTRAINT "run_admissions_failure_code" CHECK("run_admissions"."failure_code" IS NULL OR "run_admissions"."failure_code" = 'skill_unavailable'),
	CONSTRAINT "run_admissions_expires_at_positive" CHECK("run_admissions"."expires_at" > 0),
	CONSTRAINT "run_admissions_cleanup_after_expiry" CHECK("run_admissions"."cleanup_at" > "run_admissions"."expires_at"),
	CONSTRAINT "run_admissions_created_at_positive" CHECK("run_admissions"."created_at" > 0),
	CONSTRAINT "run_admissions_cancellation_requested_at_positive" CHECK("run_admissions"."cancellation_requested_at" IS NULL OR "run_admissions"."cancellation_requested_at" > 0),
	CONSTRAINT "run_admissions_cancelled_at_positive" CHECK("run_admissions"."cancelled_at" IS NULL OR "run_admissions"."cancelled_at" > 0),
	CONSTRAINT "run_admissions_cancellation_state" CHECK((
        ("run_admissions"."cancellation_requested_at" IS NULL AND "run_admissions"."cancelled_at" IS NULL)
        OR ("run_admissions"."cancellation_requested_at" IS NOT NULL
          AND "run_admissions"."cancellation_requested_at" >= "run_admissions"."created_at"
          AND ("run_admissions"."cancelled_at" IS NULL
            OR "run_admissions"."cancelled_at" >= "run_admissions"."cancellation_requested_at"))
      )),
	CONSTRAINT "run_admissions_model_call_consumed_at_positive" CHECK("run_admissions"."model_call_consumed_at" IS NULL OR "run_admissions"."model_call_consumed_at" > 0),
	CONSTRAINT "run_admissions_model_calls_consumed" CHECK("run_admissions"."model_calls_consumed" >= 0),
	CONSTRAINT "run_admissions_tool_calls_consumed" CHECK("run_admissions"."tool_calls_consumed" >= 0),
	CONSTRAINT "run_admissions_state" CHECK((
        ("run_admissions"."status" = 'issued'
          AND "run_admissions"."failure_code" IS NULL
          AND "run_admissions"."redeemed_at" IS NULL
          AND "run_admissions"."model_call_consumed_at" IS NULL
          AND "run_admissions"."model_calls_consumed" = 0)
        OR ("run_admissions"."status" = 'redeemed'
          AND "run_admissions"."failure_code" IS NULL
          AND "run_admissions"."redeemed_at" IS NOT NULL
          AND "run_admissions"."model_calls_consumed" <= json_extract(
            "run_admissions"."budget_reservation",
            '$.maxModelCalls'
          )
          AND (("run_admissions"."model_calls_consumed" = 0 AND "run_admissions"."model_call_consumed_at" IS NULL)
            OR ("run_admissions"."model_calls_consumed" > 0
              AND "run_admissions"."model_call_consumed_at" >= "run_admissions"."redeemed_at")))
        OR ("run_admissions"."status" = 'expired'
          AND "run_admissions"."redeemed_at" IS NULL
          AND "run_admissions"."model_call_consumed_at" IS NULL
          AND "run_admissions"."model_calls_consumed" = 0)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';--> statement-breakpoint
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
	`cleanup_at` integer,
	`cleanup_retry_at` integer NOT NULL,
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
	CONSTRAINT "runtime_tool_executions_cleanup_retry_positive" CHECK("runtime_tool_executions"."cleanup_retry_at" > 0),
	CONSTRAINT "runtime_tool_executions_cleanup_after_start" CHECK("runtime_tool_executions"."cleanup_at" IS NULL OR "runtime_tool_executions"."cleanup_at" >= "runtime_tool_executions"."started_at"),
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
CREATE INDEX `runtime_tool_executions_run_input` ON `runtime_tool_executions` (`run_id`,`tool_id`,`input_digest`);--> statement-breakpoint
CREATE TABLE `skill_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`skill_id`,`version`) REFERENCES `skill_versions`(`skill_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "skill_mutations_request_digest_length" CHECK(length("skill_mutations"."request_digest") = 43),
	CONSTRAINT "skill_mutations_operation" CHECK("skill_mutations"."operation" IN ('publish', 'retire')),
	CONSTRAINT "skill_mutations_version_positive" CHECK("skill_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `skill_objects` (
	`package_digest` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	CONSTRAINT "skill_objects_package_digest_length" CHECK(length("skill_objects"."package_digest") = 64),
	CONSTRAINT "skill_objects_size_bytes_positive" CHECK("skill_objects"."size_bytes" > 0),
	CONSTRAINT "skill_objects_status" CHECK("skill_objects"."status" IN ('pending', 'committed')),
	CONSTRAINT "skill_objects_created_at_positive" CHECK("skill_objects"."created_at" > 0),
	CONSTRAINT "skill_objects_state" CHECK((
        ("skill_objects"."status" = 'pending' AND "skill_objects"."committed_at" IS NULL)
        OR ("skill_objects"."status" = 'committed'
          AND "skill_objects"."committed_at" IS NOT NULL
          AND "skill_objects"."committed_at" >= "skill_objects"."created_at")
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_objects_object_key_unique` ON `skill_objects` (`object_key`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`package_digest` text NOT NULL,
	`object_key` text NOT NULL,
	`file_count` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`warnings` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`skill_id`, `version`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`skill_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`package_digest`) REFERENCES `skill_objects`(`package_digest`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "skill_versions_version_positive" CHECK("skill_versions"."version" > 0),
	CONSTRAINT "skill_versions_package_digest_length" CHECK(length("skill_versions"."package_digest") = 64),
	CONSTRAINT "skill_versions_file_count_positive" CHECK("skill_versions"."file_count" > 0),
	CONSTRAINT "skill_versions_size_bytes_positive" CHECK("skill_versions"."size_bytes" > 0),
	CONSTRAINT "skill_versions_warnings_json" CHECK(json_valid("skill_versions"."warnings")),
	CONSTRAINT "skill_versions_provenance_json" CHECK(json_valid("skill_versions"."provenance")),
	CONSTRAINT "skill_versions_created_at_positive" CHECK("skill_versions"."created_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `skill_versions_object_key` ON `skill_versions` (`object_key`);--> statement-breakpoint
CREATE TABLE `skills` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	CONSTRAINT "skills_current_version_positive" CHECK("skills"."current_version" > 0),
	CONSTRAINT "skills_status" CHECK("skills"."status" IN ('active', 'retired')),
	CONSTRAINT "skills_created_at_positive" CHECK("skills"."created_at" > 0),
	CONSTRAINT "skills_updated_after_creation" CHECK("skills"."updated_at" >= "skills"."created_at"),
	CONSTRAINT "skills_state" CHECK((
        ("skills"."status" = 'active' AND "skills"."retired_at" IS NULL)
        OR ("skills"."status" = 'retired'
          AND "skills"."retired_at" IS NOT NULL
          AND "skills"."retired_at" >= "skills"."created_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `skills_status_id` ON `skills` (`status`,`skill_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `skills_active_name` ON `skills` (`name`) WHERE "skills"."status" = 'active';--> statement-breakpoint
CREATE TABLE `tool_approvals` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`grant_id` text,
	`action_digest` text NOT NULL,
	`client_id` text NOT NULL,
	`decision` text,
	`expires_at` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`grant_id`) REFERENCES `capability_grants`(`grant_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_approvals_action_digest_length" CHECK(length("tool_approvals"."action_digest") = 64),
	CONSTRAINT "tool_approvals_decision" CHECK("tool_approvals"."decision" IS NULL OR "tool_approvals"."decision" IN ('approved', 'rejected')),
	CONSTRAINT "tool_approvals_requested_at_positive" CHECK("tool_approvals"."requested_at" > 0),
	CONSTRAINT "tool_approvals_decision_state" CHECK((("tool_approvals"."decision" IS NULL AND "tool_approvals"."decided_at" IS NULL)
        OR ("tool_approvals"."decision" IS NOT NULL AND "tool_approvals"."decided_at" >= "tool_approvals"."requested_at"))),
	CONSTRAINT "tool_approvals_expiry_after_request" CHECK("tool_approvals"."expires_at" > coalesce("tool_approvals"."decided_at", "tool_approvals"."requested_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_approvals_tool_call_id_unique` ON `tool_approvals` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `tool_approvals_run` ON `tool_approvals` (`run_id`,`requested_at`);--> statement-breakpoint
CREATE TABLE `tool_executions` (
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
	CONSTRAINT "tool_executions_action_digest_length" CHECK(length("tool_executions"."action_digest") = 64),
	CONSTRAINT "tool_executions_effect_digest_length" CHECK(length("tool_executions"."effect_digest") = 64),
	CONSTRAINT "tool_executions_input_digest_length" CHECK(length("tool_executions"."input_digest") = 64),
	CONSTRAINT "tool_executions_nonce_digest_length" CHECK(length("tool_executions"."nonce_digest") = 43),
	CONSTRAINT "tool_executions_status" CHECK("tool_executions"."status" IN ('reserved', 'completed', 'failed', 'unknown')),
	CONSTRAINT "tool_executions_cost_nonnegative" CHECK("tool_executions"."cost_microusd" >= 0),
	CONSTRAINT "tool_executions_output_nonnegative" CHECK("tool_executions"."output_bytes" IS NULL OR "tool_executions"."output_bytes" >= 0),
	CONSTRAINT "tool_executions_started_at_positive" CHECK("tool_executions"."started_at" > 0),
	CONSTRAINT "tool_executions_dispatched_at_positive" CHECK("tool_executions"."dispatched_at" IS NULL OR "tool_executions"."dispatched_at" > 0),
	CONSTRAINT "tool_executions_dispatch_after_start" CHECK("tool_executions"."dispatched_at" IS NULL OR "tool_executions"."dispatched_at" >= "tool_executions"."started_at"),
	CONSTRAINT "tool_executions_expiry_after_start" CHECK("tool_executions"."expires_at" > "tool_executions"."started_at"),
	CONSTRAINT "tool_executions_completion_after_dispatch" CHECK("tool_executions"."completed_at" IS NULL
        OR "tool_executions"."dispatched_at" IS NULL
        OR "tool_executions"."completed_at" >= "tool_executions"."dispatched_at"),
	CONSTRAINT "tool_executions_reconciliation" CHECK("tool_executions"."reconciliation" IS NULL
        OR "tool_executions"."reconciliation" IN ('applied', 'not_applied')),
	CONSTRAINT "tool_executions_reconciliation_state" CHECK((
        ("tool_executions"."reconciliation" IS NULL AND "tool_executions"."reconciled_at" IS NULL)
        OR ("tool_executions"."reconciliation" = 'applied'
          AND "tool_executions"."status" = 'completed'
          AND "tool_executions"."reconciled_at" IS NOT NULL
          AND "tool_executions"."completed_at" IS NOT NULL
          AND "tool_executions"."reconciled_at" >= "tool_executions"."completed_at")
        OR ("tool_executions"."reconciliation" = 'not_applied'
          AND "tool_executions"."status" = 'failed'
          AND "tool_executions"."reconciled_at" IS NOT NULL
          AND "tool_executions"."completed_at" IS NOT NULL
          AND "tool_executions"."reconciled_at" >= "tool_executions"."completed_at")
      )),
	CONSTRAINT "tool_executions_state" CHECK((
        ("tool_executions"."status" = 'reserved'
          AND "tool_executions"."output_bytes" IS NULL
          AND "tool_executions"."completed_at" IS NULL)
        OR ("tool_executions"."status" = 'completed'
          AND "tool_executions"."dispatched_at" IS NOT NULL
          AND "tool_executions"."output_bytes" IS NOT NULL
          AND "tool_executions"."completed_at" IS NOT NULL
          AND "tool_executions"."completed_at" >= "tool_executions"."started_at")
        OR ("tool_executions"."status" IN ('failed', 'unknown')
          AND "tool_executions"."output_bytes" IS NOT NULL
          AND "tool_executions"."completed_at" IS NOT NULL
          AND "tool_executions"."completed_at" >= "tool_executions"."started_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `tool_executions_run` ON `tool_executions` (`run_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_grant_status` ON `tool_executions` (`grant_id`,`status`);--> statement-breakpoint
CREATE INDEX `tool_executions_effect_status` ON `tool_executions` (`effect_digest`,`status`);--> statement-breakpoint
CREATE INDEX `tool_executions_started_at` ON `tool_executions` (`started_at`);--> statement-breakpoint
CREATE INDEX `tool_executions_run_input` ON `tool_executions` (`run_id`,`grant_id`,`input_digest`);