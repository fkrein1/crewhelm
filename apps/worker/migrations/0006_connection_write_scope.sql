UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"connections:write\",\"integrations:read\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"integrations:read\"]"',
    '["control:read","control:write","agents:read","agents:write","integrations:read"]'
  );
