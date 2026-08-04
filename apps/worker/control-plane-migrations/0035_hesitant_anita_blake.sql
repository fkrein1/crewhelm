CREATE TABLE `provider_auth_configs` (
	`auth_config_id` text PRIMARY KEY NOT NULL,
	`integration_slug` text NOT NULL,
	`auth_scheme` text NOT NULL,
	`source` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "provider_auth_configs_integration_slug" CHECK(length("provider_auth_configs"."integration_slug") BETWEEN 1 AND 128),
	CONSTRAINT "provider_auth_configs_auth_scheme" CHECK("provider_auth_configs"."auth_scheme" IN ('OAUTH2', 'API_KEY', 'BEARER_TOKEN', 'BASIC')),
	CONSTRAINT "provider_auth_configs_source" CHECK("provider_auth_configs"."source" IN ('composio_managed', 'crewhelm_custom')),
	CONSTRAINT "provider_auth_configs_display_name" CHECK(length("provider_auth_configs"."display_name") BETWEEN 1 AND 160),
	CONSTRAINT "provider_auth_configs_created_at_positive" CHECK("provider_auth_configs"."created_at" > 0),
	CONSTRAINT "provider_auth_configs_updated_after_creation" CHECK("provider_auth_configs"."updated_at" >= "provider_auth_configs"."created_at")
);
--> statement-breakpoint
CREATE INDEX `provider_auth_configs_integration` ON `provider_auth_configs` (`integration_slug`,`auth_config_id`);
