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
CREATE TABLE `agent_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`instructions` text NOT NULL,
	`execution_limits` text NOT NULL,
	`capability_grants` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_positive" CHECK("agent_revisions"."revision" > 0),
	CONSTRAINT "agent_revisions_capability_grants_empty" CHECK("agent_revisions"."capability_grants" = '[]'),
	CONSTRAINT "agent_revisions_created_at_positive" CHECK("agent_revisions"."created_at" > 0)
);
--> statement-breakpoint
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
CREATE TABLE `agents` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "agents_current_revision_positive" CHECK("agents"."current_revision" > 0),
	CONSTRAINT "agents_created_at_positive" CHECK("agents"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `audit_events` (
	`event_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`client_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_events_occurred_at_positive" CHECK("audit_events"."occurred_at" > 0)
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
	`provider_connection_id` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "connections_provider_composio" CHECK("connections"."provider" = 'composio'),
	CONSTRAINT "connections_status_initiated" CHECK("connections"."status" = 'initiated'),
	CONSTRAINT "connections_created_at_positive" CHECK("connections"."created_at" > 0)
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
CREATE UNIQUE INDEX `control_plane_migrations_name_unique` ON `control_plane_migrations` (`name`);