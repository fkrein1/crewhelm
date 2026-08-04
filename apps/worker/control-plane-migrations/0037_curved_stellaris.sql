CREATE TABLE `model_catalog_revisions` (
	`revision` integer PRIMARY KEY NOT NULL,
	`catalog` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "model_catalog_revisions_revision_positive" CHECK("model_catalog_revisions"."revision" > 0),
	CONSTRAINT "model_catalog_revisions_catalog_json" CHECK(json_valid("model_catalog_revisions"."catalog")),
	CONSTRAINT "model_catalog_revisions_created_at_positive" CHECK("model_catalog_revisions"."created_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `model_catalog_updates` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`revision` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`revision`) REFERENCES `model_catalog_revisions`(`revision`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "model_catalog_updates_request_digest_length" CHECK(length("model_catalog_updates"."request_digest") = 43),
	CONSTRAINT "model_catalog_updates_revision_positive" CHECK("model_catalog_updates"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_catalog_updates_revision` ON `model_catalog_updates` (`revision`);--> statement-breakpoint
CREATE TABLE `model_catalogs` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`current_revision` integer NOT NULL,
	CONSTRAINT "model_catalogs_singleton" CHECK("model_catalogs"."singleton" = 1),
	CONSTRAINT "model_catalogs_current_revision_positive" CHECK("model_catalogs"."current_revision" > 0)
);
--> statement-breakpoint
UPDATE `fleet_configuration_revisions`
SET `configuration` = json_remove(`configuration`, '$.models')
WHERE json_type(`configuration`, '$.models') IS NOT NULL;
