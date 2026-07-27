UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"integrations:read\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\",\"agents:read\",\"integrations:read\"]"',
    '["control:read","control:write","agents:read","integrations:read"]'
  );
