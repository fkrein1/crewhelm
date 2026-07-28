UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"connections:read\",\"connections:write\",\"connection-configs:read\",\"integrations:read\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"connections:read\",\"connections:write\",\"integrations:read\"]"',
    '["control:read","control:write","agents:read","agents:write","connections:read","connections:write","integrations:read"]'
  );
