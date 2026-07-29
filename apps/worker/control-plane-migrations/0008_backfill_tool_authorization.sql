UPDATE `capability_grants`
SET `grant` = json_set(`grant`, '$.authorization', 'approval_required')
WHERE json_type(`grant`, '$.authorization') IS NULL;
