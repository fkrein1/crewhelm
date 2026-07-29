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

Growing fleet lists return at most 25 compact summaries and stay within a 16 KiB serialized
response budget. Exact get and inspect tools retain detailed configuration, grants, prompts,
outputs, and timelines. The authenticated MCP catalog is also held to explicit CI budgets for tool
count and serialized input-schema size.

Fleet mutations remain explicit rather than selector-driven. Bounded Agent shutdown accepts at
most 25 unique Agent IDs with exact expected revisions, applies owner-local changes in one durable
transaction, and returns one compact ordered receipt per input. Revision conflicts and missing
Agents do not prevent safe targets in the same request from being disabled.

New fleets default to 100 Agents, 100 connections, and 25 concurrent runs. The capacity migration
preserves the former 1,000-connection and 1,000-admission ceilings for existing fleets so an upgrade
does not silently tighten operating policy; owners can lower those values through a revisioned
configuration change.
