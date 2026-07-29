UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"autonomy:write\",\"connections:read\",\"connections:write\",\"connection-configs:read\",\"connection-configs:write\",\"integrations:read\",\"offline_access\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"connections:read\",\"connections:write\",\"connection-configs:read\",\"connection-configs:write\",\"integrations:read\",\"offline_access\"]"',
    '["control:read","control:write","agents:read","agents:write","connections:read","connections:write","connection-configs:read","connection-configs:write","integrations:read","offline_access"]'
  );
