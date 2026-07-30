PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_revisions` (
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`model` text NOT NULL,
	`capabilities` text NOT NULL,
	`instructions` text NOT NULL,
	`execution_limits` text NOT NULL,
	`capability_grants` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `revision`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`agent_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_positive" CHECK("__new_agent_revisions"."revision" > 0),
	CONSTRAINT "agent_revisions_capabilities_json" CHECK(json_valid("__new_agent_revisions"."capabilities")),
	CONSTRAINT "agent_revisions_capability_grants_json" CHECK(json_valid("__new_agent_revisions"."capability_grants")),
	CONSTRAINT "agent_revisions_created_at_positive" CHECK("__new_agent_revisions"."created_at" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_agent_revisions`("agent_id", "revision", "name", "model", "capabilities", "instructions", "execution_limits", "capability_grants", "created_at")
SELECT
	"agent_id",
	"revision",
	"name",
	"model",
	json_array(json_object(
		'configuration',
		json_object('model', "model"),
		'id',
		'inference.workers-ai',
		'schemaVersion',
		1
	)),
	"instructions",
	"execution_limits",
	"capability_grants",
	"created_at"
FROM `agent_revisions`;--> statement-breakpoint
DROP TABLE `agent_revisions`;--> statement-breakpoint
ALTER TABLE `__new_agent_revisions` RENAME TO `agent_revisions`;--> statement-breakpoint
UPDATE `run_admissions`
SET `budget_reservation` = json_set(
	json_remove(`budget_reservation`, '$.model'),
	'$.runtimePlan',
	json_object(
		'inference',
		json_object(
			'model',
			json_extract(`budget_reservation`, '$.model'),
			'moduleId',
			'inference.workers-ai',
			'schemaVersion',
			1
		),
		'modules',
		json_array(json_object('id', 'inference.workers-ai', 'schemaVersion', 1)),
		'systemContext',
		json_array()
	)
)
WHERE json_type(`budget_reservation`, '$.runtimePlan') IS NULL
	AND json_type(`budget_reservation`, '$.model') = 'text';--> statement-breakpoint
PRAGMA foreign_keys=ON;
