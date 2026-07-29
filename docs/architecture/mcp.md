# MCP architecture

MCP exposes product operations, not internal modules or every provider action. Deterministic modules
retain authority.

## Rules

- Keep common jobs first-class; discover uncommon capabilities progressively.
- Scope Composio tools to an Agent revision. Never expose one MCP tool per provider action.
- Read growing collections through **overview**, bounded **list**, and exact **inspect** operations.
  Use opaque cursors and owner-local projections; never fan out across Agents while listing.
- Projections support discovery, not authority. Validate Agent updates against admitted runs.
- Keep writes exact and replay-safe, limits bounded, and fleet capacity configurable. Test
  pagination, payload size, filters, fleet scale, and MCP schema size.
