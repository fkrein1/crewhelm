PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ai_gateway_calls` (
	`gateway_log_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`reservation_microusd` integer NOT NULL,
	`cost_microusd` integer,
	`input_tokens` integer,
	`output_tokens` integer,
	`recorded_at` integer NOT NULL,
	`settled_at` integer,
	`next_reconciliation_at` integer NOT NULL,
	`reconciliation_attempts` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_gateway_calls_status" CHECK("__new_ai_gateway_calls"."status" IN ('pending', 'settled')),
	CONSTRAINT "ai_gateway_calls_cost_nonnegative" CHECK("__new_ai_gateway_calls"."cost_microusd" IS NULL OR "__new_ai_gateway_calls"."cost_microusd" >= 0),
	CONSTRAINT "ai_gateway_calls_reservation_positive" CHECK("__new_ai_gateway_calls"."reservation_microusd" > 0),
	CONSTRAINT "ai_gateway_calls_tokens_nonnegative" CHECK(("__new_ai_gateway_calls"."input_tokens" IS NULL OR "__new_ai_gateway_calls"."input_tokens" >= 0)
        AND ("__new_ai_gateway_calls"."output_tokens" IS NULL OR "__new_ai_gateway_calls"."output_tokens" >= 0)),
	CONSTRAINT "ai_gateway_calls_recorded_at_positive" CHECK("__new_ai_gateway_calls"."recorded_at" > 0),
	CONSTRAINT "ai_gateway_calls_settlement_state" CHECK((("__new_ai_gateway_calls"."status" = 'pending'
          AND "__new_ai_gateway_calls"."cost_microusd" IS NULL
          AND "__new_ai_gateway_calls"."settled_at" IS NULL)
        OR ("__new_ai_gateway_calls"."status" = 'settled'
          AND "__new_ai_gateway_calls"."cost_microusd" IS NOT NULL
          AND "__new_ai_gateway_calls"."settled_at" IS NOT NULL
          AND "__new_ai_gateway_calls"."settled_at" >= "__new_ai_gateway_calls"."recorded_at"))),
	CONSTRAINT "ai_gateway_calls_reconciliation_positive" CHECK("__new_ai_gateway_calls"."next_reconciliation_at" > 0 AND "__new_ai_gateway_calls"."reconciliation_attempts" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_ai_gateway_calls`("gateway_log_id", "run_id", "agent_id", "status", "reservation_microusd", "cost_microusd", "input_tokens", "output_tokens", "recorded_at", "settled_at", "next_reconciliation_at", "reconciliation_attempts") SELECT "gateway_log_id", "run_id", "agent_id", "status", CAST(json_extract((SELECT "budget_reservation" FROM "run_admissions" WHERE "run_admissions"."run_id" = "ai_gateway_calls"."run_id"), '$.aiSpendReservationMicrousd') AS INTEGER), "cost_microusd", "input_tokens", "output_tokens", "recorded_at", "settled_at", "next_reconciliation_at", "reconciliation_attempts" FROM `ai_gateway_calls`;--> statement-breakpoint
DROP TABLE `ai_gateway_calls`;--> statement-breakpoint
ALTER TABLE `__new_ai_gateway_calls` RENAME TO `ai_gateway_calls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ai_gateway_calls_run` ON `ai_gateway_calls` (`run_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `ai_gateway_calls_reconciliation` ON `ai_gateway_calls` (`next_reconciliation_at`) WHERE "ai_gateway_calls"."status" = 'pending';
