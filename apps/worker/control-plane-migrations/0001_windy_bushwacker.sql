CREATE TABLE `run_admissions` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision` integer NOT NULL,
	`prompt_digest` text NOT NULL,
	`budget_reservation` text NOT NULL,
	`nonce_digest` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`cleanup_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`redeemed_at` integer,
	`model_call_consumed_at` integer,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`agent_id`,`agent_revision`) REFERENCES `agent_revisions`(`agent_id`,`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "run_admissions_request_digest_length" CHECK(length("run_admissions"."request_digest") = 43),
	CONSTRAINT "run_admissions_agent_revision_positive" CHECK("run_admissions"."agent_revision" > 0),
	CONSTRAINT "run_admissions_prompt_digest_length" CHECK(length("run_admissions"."prompt_digest") = 64),
	CONSTRAINT "run_admissions_nonce_digest_length" CHECK(length("run_admissions"."nonce_digest") = 43),
	CONSTRAINT "run_admissions_status" CHECK("run_admissions"."status" IN ('issued', 'redeemed', 'expired')),
	CONSTRAINT "run_admissions_expires_at_positive" CHECK("run_admissions"."expires_at" > 0),
	CONSTRAINT "run_admissions_cleanup_after_expiry" CHECK("run_admissions"."cleanup_at" > "run_admissions"."expires_at"),
	CONSTRAINT "run_admissions_created_at_positive" CHECK("run_admissions"."created_at" > 0),
	CONSTRAINT "run_admissions_model_call_consumed_at_positive" CHECK("run_admissions"."model_call_consumed_at" IS NULL OR "run_admissions"."model_call_consumed_at" > 0),
	CONSTRAINT "run_admissions_state" CHECK((
        ("run_admissions"."status" = 'issued'
          AND "run_admissions"."redeemed_at" IS NULL
          AND "run_admissions"."model_call_consumed_at" IS NULL)
        OR ("run_admissions"."status" = 'redeemed'
          AND "run_admissions"."redeemed_at" IS NOT NULL
          AND ("run_admissions"."model_call_consumed_at" IS NULL
            OR "run_admissions"."model_call_consumed_at" >= "run_admissions"."redeemed_at"))
        OR ("run_admissions"."status" = 'expired'
          AND "run_admissions"."redeemed_at" IS NULL
          AND "run_admissions"."model_call_consumed_at" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_admissions_run_id` ON `run_admissions` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_admissions_cleanup` ON `run_admissions` (`cleanup_at`);--> statement-breakpoint
CREATE INDEX `run_admissions_expiry` ON `run_admissions` (`expires_at`) WHERE "run_admissions"."status" = 'issued';