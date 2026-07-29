UPDATE `fleet_configuration_revisions`
SET `configuration` = json_remove(`configuration`, '$.ai')
WHERE json_type(`configuration`, '$.ai') IS NOT NULL;
--> statement-breakpoint
UPDATE `run_admissions`
SET `budget_reservation` = json_remove(
  `budget_reservation`,
  '$.aiSpendReservationMicrousd'
)
WHERE json_type(`budget_reservation`, '$.aiSpendReservationMicrousd') IS NOT NULL;
