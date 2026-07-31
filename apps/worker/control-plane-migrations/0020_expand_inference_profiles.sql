UPDATE `agent_revisions` AS `revision`
SET `capabilities` = (
	SELECT json_set(
		`revision`.`capabilities`,
		'$[' || `capability`.`key` || '].configuration',
		json_object(
			'fallbackModels',
			json_array(),
			'primaryModel',
			json_extract(`capability`.`value`, '$.configuration.model')
		),
		'$[' || `capability`.`key` || '].schemaVersion',
		2
	)
	FROM json_each(`revision`.`capabilities`) AS `capability`
	WHERE json_extract(`capability`.`value`, '$.id') = 'inference.workers-ai'
		AND json_extract(`capability`.`value`, '$.schemaVersion') = 1
	LIMIT 1
)
WHERE EXISTS (
	SELECT 1
	FROM json_each(`revision`.`capabilities`) AS `capability`
	WHERE json_extract(`capability`.`value`, '$.id') = 'inference.workers-ai'
		AND json_extract(`capability`.`value`, '$.schemaVersion') = 1
);
--> statement-breakpoint
UPDATE `run_admissions` AS `admission`
SET `budget_reservation` = (
	SELECT json_set(
		`admission`.`budget_reservation`,
		'$.runtimePlan.inference.fallbackModels',
		json_array(),
		'$.runtimePlan.inference.schemaVersion',
		2,
		'$.runtimePlan.modules[' || `module`.`key` || '].schemaVersion',
		2
	)
	FROM json_each(
		json_extract(`admission`.`budget_reservation`, '$.runtimePlan.modules')
	) AS `module`
	WHERE json_extract(`module`.`value`, '$.id') = 'inference.workers-ai'
		AND json_extract(`module`.`value`, '$.schemaVersion') = 1
	LIMIT 1
)
WHERE json_extract(`admission`.`budget_reservation`, '$.runtimePlan.inference.moduleId')
	= 'inference.workers-ai'
	AND json_extract(`admission`.`budget_reservation`, '$.runtimePlan.inference.schemaVersion') = 1;
