PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_auth_configs` (
	`auth_config_id` text PRIMARY KEY NOT NULL,
	`integration_slug` text NOT NULL,
	`auth_scheme` text NOT NULL,
	`source` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "provider_auth_configs_integration_slug" CHECK(length("__new_provider_auth_configs"."integration_slug") BETWEEN 1 AND 128),
	CONSTRAINT "provider_auth_configs_auth_scheme" CHECK("__new_provider_auth_configs"."auth_scheme" IN ('API_KEY', 'BASIC', 'BASIC_WITH_JWT', 'BEARER_TOKEN', 'DCR_OAUTH', 'GOOGLE_SERVICE_ACCOUNT', 'NO_AUTH', 'OAUTH1', 'OAUTH2', 'S2S_OAUTH2', 'SAML')),
	CONSTRAINT "provider_auth_configs_source" CHECK("__new_provider_auth_configs"."source" IN ('composio_managed', 'crewhelm_custom')),
	CONSTRAINT "provider_auth_configs_display_name" CHECK(length("__new_provider_auth_configs"."display_name") BETWEEN 1 AND 160),
	CONSTRAINT "provider_auth_configs_created_at_positive" CHECK("__new_provider_auth_configs"."created_at" > 0),
	CONSTRAINT "provider_auth_configs_updated_after_creation" CHECK("__new_provider_auth_configs"."updated_at" >= "__new_provider_auth_configs"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_provider_auth_configs`("auth_config_id", "integration_slug", "auth_scheme", "source", "display_name", "created_at", "updated_at") SELECT "auth_config_id", "integration_slug", "auth_scheme", "source", "display_name", "created_at", "updated_at" FROM `provider_auth_configs`;--> statement-breakpoint
DROP TABLE `provider_auth_configs`;--> statement-breakpoint
ALTER TABLE `__new_provider_auth_configs` RENAME TO `provider_auth_configs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `provider_auth_configs_integration` ON `provider_auth_configs` (`integration_slug`,`auth_config_id`);
