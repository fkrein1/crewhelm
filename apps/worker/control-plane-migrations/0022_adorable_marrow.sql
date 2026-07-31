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
	`fleet_revision` integer NOT NULL,
	`objective` text NOT NULL,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	`cleanup_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fleet_revision`) REFERENCES `fleet_configuration_revisions`(`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_workflows_request_digest_length" CHECK(length("agent_workflows"."request_digest") = 43),
	CONSTRAINT "agent_workflows_objective_length" CHECK(length("agent_workflows"."objective") BETWEEN 1 AND 4096),
	CONSTRAINT "agent_workflows_budget_json" CHECK(json_valid("agent_workflows"."budget")),
	CONSTRAINT "agent_workflows_status" CHECK("agent_workflows"."status" IN ('queued', 'running', 'waiting', 'cancelling', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "agent_workflows_revision_positive" CHECK("agent_workflows"."workflow_revision" > 0),
	CONSTRAINT "agent_workflows_stage_count" CHECK("agent_workflows"."stage_count" BETWEEN 2 AND 8),
	CONSTRAINT "agent_workflows_completed_stages" CHECK("agent_workflows"."completed_stages" BETWEEN 0 AND "agent_workflows"."stage_count"),
	CONSTRAINT "agent_workflows_current_stage" CHECK("agent_workflows"."current_stage_index" IS NULL OR "agent_workflows"."current_stage_index" BETWEEN 0 AND "agent_workflows"."stage_count" - 1),
	CONSTRAINT "agent_workflows_session_json" CHECK("agent_workflows"."session" IS NULL OR json_valid("agent_workflows"."session")),
	CONSTRAINT "agent_workflows_failure" CHECK(("agent_workflows"."failure_code" IS NULL AND "agent_workflows"."failure_stage_index" IS NULL)
        OR ("agent_workflows"."failure_code" IN ('agent_unavailable', 'budget_exhausted', 'capability_unavailable', 'coordinator_failed', 'model_unavailable', 'revision_conflict', 'run_failed', 'workflow_unavailable')
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
	`schedule_revision` integer,
	`trigger` text DEFAULT 'manual' NOT NULL,
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
	CONSTRAINT "run_admissions_request_digest_length" CHECK(length("__new_run_admissions"."request_digest") = 43),
	CONSTRAINT "run_admissions_agent_revision_positive" CHECK("__new_run_admissions"."agent_revision" > 0),
	CONSTRAINT "run_admissions_prompt_length" CHECK("__new_run_admissions"."prompt" IS NULL OR length("__new_run_admissions"."prompt") BETWEEN 1 AND 16384),
	CONSTRAINT "run_admissions_prompt_digest_length" CHECK(length("__new_run_admissions"."prompt_digest") = 64),
	CONSTRAINT "run_admissions_schedule_revision_positive" CHECK("__new_run_admissions"."schedule_revision" IS NULL OR "__new_run_admissions"."schedule_revision" > 0),
	CONSTRAINT "run_admissions_trigger" CHECK("__new_run_admissions"."trigger" IN ('manual', 'schedule', 'workflow')),
	CONSTRAINT "run_admissions_nonce_digest_length" CHECK(length("__new_run_admissions"."nonce_digest") = 43),
	CONSTRAINT "run_admissions_status" CHECK("__new_run_admissions"."status" IN ('issued', 'redeemed', 'expired')),
	CONSTRAINT "run_admissions_failure_code" CHECK("__new_run_admissions"."failure_code" IS NULL OR "__new_run_admissions"."failure_code" = 'skill_unavailable'),
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
          AND "__new_run_admissions"."failure_code" IS NULL
          AND "__new_run_admissions"."redeemed_at" IS NULL
          AND "__new_run_admissions"."model_call_consumed_at" IS NULL
          AND "__new_run_admissions"."model_calls_consumed" = 0)
        OR ("__new_run_admissions"."status" = 'redeemed'
          AND "__new_run_admissions"."failure_code" IS NULL
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
INSERT INTO `__new_run_admissions`("client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt", "prompt_digest", "schedule_revision", "trigger", "budget_reservation", "nonce_digest", "status", "failure_code", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed") SELECT "client_id", "idempotency_key", "request_digest", "run_id", "agent_id", "agent_revision", "prompt", "prompt_digest", "schedule_revision", "trigger", "budget_reservation", "nonce_digest", "status", "failure_code", "expires_at", "cleanup_at", "created_at", "redeemed_at", "cancellation_requested_at", "cancelled_at", "model_call_consumed_at", "model_calls_consumed", "tool_calls_consumed" FROM `run_admissions`;--> statement-breakpoint
DROP TABLE `run_admissions`;--> statement-breakpoint
ALTER TABLE `__new_run_admissions` RENAME TO `run_admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';