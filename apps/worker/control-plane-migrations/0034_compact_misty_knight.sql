CREATE TABLE `mcp_authoring_drafts` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`content_digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`last_idempotency_key` text,
	`last_request_digest` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mcp_authoring_drafts_request_digest_length" CHECK(length("mcp_authoring_drafts"."request_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_kind" CHECK("mcp_authoring_drafts"."kind" IN ('agent-blueprint-package', 'recipe-installation', 'recipe-publication', 'skill-package')),
	CONSTRAINT "mcp_authoring_drafts_revision_positive" CHECK("mcp_authoring_drafts"."revision" > 0),
	CONSTRAINT "mcp_authoring_drafts_content_json" CHECK(json_valid("mcp_authoring_drafts"."content")),
	CONSTRAINT "mcp_authoring_drafts_content_digest_length" CHECK(length("mcp_authoring_drafts"."content_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_size" CHECK("mcp_authoring_drafts"."size_bytes" BETWEEN 2 AND 163840),
	CONSTRAINT "mcp_authoring_drafts_last_request_digest" CHECK("mcp_authoring_drafts"."last_request_digest" IS NULL OR length("mcp_authoring_drafts"."last_request_digest") = 64),
	CONSTRAINT "mcp_authoring_drafts_expires_at_positive" CHECK("mcp_authoring_drafts"."expires_at" > 0),
	CONSTRAINT "mcp_authoring_drafts_created_at_positive" CHECK("mcp_authoring_drafts"."created_at" > 0),
	CONSTRAINT "mcp_authoring_drafts_updated_after_creation" CHECK("mcp_authoring_drafts"."updated_at" >= "mcp_authoring_drafts"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_authoring_drafts_client_idempotency` ON `mcp_authoring_drafts` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `mcp_authoring_drafts_client_expiry` ON `mcp_authoring_drafts` (`client_id`,`expires_at`);