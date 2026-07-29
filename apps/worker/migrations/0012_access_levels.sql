UPDATE "oauthResource"
SET "allowedScopes" = '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"autonomy:write\",\"connections:read\",\"connections:write\",\"connection-configs:read\",\"connection-configs:write\",\"integrations:read\",\"crewhelm:view\",\"crewhelm:use\",\"crewhelm:full\",\"offline_access\"]"'
WHERE "name" = 'Crewhelm MCP'
  AND substr("identifier", -4) = '/mcp'
  AND "allowedScopes" IN (
    '"[\"control:read\",\"control:write\",\"agents:read\",\"agents:write\",\"autonomy:write\",\"connections:read\",\"connections:write\",\"connection-configs:read\",\"connection-configs:write\",\"integrations:read\",\"offline_access\"]"',
    '["control:read","control:write","agents:read","agents:write","autonomy:write","connections:read","connections:write","connection-configs:read","connection-configs:write","integrations:read","offline_access"]'
  );
