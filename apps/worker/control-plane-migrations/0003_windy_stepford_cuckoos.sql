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
CREATE UNIQUE INDEX `integration_enablement_requests_pending_slug` ON `integration_enablement_requests` (`integration_slug`) WHERE "integration_enablement_requests"."status" = 'pending';