UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN ('"[\"control:read\"]"', '["control:read"]');
