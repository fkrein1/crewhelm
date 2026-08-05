PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_remote_mcp_connection_mutations` (
	`client_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`connection_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_digest` text NOT NULL,
	`occurred_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `idempotency_key`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`connection_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "remote_mcp_connection_mutations_operation" CHECK("__new_remote_mcp_connection_mutations"."operation" IN ('create', 'delete', 'reauthenticate')),
	CONSTRAINT "remote_mcp_connection_mutations_request_digest" CHECK(length("__new_remote_mcp_connection_mutations"."request_digest") = 64
        AND "__new_remote_mcp_connection_mutations"."request_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "remote_mcp_connection_mutations_occurred_at" CHECK("__new_remote_mcp_connection_mutations"."occurred_at" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_remote_mcp_connection_mutations`("client_id", "idempotency_key", "connection_id", "operation", "request_digest", "occurred_at") SELECT "client_id", "idempotency_key", "connection_id", "operation", "request_digest", "occurred_at" FROM `remote_mcp_connection_mutations`;--> statement-breakpoint
DROP TABLE `remote_mcp_connection_mutations`;--> statement-breakpoint
ALTER TABLE `__new_remote_mcp_connection_mutations` RENAME TO `remote_mcp_connection_mutations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `remote_mcp_connection_mutations_connection` ON `remote_mcp_connection_mutations` (`connection_id`);