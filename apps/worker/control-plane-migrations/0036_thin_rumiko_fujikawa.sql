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
CREATE INDEX `provider_auth_setup_requests_status_expiry` ON `provider_auth_setup_requests` (`status`,`setup_expires_at`);