UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"integrations:read\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\"]"',
    '["control:read","control:write"]'
  );
