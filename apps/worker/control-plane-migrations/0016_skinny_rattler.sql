PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_inbox_items` (
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
	CONSTRAINT "agent_inbox_items_agent_revision" CHECK("__new_agent_inbox_items"."agent_revision" > 0),
	CONSTRAINT "agent_inbox_items_fleet_revision" CHECK("__new_agent_inbox_items"."fleet_revision" > 0),
	CONSTRAINT "agent_inbox_items_schedule_revision" CHECK("__new_agent_inbox_items"."schedule_revision" IS NULL OR "__new_agent_inbox_items"."schedule_revision" > 0),
	CONSTRAINT "agent_inbox_items_kind" CHECK("__new_agent_inbox_items"."kind" IN ('action_required', 'deferred', 'exception', 'outcome')),
	CONSTRAINT "agent_inbox_items_approval_count" CHECK("__new_agent_inbox_items"."approval_count" BETWEEN 0 AND 100),
	CONSTRAINT "agent_inbox_items_request_preview" CHECK(length("__new_agent_inbox_items"."request_preview") BETWEEN 1 AND 240),
	CONSTRAINT "agent_inbox_items_result_preview" CHECK("__new_agent_inbox_items"."result_preview" IS NULL OR length("__new_agent_inbox_items"."result_preview") BETWEEN 1 AND 240),
	CONSTRAINT "agent_inbox_items_reason" CHECK("__new_agent_inbox_items"."reason" IS NULL OR "__new_agent_inbox_items"."reason" IN (
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
        ("__new_agent_inbox_items"."kind" = 'deferred'
          AND "__new_agent_inbox_items"."run_id" IS NULL
          AND "__new_agent_inbox_items"."trigger" IS NULL
          AND "__new_agent_inbox_items"."run_status" IS NULL
          AND "__new_agent_inbox_items"."schedule_revision" IS NOT NULL
          AND "__new_agent_inbox_items"."reason" IS NOT NULL
          AND "__new_agent_inbox_items"."scheduled_at" IS NOT NULL
          AND "__new_agent_inbox_items"."approval_count" = 0
          AND "__new_agent_inbox_items"."result_preview" IS NULL)
        OR
        ("__new_agent_inbox_items"."kind" <> 'deferred'
          AND "__new_agent_inbox_items"."run_id" IS NOT NULL
          AND "__new_agent_inbox_items"."trigger" IS NOT NULL
          AND "__new_agent_inbox_items"."run_status" IS NOT NULL
          AND "__new_agent_inbox_items"."reason" IS NULL
          AND "__new_agent_inbox_items"."scheduled_at" IS NULL
          AND "__new_agent_inbox_items"."retry_at" IS NULL
          AND (("__new_agent_inbox_items"."kind" = 'action_required' AND "__new_agent_inbox_items"."approval_count" > 0)
            OR ("__new_agent_inbox_items"."kind" <> 'action_required' AND "__new_agent_inbox_items"."approval_count" = 0))
          AND (("__new_agent_inbox_items"."kind" = 'action_required' AND "__new_agent_inbox_items"."run_status" = 'running')
            OR ("__new_agent_inbox_items"."kind" = 'exception' AND "__new_agent_inbox_items"."run_status" = 'failed')
            OR ("__new_agent_inbox_items"."kind" = 'outcome'
              AND "__new_agent_inbox_items"."run_status" IN ('cancelled', 'completed'))))
      )),
	CONSTRAINT "agent_inbox_items_scheduled_at" CHECK("__new_agent_inbox_items"."scheduled_at" IS NULL OR "__new_agent_inbox_items"."scheduled_at" > 0),
	CONSTRAINT "agent_inbox_items_retry_at" CHECK("__new_agent_inbox_items"."retry_at" IS NULL OR "__new_agent_inbox_items"."retry_at" > "__new_agent_inbox_items"."scheduled_at"),
	CONSTRAINT "agent_inbox_items_occurred_at" CHECK("__new_agent_inbox_items"."occurred_at" > 0),
	CONSTRAINT "agent_inbox_items_cleanup_after_occurrence" CHECK("__new_agent_inbox_items"."cleanup_at" > "__new_agent_inbox_items"."occurred_at")
);
--> statement-breakpoint
INSERT INTO `__new_agent_inbox_items`("item_id", "agent_id", "agent_revision", "fleet_revision", "schedule_revision", "run_id", "trigger", "run_status", "kind", "approval_count", "request_preview", "result_preview", "reason", "scheduled_at", "retry_at", "occurred_at", "version", "cleanup_at") SELECT "item_id", "agent_id", "agent_revision", "fleet_revision", "schedule_revision", "run_id", "trigger", "run_status", "kind", "approval_count", "request_preview", "result_preview", "reason", "scheduled_at", "retry_at", "occurred_at", "version", "cleanup_at" FROM `agent_inbox_items`;--> statement-breakpoint
DROP TABLE `agent_inbox_items`;--> statement-breakpoint
ALTER TABLE `__new_agent_inbox_items` RENAME TO `agent_inbox_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_items_run` ON `agent_inbox_items` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_inbox_items_schedule_occurrence` ON `agent_inbox_items` (`agent_id`,`schedule_revision`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_agent_occurred` ON `agent_inbox_items` (`agent_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_cleanup` ON `agent_inbox_items` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_kind_occurred` ON `agent_inbox_items` (`kind`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `agent_inbox_items_occurred` ON `agent_inbox_items` (`occurred_at`);