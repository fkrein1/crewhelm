PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_workflow_stages` (
	`workflow_id` text NOT NULL,
	`stage_index` integer NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`delay_before_seconds` integer DEFAULT 0 NOT NULL,
	`max_wait_seconds` integer,
	`prompt_digest` text NOT NULL,
	`status` text NOT NULL,
	`run_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`checkpoint_run_id` text,
	`checkpoint_state` text,
	`checkpoint_delay_seconds` integer,
	`last_defer_reason` text,
	`last_run_id` text,
	`next_attempt_at` integer,
	`started_at` integer,
	`completed_at` integer,
	PRIMARY KEY(`workflow_id`, `stage_index`),
	FOREIGN KEY (`workflow_id`) REFERENCES `agent_workflows`(`workflow_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_workflow_stages_index" CHECK("__new_agent_workflow_stages"."stage_index" BETWEEN 0 AND 7),
	CONSTRAINT "agent_workflow_stages_name_length" CHECK(length("__new_agent_workflow_stages"."name") BETWEEN 1 AND 80),
	CONSTRAINT "agent_workflow_stages_prompt_length" CHECK(length("__new_agent_workflow_stages"."prompt") BETWEEN 1 AND 11264),
	CONSTRAINT "agent_workflow_stages_delay" CHECK("__new_agent_workflow_stages"."delay_before_seconds" BETWEEN 0 AND 604800),
	CONSTRAINT "agent_workflow_stages_max_wait" CHECK("__new_agent_workflow_stages"."max_wait_seconds" IS NULL OR "__new_agent_workflow_stages"."max_wait_seconds" BETWEEN 30 AND 604800),
	CONSTRAINT "agent_workflow_stages_attempts" CHECK("__new_agent_workflow_stages"."attempt_count" BETWEEN 0 AND 61),
	CONSTRAINT "agent_workflow_stages_checkpoint" CHECK(("__new_agent_workflow_stages"."checkpoint_state" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_run_id" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" IS NULL)
        OR ("__new_agent_workflow_stages"."checkpoint_state" = 'done'
          AND "__new_agent_workflow_stages"."checkpoint_run_id" = "__new_agent_workflow_stages"."run_id"
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" IS NULL)
        OR ("__new_agent_workflow_stages"."checkpoint_state" = 'wait'
          AND "__new_agent_workflow_stages"."checkpoint_run_id" = "__new_agent_workflow_stages"."run_id"
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" BETWEEN 30 AND 7200)),
	CONSTRAINT "agent_workflow_stages_prompt_digest_length" CHECK(length("__new_agent_workflow_stages"."prompt_digest") = 64),
	CONSTRAINT "agent_workflow_stages_status" CHECK("__new_agent_workflow_stages"."status" IN ('pending', 'running', 'waiting', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_workflow_stages_state" CHECK((("__new_agent_workflow_stages"."status" = 'pending'
          AND "__new_agent_workflow_stages"."run_id" IS NULL
          AND "__new_agent_workflow_stages"."started_at" IS NULL
          AND "__new_agent_workflow_stages"."completed_at" IS NULL)
        OR ("__new_agent_workflow_stages"."status" = 'waiting'
          AND (("__new_agent_workflow_stages"."run_id" IS NULL AND "__new_agent_workflow_stages"."next_attempt_at" IS NOT NULL)
            OR ("__new_agent_workflow_stages"."run_id" IS NOT NULL AND "__new_agent_workflow_stages"."next_attempt_at" IS NULL))
          AND "__new_agent_workflow_stages"."started_at" IS NOT NULL
          AND "__new_agent_workflow_stages"."completed_at" IS NULL)
        OR ("__new_agent_workflow_stages"."status" = 'running'
          AND "__new_agent_workflow_stages"."run_id" IS NOT NULL
          AND "__new_agent_workflow_stages"."started_at" IS NOT NULL
          AND "__new_agent_workflow_stages"."completed_at" IS NULL)
        OR ("__new_agent_workflow_stages"."status" IN ('completed', 'cancelled')
          AND ("__new_agent_workflow_stages"."run_id" IS NOT NULL OR "__new_agent_workflow_stages"."status" = 'cancelled')
          AND "__new_agent_workflow_stages"."started_at" IS NOT NULL
          AND "__new_agent_workflow_stages"."completed_at" IS NOT NULL
          AND "__new_agent_workflow_stages"."completed_at" >= "__new_agent_workflow_stages"."started_at")
        OR ("__new_agent_workflow_stages"."status" = 'failed'
          AND "__new_agent_workflow_stages"."completed_at" IS NOT NULL
          AND (("__new_agent_workflow_stages"."run_id" IS NULL AND "__new_agent_workflow_stages"."started_at" IS NULL)
            OR ("__new_agent_workflow_stages"."run_id" IS NOT NULL
              AND "__new_agent_workflow_stages"."started_at" IS NOT NULL
              AND "__new_agent_workflow_stages"."completed_at" >= "__new_agent_workflow_stages"."started_at")))))
);
--> statement-breakpoint
INSERT INTO `__new_agent_workflow_stages`("workflow_id", "stage_index", "name", "prompt", "delay_before_seconds", "max_wait_seconds", "prompt_digest", "status", "run_id", "attempt_count", "checkpoint_run_id", "checkpoint_state", "checkpoint_delay_seconds", "last_defer_reason", "last_run_id", "next_attempt_at", "started_at", "completed_at") SELECT "workflow_id", "stage_index", "name", "prompt", 0, NULL, "prompt_digest", "status", "run_id", CASE WHEN "run_id" IS NULL THEN 0 ELSE 1 END, NULL, NULL, NULL, NULL, NULL, NULL, "started_at", "completed_at" FROM `agent_workflow_stages`;--> statement-breakpoint
DROP TABLE `agent_workflow_stages`;--> statement-breakpoint
ALTER TABLE `__new_agent_workflow_stages` RENAME TO `agent_workflow_stages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflow_stages_run` ON `agent_workflow_stages` (`run_id`);--> statement-breakpoint
CREATE TABLE `__new_agent_workflows` (
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
	`deferral_count` integer DEFAULT 0 NOT NULL,
	`waiting_until` integer,
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
	CONSTRAINT "agent_workflows_request_digest_length" CHECK(length("__new_agent_workflows"."request_digest") = 43),
	CONSTRAINT "agent_workflows_objective_length" CHECK(length("__new_agent_workflows"."objective") BETWEEN 1 AND 4096),
	CONSTRAINT "agent_workflows_budget_json" CHECK(json_valid("__new_agent_workflows"."budget")),
	CONSTRAINT "agent_workflows_output_contract_json" CHECK("__new_agent_workflows"."output_contract" IS NULL OR json_valid("__new_agent_workflows"."output_contract")),
	CONSTRAINT "agent_workflows_brief_context_json" CHECK("__new_agent_workflows"."brief_context" IS NULL OR json_valid("__new_agent_workflows"."brief_context")),
	CONSTRAINT "agent_workflows_deliverable_json" CHECK("__new_agent_workflows"."deliverable" IS NULL OR json_valid("__new_agent_workflows"."deliverable")),
	CONSTRAINT "agent_workflows_deliverable_state" CHECK(("__new_agent_workflows"."deliverable" IS NULL AND "__new_agent_workflows"."deliverable_object_key" IS NULL)
        OR ("__new_agent_workflows"."deliverable" IS NOT NULL AND "__new_agent_workflows"."deliverable_object_key" IS NOT NULL)),
	CONSTRAINT "agent_workflows_status" CHECK("__new_agent_workflows"."status" IN ('queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_workflows_revision_positive" CHECK("__new_agent_workflows"."workflow_revision" > 0),
	CONSTRAINT "agent_workflows_stage_count" CHECK("__new_agent_workflows"."stage_count" BETWEEN 2 AND 8),
	CONSTRAINT "agent_workflows_completed_stages" CHECK("__new_agent_workflows"."completed_stages" BETWEEN 0 AND "__new_agent_workflows"."stage_count"),
	CONSTRAINT "agent_workflows_deferral_count" CHECK("__new_agent_workflows"."deferral_count" BETWEEN 0 AND 120),
	CONSTRAINT "agent_workflows_current_stage" CHECK("__new_agent_workflows"."current_stage_index" IS NULL OR "__new_agent_workflows"."current_stage_index" BETWEEN 0 AND "__new_agent_workflows"."stage_count" - 1),
	CONSTRAINT "agent_workflows_delay_state" CHECK("__new_agent_workflows"."waiting_until" IS NULL OR (
        "__new_agent_workflows"."status" IN ('waiting', 'cancelling')
        AND "__new_agent_workflows"."current_stage_index" IS NOT NULL
        AND "__new_agent_workflows"."current_run_id" IS NULL
        AND "__new_agent_workflows"."waiting_until" >= "__new_agent_workflows"."created_at")),
	CONSTRAINT "agent_workflows_session_json" CHECK("__new_agent_workflows"."session" IS NULL OR json_valid("__new_agent_workflows"."session")),
	CONSTRAINT "agent_workflows_failure" CHECK(("__new_agent_workflows"."failure_code" IS NULL AND "__new_agent_workflows"."failure_stage_index" IS NULL)
        OR ("__new_agent_workflows"."failure_code" IN ('agent_unavailable', 'brief_unavailable', 'budget_exhausted', 'capability_unavailable', 'coordinator_failed', 'model_unavailable', 'revision_conflict', 'run_failed', 'workflow_unavailable')
          AND "__new_agent_workflows"."failure_stage_index" BETWEEN 0 AND "__new_agent_workflows"."stage_count" - 1)),
	CONSTRAINT "agent_workflows_created_at_positive" CHECK("__new_agent_workflows"."created_at" > 0),
	CONSTRAINT "agent_workflows_updated_after_creation" CHECK("__new_agent_workflows"."updated_at" >= "__new_agent_workflows"."created_at"),
	CONSTRAINT "agent_workflows_cleanup_after_creation" CHECK("__new_agent_workflows"."cleanup_at" > "__new_agent_workflows"."created_at"),
	CONSTRAINT "agent_workflows_terminal_state" CHECK((("__new_agent_workflows"."status" IN ('completed', 'failed', 'cancelled')
          AND "__new_agent_workflows"."completed_at" IS NOT NULL
          AND "__new_agent_workflows"."completed_at" >= "__new_agent_workflows"."created_at")
        OR ("__new_agent_workflows"."status" NOT IN ('completed', 'failed', 'cancelled')
          AND "__new_agent_workflows"."completed_at" IS NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_agent_workflows`("workflow_id", "client_id", "idempotency_key", "request_digest", "agent_id", "agent_revision", "brief_context", "fleet_revision", "objective", "output_contract", "budget", "status", "workflow_revision", "stage_count", "completed_stages", "current_stage_index", "current_run_id", "deferral_count", "waiting_until", "session", "failure_code", "failure_stage_index", "cancellation_requested_at", "deleting_at", "deliverable", "deliverable_object_key", "created_at", "updated_at", "completed_at", "cleanup_at") SELECT "workflow_id", "client_id", "idempotency_key", "request_digest", "agent_id", "agent_revision", "brief_context", "fleet_revision", "objective", "output_contract", "budget", "status", "workflow_revision", "stage_count", "completed_stages", "current_stage_index", "current_run_id", 0, NULL, "session", "failure_code", "failure_stage_index", "cancellation_requested_at", "deleting_at", "deliverable", "deliverable_object_key", "created_at", "updated_at", "completed_at", "cleanup_at" FROM `agent_workflows`;--> statement-breakpoint
DROP TABLE `agent_workflows`;--> statement-breakpoint
ALTER TABLE `__new_agent_workflows` RENAME TO `agent_workflows`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflows_client_idempotency` ON `agent_workflows` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `agent_workflows_agent_created` ON `agent_workflows` (`agent_id`,`workflow_id`);--> statement-breakpoint
CREATE INDEX `agent_workflows_cleanup` ON `agent_workflows` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `agent_workflows_status_updated` ON `agent_workflows` (`status`,`updated_at`);
