CREATE TABLE `remote_mcp_connection_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`connection_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_digest` text NOT NULL,
	`occurred_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connection_mutations_operation" CHECK("remote_mcp_connection_mutations"."operation" IN ('create', 'delete')),
	CONSTRAINT "remote_mcp_connection_mutations_request_digest" CHECK(length("remote_mcp_connection_mutations"."request_digest") = 64
        AND "remote_mcp_connection_mutations"."request_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connection_mutations_occurred_at" CHECK("remote_mcp_connection_mutations"."occurred_at" > 0)
);
--> statement-breakpoint
CREATE INDEX `remote_mcp_connection_mutations_connection` ON `remote_mcp_connection_mutations` (`connection_id`);--> statement-breakpoint
CREATE TABLE `remote_mcp_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`auth_kind` text NOT NULL,
	`catalog` text NOT NULL,
	`catalog_bytes` integer NOT NULL,
	`snapshot_digest` text NOT NULL,
	`server_name` text NOT NULL,
	`server_version` text NOT NULL,
	`credential_ciphertext` text,
	`credential_nonce` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connections_endpoint" CHECK(length("remote_mcp_connections"."endpoint") BETWEEN 1 AND 2048),
	CONSTRAINT "remote_mcp_connections_auth" CHECK((
        ("remote_mcp_connections"."auth_kind" = 'public'
          AND "remote_mcp_connections"."credential_ciphertext" IS NULL
          AND "remote_mcp_connections"."credential_nonce" IS NULL)
        OR ("remote_mcp_connections"."auth_kind" = 'bearer'
          AND (("remote_mcp_connections"."credential_ciphertext" IS NOT NULL
              AND "remote_mcp_connections"."credential_nonce" IS NOT NULL)
            OR ("remote_mcp_connections"."credential_ciphertext" IS NULL
              AND "remote_mcp_connections"."credential_nonce" IS NULL)))
      )),
	CONSTRAINT "remote_mcp_connections_catalog_json" CHECK(json_valid("remote_mcp_connections"."catalog")),
	CONSTRAINT "remote_mcp_connections_catalog_bytes" CHECK("remote_mcp_connections"."catalog_bytes" BETWEEN 2 AND 524288),
	CONSTRAINT "remote_mcp_connections_snapshot_digest" CHECK(length("remote_mcp_connections"."snapshot_digest") = 64
        AND "remote_mcp_connections"."snapshot_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connections_server_name" CHECK(length("remote_mcp_connections"."server_name") BETWEEN 1 AND 160),
	CONSTRAINT "remote_mcp_connections_server_version" CHECK(length("remote_mcp_connections"."server_version") BETWEEN 1 AND 160)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_connection_id` text,
	`auth_config_id` text,
	`account_label` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "connections_provider_details" CHECK((
        ("__new_connections"."provider" = 'composio'
          AND "__new_connections"."provider_connection_id" IS NOT NULL
          AND "__new_connections"."auth_config_id" IS NOT NULL)
        OR ("__new_connections"."provider" = 'remote_mcp'
          AND "__new_connections"."provider_connection_id" IS NULL
          AND "__new_connections"."auth_config_id" IS NULL)
      )),
	CONSTRAINT "connections_status" CHECK("__new_connections"."status" IN ('initiated', 'active', 'revoked', 'unavailable')),
	CONSTRAINT "connections_created_at_positive" CHECK("__new_connections"."created_at" > 0),
	CONSTRAINT "connections_account_label" CHECK("__new_connections"."account_label" IS NULL
        OR (length("__new_connections"."account_label") BETWEEN 1 AND 160
          AND "__new_connections"."account_label" NOT GLOB '*[^ -~]*')),
	CONSTRAINT "connections_revocation_state" CHECK((
        ("__new_connections"."status" = 'revoked'
          AND "__new_connections"."revoked_at" IS NOT NULL
          AND "__new_connections"."revoked_at" >= "__new_connections"."created_at")
        OR ("__new_connections"."status" != 'revoked' AND "__new_connections"."revoked_at" IS NULL)
      ))
);
--> statement-breakpoint
INSERT INTO `__new_connections`("connection_id", "provider", "provider_connection_id", "auth_config_id", "account_label", "status", "created_at", "revoked_at") SELECT "connection_id", "provider", "provider_connection_id", "auth_config_id", "account_label", "status", "created_at", "revoked_at" FROM `connections`;--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_connection_id_unique` ON `connections` (`provider_connection_id`);