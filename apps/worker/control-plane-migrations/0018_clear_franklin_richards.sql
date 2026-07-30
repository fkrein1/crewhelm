CREATE TABLE `skill_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`skill_id`,`version`) REFERENCES `skill_versions`(`skill_id`,`version`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "skill_mutations_request_digest_length" CHECK(length("skill_mutations"."request_digest") = 43),
	CONSTRAINT "skill_mutations_operation" CHECK("skill_mutations"."operation" IN ('publish', 'retire')),
	CONSTRAINT "skill_mutations_version_positive" CHECK("skill_mutations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `skill_objects` (
	`package_digest` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`committed_at` integer,
	CONSTRAINT "skill_objects_package_digest_length" CHECK(length("skill_objects"."package_digest") = 64),
	CONSTRAINT "skill_objects_size_bytes_positive" CHECK("skill_objects"."size_bytes" > 0),
	CONSTRAINT "skill_objects_status" CHECK("skill_objects"."status" IN ('pending', 'committed')),
	CONSTRAINT "skill_objects_created_at_positive" CHECK("skill_objects"."created_at" > 0),
	CONSTRAINT "skill_objects_state" CHECK((
        ("skill_objects"."status" = 'pending' AND "skill_objects"."committed_at" IS NULL)
        OR ("skill_objects"."status" = 'committed'
          AND "skill_objects"."committed_at" IS NOT NULL
          AND "skill_objects"."committed_at" >= "skill_objects"."created_at")
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_objects_object_key_unique` ON `skill_objects` (`object_key`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`package_digest` text NOT NULL,
	`object_key` text NOT NULL,
	`file_count` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`warnings` text NOT NULL,
	`provenance` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`skill_id`, `version`),
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`skill_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`package_digest`) REFERENCES `skill_objects`(`package_digest`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "skill_versions_version_positive" CHECK("skill_versions"."version" > 0),
	CONSTRAINT "skill_versions_package_digest_length" CHECK(length("skill_versions"."package_digest") = 64),
	CONSTRAINT "skill_versions_file_count_positive" CHECK("skill_versions"."file_count" > 0),
	CONSTRAINT "skill_versions_size_bytes_positive" CHECK("skill_versions"."size_bytes" > 0),
	CONSTRAINT "skill_versions_warnings_json" CHECK(json_valid("skill_versions"."warnings")),
	CONSTRAINT "skill_versions_provenance_json" CHECK(json_valid("skill_versions"."provenance")),
	CONSTRAINT "skill_versions_created_at_positive" CHECK("skill_versions"."created_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `skill_versions_object_key` ON `skill_versions` (`object_key`);--> statement-breakpoint
CREATE TABLE `skills` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`current_version` integer NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`retired_at` integer,
	CONSTRAINT "skills_current_version_positive" CHECK("skills"."current_version" > 0),
	CONSTRAINT "skills_status" CHECK("skills"."status" IN ('active', 'retired')),
	CONSTRAINT "skills_created_at_positive" CHECK("skills"."created_at" > 0),
	CONSTRAINT "skills_updated_after_creation" CHECK("skills"."updated_at" >= "skills"."created_at"),
	CONSTRAINT "skills_state" CHECK((
        ("skills"."status" = 'active' AND "skills"."retired_at" IS NULL)
        OR ("skills"."status" = 'retired'
          AND "skills"."retired_at" IS NOT NULL
          AND "skills"."retired_at" >= "skills"."created_at")
      ))
);
--> statement-breakpoint
CREATE INDEX `skills_status_id` ON `skills` (`status`,`skill_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `skills_active_name` ON `skills` (`name`) WHERE "skills"."status" = 'active';