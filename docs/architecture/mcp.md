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
- Report unavailable optional capabilities with their missing prerequisites and concise setup or
  plan requirements. One unavailable capability never blocks discovery or use of unrelated core
  operations.

Growing fleet lists return at most 25 compact summaries and stay within a 16 KiB serialized
response budget. Exact get and inspect tools retain detailed configuration, grants, prompts,
outputs, and timelines. The authenticated MCP catalog is also held to explicit CI budgets for tool
count, serialized input-schema size, and the complete model-visible catalog including server
instructions and tool descriptions. These are review ceilings rather than protocol limits.

Crewhelm keeps its bounded, security-sensitive product operations as directly callable tools.
Names and descriptions carry task vocabulary for host-side progressive discovery, while compact
server instructions explain when to search for the surface. Compound lifecycle tools advertise a
plain object with an `action` field whose description gives the exact per-action field signatures;
runtime validation rejects fields from the wrong action. This deliberately avoids requiring JSON
Schema composition support from every MCP-to-model adapter.

Progressive discovery is primarily a host concern: an MCP host can fetch `tools/list`, retain the
catalog outside model context, and inject only relevant definitions. Crewhelm therefore optimizes
for this path without making it mandatory. The 36-tool, 64 KiB input-schema, and 76 KiB complete
catalog ceilings remain explicit, and increases require evidence that the extra surface improves
selection or execution accuracy. One consolidated Watch lifecycle lets owners describe scheduled
checks or connected-app events without programming scheduler, webhook, or bearer-token plumbing;
later resource sources extend the same tool rather than adding provider-specific surfaces. See the
MCP guidance on
[progressive discovery](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices).

Server-side search and code execution are reserved for mechanically large API surfaces where a
fixed catalog cannot fit in context and a sandbox can enforce network and authorization boundaries.
They do not replace deterministic Crewhelm handlers for durable or authority-changing operations.
The external integration journey already applies progressive disclosure: search providers, search
their actions, attach exact versions to one Agent revision, then execute through the admitted Agent
runtime. This follows the useful part of Cloudflare's
[search-and-execute pattern](https://developers.cloudflare.com/agents/model-context-protocol/codemode/)
without exposing arbitrary code execution for the Crewhelm control plane.
Native web search and fetch follow the same catalog discipline: MCP discovers them as bounded Agent
capability modules, and only an admitted Run receives their exact runtime tools.

Recovery detail is opt-in and bounded: run inspection pages its timeline and can include usage;
exact connection reads include lifecycle events; status can include recent audit events. Ambiguous
writes return `recoverAfter` and pin the idempotency key until the same request can safely renew
the reservation. Existing tools carry this detail, preserving the explicit catalog limit.

The MCP initialization response provides a compact operating model and identifies fleet status as
the first read. Status derives at most three advisory next steps from counts already in its bounded
projection, including active durable Workflows. Guidance never grants authority or replaces
validation, and clients may call exact tools directly. Primary operation results return
input-shaped handoffs: `crewhelm_start_run` returns a small owner-private conversation handle that
can be passed unchanged with the next message, while a Workflow returns its stable ID and revision
for compact list, exact inspection, cancellation, or terminal deletion. Each conversation message
is still one bounded Run; the handle resolves server-side to the exact Session branch coordinates,
so the simpler MCP journey does not weaken replay safety or concurrent-write detection. Exact
conversation inspection recovers a lost handle. The lower-level continuation remains in results
and inputs for compatibility with existing clients.

Agent revisions answer how work is performed: Skills and integration grants are configured there.
Brief revisions answer which owner-provided context is admitted to one Run or Workflow. The single
`crewhelm_briefs` lifecycle tool returns compact metadata for discovery and requires an exact ID and
revision to read content. Attaching a Brief never requires the MCP client to fetch and resend it.

One `crewhelm_agent_workflows` tool groups the small Workflow lifecycle instead of exposing
coordinator internals. Its start action accepts one objective and two to eight ordered bounded
stages. List and default inspection omit frozen prompts; exact inspection includes them only when
explicitly requested. This makes durable multi-step work discoverable without turning the MCP
catalog into a graph-building API or forcing clients to fetch every Run transcript.
Completed Workflow inspection similarly returns compact final-deliverable metadata by default and
includes content only when `includeDeliverable` is explicitly requested.

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
