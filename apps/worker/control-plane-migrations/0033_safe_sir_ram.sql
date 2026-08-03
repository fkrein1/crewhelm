CREATE TABLE `recipe_installations` (
	`installation_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`plan_digest` text NOT NULL,
	`plan` text NOT NULL,
	`skill_packages` text NOT NULL,
	`receipt` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "recipe_installations_request_digest_length" CHECK(length("recipe_installations"."request_digest") = 64),
	CONSTRAINT "recipe_installations_plan_digest_length" CHECK(length("recipe_installations"."plan_digest") = 64),
	CONSTRAINT "recipe_installations_plan_json" CHECK(json_valid("recipe_installations"."plan")),
	CONSTRAINT "recipe_installations_skill_packages_json" CHECK(json_valid("recipe_installations"."skill_packages")),
	CONSTRAINT "recipe_installations_receipt_json" CHECK(json_valid("recipe_installations"."receipt")),
	CONSTRAINT "recipe_installations_status" CHECK("recipe_installations"."status" IN ('installing', 'installed')),
	CONSTRAINT "recipe_installations_created_at_positive" CHECK("recipe_installations"."created_at" > 0),
	CONSTRAINT "recipe_installations_updated_after_creation" CHECK("recipe_installations"."updated_at" >= "recipe_installations"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_installations_client_idempotency` ON `recipe_installations` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `recipe_installations_status_updated` ON `recipe_installations` (`status`,`updated_at`);
