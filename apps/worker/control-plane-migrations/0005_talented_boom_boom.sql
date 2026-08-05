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
	`checkpoint_resume_at` integer,
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
	CONSTRAINT "agent_workflow_stages_attempts" CHECK("__new_agent_workflow_stages"."attempt_count" BETWEEN 0 AND 121),
	CONSTRAINT "agent_workflow_stages_checkpoint" CHECK(("__new_agent_workflow_stages"."checkpoint_state" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_run_id" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_resume_at" IS NULL)
        OR ("__new_agent_workflow_stages"."checkpoint_state" = 'done'
          AND "__new_agent_workflow_stages"."checkpoint_run_id" = "__new_agent_workflow_stages"."run_id"
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" IS NULL
          AND "__new_agent_workflow_stages"."checkpoint_resume_at" IS NULL)
        OR ("__new_agent_workflow_stages"."checkpoint_state" = 'wait'
          AND "__new_agent_workflow_stages"."checkpoint_run_id" = "__new_agent_workflow_stages"."run_id"
          AND "__new_agent_workflow_stages"."checkpoint_delay_seconds" BETWEEN 30 AND 7200
          AND "__new_agent_workflow_stages"."checkpoint_resume_at" IS NOT NULL)),
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
INSERT INTO `__new_agent_workflow_stages`("workflow_id", "stage_index", "name", "prompt", "delay_before_seconds", "max_wait_seconds", "prompt_digest", "status", "run_id", "attempt_count", "checkpoint_run_id", "checkpoint_state", "checkpoint_delay_seconds", "checkpoint_resume_at", "last_defer_reason", "last_run_id", "next_attempt_at", "started_at", "completed_at") SELECT "workflow_id", "stage_index", "name", "prompt", "delay_before_seconds", "max_wait_seconds", "prompt_digest", "status", "run_id", "attempt_count", "checkpoint_run_id", "checkpoint_state", "checkpoint_delay_seconds", NULL, "last_defer_reason", "last_run_id", "next_attempt_at", "started_at", "completed_at" FROM `agent_workflow_stages`;--> statement-breakpoint
DROP TABLE `agent_workflow_stages`;--> statement-breakpoint
ALTER TABLE `__new_agent_workflow_stages` RENAME TO `agent_workflow_stages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_workflow_stages_run` ON `agent_workflow_stages` (`run_id`);
