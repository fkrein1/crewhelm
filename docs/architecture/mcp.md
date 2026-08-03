# MCP architecture

Crewhelm's MCP surface presents owner intent, not control-plane command plumbing. Deterministic
modules retain authority, validation, state transitions, and recovery.

## Public facade and private commands

The worker builds two catalogs:

1. A private command catalog contains the exact handlers used by the control plane. These schemas
   retain revision checks, replay identities, provider snapshots, lifecycle actions, and other
   coordination fields.
2. A public facade groups those commands into a small set of read and change surfaces for Agents,
   Work, Automations, Connections, Context, Recipes, and Recovery.

The private catalog is not returned by `tools/list`. A facade operation validates its public typed
input, reconstructs the exact private request, and dispatches through the existing handler. The
control plane therefore receives the same bounded request and enforces the same authority as it
would for a direct command.

## Selection model

Every public domain uses the same sequence:

1. Start with `crewhelm_status` when the next task is unknown.
2. Choose a read or change tool from the domain name and annotations.
3. Choose one operation by its `kind`.
4. Pass only that operation's typed fields.
5. Retain returned resource objects and pass them unchanged to later operations.

Read and change tools remain separate even when they use the same private lifecycle handler. This
keeps `readOnlyHint`, `destructiveHint`, and `openWorldHint` truthful before a client inspects the
operation schema. Recipes follow the same boundary: discovery is read-only; preview, installation,
and recovery use the change surface; publication remains an explicit destructive open-world tool.

Common operations are named by outcome: `run`, `start_workflow`, `create_schedule`,
`create_event_trigger`, `connect_provider`, `create_brief`, and `prepare`. Compound private action
enums do not cross the facade.

## Copy-ready handoffs

Resource identity includes whatever the control plane needs to reject stale or mismatched work.
The public surface represents that identity as one copy-ready object instead of unrelated fields.
Examples include an Agent, Workflow, conversation, Schedule, Event Trigger, Brief, Connection,
unresolved effect, or capability grant.

Reference schemas accept the full bounded object returned by Crewhelm and read only the required
coordinates. A Schedule or Event Trigger already identifies its Agent revision, so update, pause,
resume, and delete operations do not also ask for a separate Agent reference. A Workflow exposes
`workflowId` and `revision`; a conversation carries its branch revision; a remote MCP Connection
carries its frozen snapshot digest.

This is presentation simplification, not weaker concurrency control. The facade reconstructs the
same expected revisions and snapshot digests before private validation and dispatch.

## Replay and confirmation

Ordinary callers do not manufacture idempotency keys. The facade derives a bounded replay identity
from the MCP request ID. Callers may provide `requestKey` only when they need a stable identity
across distinct MCP requests. Multi-command happy paths derive a separate child identity for each
private effect.

Configuration packages preview by default. Repeating the unchanged operation with `confirm: true`
applies it. Recipe installation and publication retain their confirmation digests because those
digests prove the reviewed plan is unchanged; the facade does not replace meaningful owner
confirmation with a boolean.

## Server-owned orchestration

The facade may compose private commands when the intermediate value has no owner decision:

- `connect_provider` enables managed provider authentication, retains the returned auth
  configuration internally, and creates the owner authorization link.
- Recipe `prepare` ports an exact live Agent revision plus selected returned Schedules and Event
  Triggers into a reviewable public candidate.

Each private step still validates scopes and persists replay state independently. Provider
credentials remain in provider or Crewhelm custody and never enter MCP arguments, results, logs, or
Agent context.

Complex authoring uses owner-scoped durable drafts instead of carrying complete candidates through
every model turn. `prepare_*` operations store one validated Recipe installation, Recipe
publication, Skill, or Agent-blueprint package in `OwnerControlPlane` SQLite and return a compact
reference containing its kind, revision, digest, and expiry. Small operations replace one setup
value, binding, optional Skill choice, recurring-operation selection, publication section, or Skill
decision at a time. Preview and apply or publish resolve the exact current draft; confirmation
digests still bind the reviewed plan.

Publication sections are inspected on demand, so the model need not ingest or resend the whole
candidate merely to review one decision. Drafts are bound to the authenticated owner and OAuth
client, expire after 24 hours, and are limited to eight drafts of 160 KiB each. Every edit uses an
exact revision and digest plus replay identity. Draft references are coordination coordinates, not
authority, and cannot bypass the private handler's validation or scope checks. Each authoring
surface exposes an explicit discard operation so completed or abandoned drafts need not consume
the bounded quota until expiry.

## Catalog and collection bounds

Growing collections use bounded list operations followed by exact inspection. Fleet lists return
at most 25 compact summaries and stay within their response budgets. Exact reads retain detailed
configuration, grants, prompts, outputs, and timelines only when requested.

The authenticated catalog has explicit CI ceilings of 16 tools, 74 KiB of serialized input
schemas, 80 KiB for the complete model-visible payload including server instructions, and 10 KiB
for any one complete tool definition. These are review ceilings, not MCP protocol limits. Shared local JSON Schema
definitions use `$ref` rather than repeating common references and contracts. Schema growth must
represent a typed owner decision or domain object; internal coordination fields do not justify
public catalog growth.

Large provider action catalogs remain progressively discoverable: search a provider only when it
is unknown, search its actions only when needed, then grant exact versions to one Agent revision.
Crewhelm never exposes one control-plane tool per provider action or arbitrary code execution for
administration.

## Authority, external effects, and recovery

The facade changes no trust boundary. Tool and transcript text remains untrusted. Every private
handler rechecks owner, scope, resource identity, revision, bounds, and policy. Tool visibility is
not authority, and Recipe or Brief content grants none.

Ambiguous provider writes remain pinned to their replay identity. Recovery accepts the unresolved
effect returned by Crewhelm, but reconciliation is allowed only after independent verification in
the provider's authoritative UI or API. Only a proven `not_applied` result permits an equivalent
mutation to be retried. Connections and capability grants remain explicitly revocable.

Remote MCP keeps discovery, credential setup, frozen catalog validation, Agent attachment, and
execution-time authorization in their existing owners. Public, bearer, and OAuth servers use the
same owner-side adapter. Bearer material enters through a signed browser setup handoff; OAuth uses
standards discovery, authorization code with PKCE, encrypted token storage, lazy refresh, and
best-effort provider revocation. Remote content remains untrusted and bounded.
