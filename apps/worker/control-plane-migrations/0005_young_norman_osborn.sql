PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tool_approvals` (
	`execution_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`tool_call_id` text NOT NULL,
	`action_digest` text NOT NULL,
	`client_id` text NOT NULL,
	`decision` text,
	`expires_at` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run_admissions`(`run_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "tool_approvals_action_digest_length" CHECK(length("__new_tool_approvals"."action_digest") = 64),
	CONSTRAINT "tool_approvals_decision" CHECK("__new_tool_approvals"."decision" IS NULL OR "__new_tool_approvals"."decision" IN ('approved', 'rejected')),
	CONSTRAINT "tool_approvals_requested_at_positive" CHECK("__new_tool_approvals"."requested_at" > 0),
	CONSTRAINT "tool_approvals_decision_state" CHECK((("__new_tool_approvals"."decision" IS NULL AND "__new_tool_approvals"."decided_at" IS NULL)
        OR ("__new_tool_approvals"."decision" IS NOT NULL AND "__new_tool_approvals"."decided_at" >= "__new_tool_approvals"."requested_at"))),
	CONSTRAINT "tool_approvals_expiry_after_request" CHECK("__new_tool_approvals"."expires_at" > coalesce("__new_tool_approvals"."decided_at", "__new_tool_approvals"."requested_at"))
);
--> statement-breakpoint
INSERT INTO `__new_tool_approvals`("execution_id", "run_id", "tool_call_id", "action_digest", "client_id", "decision", "expires_at", "requested_at", "decided_at") SELECT "execution_id", "run_id", "tool_call_id", "action_digest", "client_id", "decision", "expires_at", "requested_at", "decided_at" FROM `tool_approvals`;--> statement-breakpoint
DROP TABLE `tool_approvals`;--> statement-breakpoint
ALTER TABLE `__new_tool_approvals` RENAME TO `tool_approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tool_approvals_tool_call_id_unique` ON `tool_approvals` (`tool_call_id`);--> statement-breakpoint
CREATE INDEX `tool_approvals_run` ON `tool_approvals` (`run_id`,`requested_at`);