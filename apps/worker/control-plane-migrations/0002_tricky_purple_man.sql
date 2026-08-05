PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remote_mcp_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`auth_kind` text NOT NULL,
	`api_key_header_name` text,
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
	CONSTRAINT "remote_mcp_connections_api_key_header" CHECK(("__new_remote_mcp_connections"."auth_kind" = 'api_key') = ("__new_remote_mcp_connections"."api_key_header_name" IS NOT NULL)),
	CONSTRAINT "remote_mcp_connections_auth" CHECK((
        ("__new_remote_mcp_connections"."auth_kind" = 'public'
          AND "__new_remote_mcp_connections"."credential_ciphertext" IS NULL
          AND "__new_remote_mcp_connections"."credential_nonce" IS NULL)
        OR ("__new_remote_mcp_connections"."auth_kind" IN ('api_key', 'bearer', 'oauth')
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
INSERT INTO `__new_remote_mcp_connections`("connection_id", "endpoint", "auth_kind", "api_key_header_name", "catalog", "catalog_bytes", "snapshot_digest", "server_name", "server_version", "credential_ciphertext", "credential_nonce", "oauth_scopes") SELECT "connection_id", "endpoint", "auth_kind", NULL, "catalog", "catalog_bytes", "snapshot_digest", "server_name", "server_version", "credential_ciphertext", "credential_nonce", "oauth_scopes" FROM `remote_mcp_connections`;--> statement-breakpoint
DROP TABLE `remote_mcp_connections`;--> statement-breakpoint
ALTER TABLE `__new_remote_mcp_connections` RENAME TO `remote_mcp_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
