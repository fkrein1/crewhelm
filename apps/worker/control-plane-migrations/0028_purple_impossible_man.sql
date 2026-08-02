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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_schedules` (
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
	CONSTRAINT "agent_schedules_current_revision_positive" CHECK("__new_agent_schedules"."current_revision" > 0),
	CONSTRAINT "agent_schedules_status" CHECK("__new_agent_schedules"."status" IN ('active', 'paused', 'deleted')),
	CONSTRAINT "agent_schedules_created_at_positive" CHECK("__new_agent_schedules"."created_at" > 0),
	CONSTRAINT "agent_schedules_dispatch_state" CHECK((("__new_agent_schedules"."last_run_id" IS NULL AND "__new_agent_schedules"."last_dispatched_at" IS NULL)
        OR ("__new_agent_schedules"."last_run_id" IS NOT NULL
          AND "__new_agent_schedules"."last_dispatched_at" IS NOT NULL
          AND "__new_agent_schedules"."last_dispatched_at" >= "__new_agent_schedules"."created_at"))),
	CONSTRAINT "agent_schedules_state" CHECK((("__new_agent_schedules"."status" = 'active' AND "__new_agent_schedules"."next_run_at" IS NOT NULL)
        OR ("__new_agent_schedules"."status" IN ('paused', 'deleted') AND "__new_agent_schedules"."next_run_at" IS NULL)))
);
--> statement-breakpoint
INSERT INTO `__new_agent_schedules`("schedule_id", "agent_id", "current_revision", "status", "next_run_at", "last_run_id", "last_dispatched_at", "created_at") SELECT "schedule_id", "agent_id", "current_revision", "status", "next_run_at", "last_run_id", "last_dispatched_at", "created_at" FROM `agent_schedules`;--> statement-breakpoint
DROP TABLE `agent_schedules`;--> statement-breakpoint
ALTER TABLE `__new_agent_schedules` RENAME TO `agent_schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_schedules_agent` ON `agent_schedules` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_schedules_due` ON `agent_schedules` (`next_run_at`) WHERE "agent_schedules"."status" = 'active';