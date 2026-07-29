UPDATE `fleet_configuration_revisions`
SET `configuration` = json_set(
  `configuration`,
  '$.capacity',
  json_object(
    'maxAgents', 100,
    'maxConcurrentRuns', 1000,
    'maxConnections', 1000
  ),
  '$.retention',
  json_object(
    'inboxSeconds', 2592000,
    'runSeconds', 86400
  )
)
WHERE json_type(`configuration`, '$.capacity') IS NULL
   OR json_type(`configuration`, '$.retention') IS NULL;
--> statement-breakpoint
UPDATE `run_admissions`
SET `budget_reservation` = json_set(
  `budget_reservation`,
  '$.retentionSeconds',
  86400
)
WHERE json_type(`budget_reservation`, '$.retentionSeconds') IS NULL;
