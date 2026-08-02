CREATE TABLE `remote_mcp_oauth_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_digest` text NOT NULL,
	`operation` text NOT NULL,
	`connection_id` text,
	`endpoint` text NOT NULL,
	`account_label` text NOT NULL,
	`oauth_scopes` text NOT NULL,
	`snapshot_digest` text,
	`state_digest` text NOT NULL,
	`authorization_url` text,
	`credential_ciphertext` text,
	`credential_nonce` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_oauth_requests_operation" CHECK("remote_mcp_oauth_requests"."operation" IN ('create', 'reauthenticate')),
	CONSTRAINT "remote_mcp_oauth_requests_digest" CHECK(length("remote_mcp_oauth_requests"."request_digest") = 64
        AND "remote_mcp_oauth_requests"."request_digest" NOT GLOB '*[^0-9a-f]*'
        AND length("remote_mcp_oauth_requests"."state_digest") = 64
        AND "remote_mcp_oauth_requests"."state_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_oauth_requests_status" CHECK("remote_mcp_oauth_requests"."status" IN ('reserved', 'starting', 'pending', 'exchanging', 'completed', 'failed')),
	CONSTRAINT "remote_mcp_oauth_requests_credential_pair" CHECK(("remote_mcp_oauth_requests"."credential_ciphertext" IS NULL) = ("remote_mcp_oauth_requests"."credential_nonce" IS NULL)),
	CONSTRAINT "remote_mcp_oauth_requests_scopes_json" CHECK(json_valid("remote_mcp_oauth_requests"."oauth_scopes") AND json_type("remote_mcp_oauth_requests"."oauth_scopes") = 'array'),
	CONSTRAINT "remote_mcp_oauth_requests_target" CHECK(("remote_mcp_oauth_requests"."operation" = 'create'
          AND "remote_mcp_oauth_requests"."snapshot_digest" IS NULL
          AND (("remote_mcp_oauth_requests"."status" = 'completed' AND "remote_mcp_oauth_requests"."connection_id" IS NOT NULL)
            OR ("remote_mcp_oauth_requests"."status" != 'completed' AND "remote_mcp_oauth_requests"."connection_id" IS NULL)))
        OR ("remote_mcp_oauth_requests"."operation" = 'reauthenticate'
          AND "remote_mcp_oauth_requests"."connection_id" IS NOT NULL
          AND "remote_mcp_oauth_requests"."snapshot_digest" IS NOT NULL)),
	CONSTRAINT "remote_mcp_oauth_requests_times" CHECK("remote_mcp_oauth_requests"."created_at" > 0
        AND "remote_mcp_oauth_requests"."expires_at" > "remote_mcp_oauth_requests"."created_at"
        AND ("remote_mcp_oauth_requests"."completed_at" IS NULL OR "remote_mcp_oauth_requests"."completed_at" >= "remote_mcp_oauth_requests"."created_at")),
	CONSTRAINT "remote_mcp_oauth_requests_completion" CHECK((
        ("remote_mcp_oauth_requests"."status" IN ('completed', 'failed')
          AND "remote_mcp_oauth_requests"."completed_at" IS NOT NULL
          AND "remote_mcp_oauth_requests"."authorization_url" IS NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NULL)
        OR ("remote_mcp_oauth_requests"."status" NOT IN ('completed', 'failed') AND "remote_mcp_oauth_requests"."completed_at" IS NULL)
      )),
	CONSTRAINT "remote_mcp_oauth_requests_pending_material" CHECK((
        ("remote_mcp_oauth_requests"."status" IN ('pending', 'exchanging')
          AND "remote_mcp_oauth_requests"."authorization_url" IS NOT NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NOT NULL)
        OR ("remote_mcp_oauth_requests"."status" NOT IN ('pending', 'exchanging')
          AND "remote_mcp_oauth_requests"."authorization_url" IS NULL
          AND "remote_mcp_oauth_requests"."credential_ciphertext" IS NULL)
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `remote_mcp_oauth_requests_client_idempotency` ON `remote_mcp_oauth_requests` (`client_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `remote_mcp_oauth_requests_expiry` ON `remote_mcp_oauth_requests` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remote_mcp_connections` (
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
	`oauth_scopes` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connections_endpoint" CHECK(length("__new_remote_mcp_connections"."endpoint") BETWEEN 1 AND 2048),
	CONSTRAINT "remote_mcp_connections_auth" CHECK((
        ("__new_remote_mcp_connections"."auth_kind" = 'public'
          AND "__new_remote_mcp_connections"."credential_ciphertext" IS NULL
          AND "__new_remote_mcp_connections"."credential_nonce" IS NULL)
        OR ("__new_remote_mcp_connections"."auth_kind" IN ('bearer', 'oauth')
          AND (("__new_remote_mcp_connections"."credential_ciphertext" IS NOT NULL
              AND "__new_remote_mcp_connections"."credential_nonce" IS NOT NULL)
            OR ("__new_remote_mcp_connections"."credential_ciphertext" IS NULL
              AND "__new_remote_mcp_connections"."credential_nonce" IS NULL)))
      )),
	CONSTRAINT "remote_mcp_connections_catalog_json" CHECK(json_valid("__new_remote_mcp_connections"."catalog")),
	CONSTRAINT "remote_mcp_connections_oauth_scopes_json" CHECK(json_valid("__new_remote_mcp_connections"."oauth_scopes") AND json_type("__new_remote_mcp_connections"."oauth_scopes") = 'array'),
	CONSTRAINT "remote_mcp_connections_oauth_scopes_auth_kind" CHECK("__new_remote_mcp_connections"."auth_kind" = 'oauth' OR json_array_length("__new_remote_mcp_connections"."oauth_scopes") = 0),
	CONSTRAINT "remote_mcp_connections_catalog_bytes" CHECK("__new_remote_mcp_connections"."catalog_bytes" BETWEEN 2 AND 524288),
	CONSTRAINT "remote_mcp_connections_snapshot_digest" CHECK(length("__new_remote_mcp_connections"."snapshot_digest") = 64
        AND "__new_remote_mcp_connections"."snapshot_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connections_server_name" CHECK(length("__new_remote_mcp_connections"."server_name") BETWEEN 1 AND 160),
	CONSTRAINT "remote_mcp_connections_server_version" CHECK(length("__new_remote_mcp_connections"."server_version") BETWEEN 1 AND 160)
);
--> statement-breakpoint
INSERT INTO `__new_remote_mcp_connections`("connection_id", "endpoint", "auth_kind", "catalog", "catalog_bytes", "snapshot_digest", "server_name", "server_version", "credential_ciphertext", "credential_nonce", "oauth_scopes") SELECT "connection_id", "endpoint", "auth_kind", "catalog", "catalog_bytes", "snapshot_digest", "server_name", "server_version", "credential_ciphertext", "credential_nonce", '[]' FROM `remote_mcp_connections`;--> statement-breakpoint
DROP TABLE `remote_mcp_connections`;--> statement-breakpoint
ALTER TABLE `__new_remote_mcp_connections` RENAME TO `remote_mcp_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
