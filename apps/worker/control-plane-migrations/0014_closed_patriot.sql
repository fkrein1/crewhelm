DELETE FROM agent_inbox_acknowledgements
WHERE item_id IN (
  SELECT inbox.item_id
  FROM agent_inbox_items AS inbox
  WHERE inbox.kind = 'outcome'
    AND inbox.run_status = 'completed'
    AND (
      EXISTS (
        SELECT 1
        FROM tool_executions AS execution
        WHERE execution.run_id = inbox.run_id
          AND execution.status = 'unknown'
          AND execution.reconciliation IS NULL
      )
      OR (
        EXISTS (
          SELECT 1
          FROM tool_executions AS execution
          WHERE execution.run_id = inbox.run_id
            AND execution.status = 'failed'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tool_executions AS execution
          WHERE execution.run_id = inbox.run_id
            AND execution.status = 'completed'
        )
      )
    )
);

UPDATE agent_inbox_items AS inbox
SET approval_count = 0,
    kind = 'exception',
    result_preview = NULL,
    run_status = 'failed'
WHERE inbox.kind = 'outcome'
  AND inbox.run_status = 'completed'
  AND (
    EXISTS (
      SELECT 1
      FROM tool_executions AS execution
      WHERE execution.run_id = inbox.run_id
        AND execution.status = 'unknown'
        AND execution.reconciliation IS NULL
    )
    OR (
      EXISTS (
        SELECT 1
        FROM tool_executions AS execution
        WHERE execution.run_id = inbox.run_id
          AND execution.status = 'failed'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM tool_executions AS execution
        WHERE execution.run_id = inbox.run_id
          AND execution.status = 'completed'
      )
    )
  );--> statement-breakpoint

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_connections` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_connection_id` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`account_label` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT "connections_provider_composio" CHECK("__new_connections"."provider" = 'composio'),
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
INSERT INTO `__new_connections`("connection_id", "provider", "provider_connection_id", "auth_config_id", "account_label", "status", "created_at", "revoked_at") SELECT "connection_id", "provider", "provider_connection_id", "auth_config_id", NULL, "status", "created_at", "revoked_at" FROM `connections`;--> statement-breakpoint
DROP TABLE `connections`;--> statement-breakpoint
ALTER TABLE `__new_connections` RENAME TO `connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_provider_connection_id_unique` ON `connections` (`provider_connection_id`);
