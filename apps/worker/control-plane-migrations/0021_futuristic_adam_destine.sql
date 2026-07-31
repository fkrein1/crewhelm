CREATE TABLE `agent_blueprint_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`blueprint_id`,`version`) REFERENCES `agent_blueprint_versions`(`blueprint_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_blueprint_mutations_request_digest_length" CHECK(length("agent_blueprint_mutations"."request_digest") = 43),
	CONSTRAINT "agent_blueprint_mutations_operation" CHECK("agent_blueprint_mutations"."operation" IN ('publish', 'retire')),
	CONSTRAINT "agent_blueprint_mutations_version_positive" CHECK("agent_blueprint_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_blueprint_versions` (
	`blueprint_id` text NOT NULL,
	`version` integer NOT NULL,
	`package` text NOT NULL,
	`package_digest` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blueprint_id`, `version`),
	FOREIGN KEY (`blueprint_id`) REFERENCES `agent_blueprints`(`blueprint_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_blueprint_versions_version_positive" CHECK("agent_blueprint_versions"."version" > 0),
	CONSTRAINT "agent_blueprint_versions_package_json" CHECK(json_valid("agent_blueprint_versions"."package")),
	CONSTRAINT "agent_blueprint_versions_package_digest_length" CHECK(length("agent_blueprint_versions"."package_digest") = 64),
	CONSTRAINT "agent_blueprint_versions_size_bytes_positive" CHECK("agent_blueprint_versions"."size_bytes" > 0),
	CONSTRAINT "agent_blueprint_versions_created_at_positive" CHECK("agent_blueprint_versions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `agent_blueprints` (
	`blueprint_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	CONSTRAINT "agent_blueprints_current_version_positive" CHECK("agent_blueprints"."current_version" > 0),
	CONSTRAINT "agent_blueprints_status" CHECK("agent_blueprints"."status" IN ('active', 'retired')),
	CONSTRAINT "agent_blueprints_created_at_positive" CHECK("agent_blueprints"."created_at" > 0),
	CONSTRAINT "agent_blueprints_updated_after_creation" CHECK("agent_blueprints"."updated_at" >= "agent_blueprints"."created_at"),
	CONSTRAINT "agent_blueprints_state" CHECK((
        ("agent_blueprints"."status" = 'active' AND "agent_blueprints"."retired_at" IS NULL)
        OR ("agent_blueprints"."status" = 'retired'
          AND "agent_blueprints"."retired_at" IS NOT NULL
          AND "agent_blueprints"."retired_at" >= "agent_blueprints"."created_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `agent_blueprints_status_id` ON `agent_blueprints` (`status`,`blueprint_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_blueprints_active_name` ON `agent_blueprints` (`name`) WHERE "agent_blueprints"."status" = 'active';--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`capabilities` text NOT NULL,
	`instructions` text NOT NULL,
	`execution_limits` text NOT NULL,
	`capability_grants` text NOT NULL,
	`blueprint_provenance` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_positive" CHECK("__new_agent_revisions"."revision" > 0),
	CONSTRAINT "agent_revisions_capabilities_json" CHECK(json_valid("__new_agent_revisions"."capabilities")),
	CONSTRAINT "agent_revisions_capability_grants_json" CHECK(json_valid("__new_agent_revisions"."capability_grants")),
	CONSTRAINT "agent_revisions_blueprint_provenance_json" CHECK("__new_agent_revisions"."blueprint_provenance" IS NULL OR json_valid("__new_agent_revisions"."blueprint_provenance")),
	CONSTRAINT "agent_revisions_created_at_positive" CHECK("__new_agent_revisions"."created_at" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_revisions`("agent_id", "revision", "name", "model", "capabilities", "instructions", "execution_limits", "capability_grants", "blueprint_provenance", "created_at") SELECT "agent_id", "revision", "name", "model", "capabilities", "instructions", "execution_limits", "capability_grants", NULL, "created_at" FROM `agent_revisions`;--> statement-breakpoint
DROP TABLE `agent_revisions`;--> statement-breakpoint
ALTER TABLE `__new_agent_revisions` RENAME TO `agent_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
