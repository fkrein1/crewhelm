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
- Treat errors as first-class results: stable codes; bounded diagnosis and recovery fields; opaque
  log-correlation IDs for dependency failures.
- Keep defaults compact. Put bounded recovery detail behind optional fields and exact reads.

Growing fleet lists return at most 25 compact summaries and stay within a 16 KiB serialized
response budget. Exact get and inspect tools retain detailed configuration, grants, prompts,
outputs, and timelines. The authenticated MCP catalog is also held to explicit CI budgets for tool
count and serialized input-schema size.

Recovery detail is opt-in and bounded: run inspection pages its timeline and can include usage;
exact connection reads include lifecycle events; status can include recent audit events. Ambiguous
writes return `recoverAfter` and pin the idempotency key until the same request can safely renew
the reservation. Existing tools carry this detail, preserving the explicit catalog limit.

The MCP initialization response provides a compact operating model and identifies fleet status as
the first read. Status derives at most three advisory next steps from counts already in its bounded
projection. Guidance never grants authority or replaces validation, and clients may call exact
tools directly. Primary workflow results return input-shaped handoffs, including a continuation
object that can be passed unchanged into the next run.

The owner inbox is the polling surface for operational attention; Crewhelm neither broadcasts nor
model-classifies its events. Fleet status exposes attention counts and age so clients can avoid
unnecessary inbox reads. Inbox severity and actionability derive from persisted state, and responses
include a polling interval hint.

Fleet mutations remain explicit rather than selector-driven. Bounded Agent shutdown accepts at
most 25 unique Agent IDs with exact expected revisions, applies owner-local changes in one durable
transaction, and returns one compact ordered receipt per input. Revision conflicts and missing
Agents do not prevent safe targets in the same request from being disabled.

Fleet capacity is revisioned owner configuration. Defaults are 100 Agents, 100 connections, and 25
concurrent runs.
