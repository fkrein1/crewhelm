# Security invariants

These constraints apply before a capability becomes reachable.

1. **Deterministic authority.** Models may propose actions but cannot grant permissions, approve
   their own actions, change policy, or bypass enforcement.
2. **Deny by default.** Every operation requires an authenticated owner, explicit capability,
   bounded target, and current policy decision.
3. **Secret isolation.** Models, recipes, runtime agents, logs, traces, errors, and audit responses
   never receive raw provider credentials.
4. **Hostile inputs.** Prompts, recipes, retrieved content, MCP metadata, and provider responses are
   validated as untrusted data.
5. **Bounded execution.** Model tokens, tool calls, loops, concurrency, schedules, network egress,
   payload sizes, and cost are limited before execution.
6. **Controlled side effects.** External writes are idempotent and auditable. Security changes,
   permission grants, budget increases, and destructive actions require step-up approval.
7. **Recoverable state.** Mutations define failure behavior. Deletion, revocation, backup, restore,
   and migration paths are tested before release.
8. **Verifiable supply chain.** Dependencies and automation are pinned, reviewed, minimally
   privileged, and released with provenance.

Connected-account credentials supported by Composio's hosted connection form travel directly from
the owner's browser to Composio and never enter Crewhelm. Crewhelm creates the reusable
credential-free auth configuration under the same bounded reservation used for managed auth, then
returns only a validated `connect.composio.dev` link. Crewhelm uses its provider-auth setup page only
when reusable app credentials must exist before Composio can authorize the connected account.

A custom provider-auth setup capability is owner-, client-, toolkit-, scheme-, and field-plan-bound,
single-use, and short-lived. It travels in the browser URL fragment, is never sent in an HTTP
request, and is cleared before capability exchange. The setup page loads only same-origin
requests. Exchange creates a bounded HttpOnly, Secure, SameSite=Strict session with an immutable
recovery deadline; reconciliation cannot extend it. All mutations require the configured same
origin. Credential values are bounded against the frozen reusable auth-config fields and flow only
browser → Worker → Composio's auth-config API. Provider sensitivity flags are hints, not authority:
Crewhelm treats every submitted value as sensitive and masks known credential, password, token,
private-key, and service-account shapes even when provider metadata does not. The owner control
plane stores capability and session digests, safe field metadata, state, and the resulting opaque
auth-config reference—never credential values.
Responses, errors, audit events, telemetry, URLs, and Agent or MCP context never contain the entered
values. A provider rejection is terminal; an unknown or interrupted submission remains sealed and
retains capacity until exact, full-setup-ID reconciliation proves either one matching config or no
effect. It is never silently retried. Managed creation and custom setup reserve the same bounded
owner auth-config capacity before provider egress. Connection reservation accepts only an
auth-config reference already held by that owner. Readiness exposes globally discoverable managed
configs, but exposes a custom config only when an owner-held Crewhelm record intersects the bounded
active custom set returned by Composio.

An unsupported provider-auth format produces only a short-lived informational browser plan. It has
no credential fields and cannot reserve, create, or connect provider state.

A successful provider authorization return may verify and activate only the exact Connection bound
to its unexpired, digest-stored callback token and reservation. The same-origin return page performs
at most six read-only provider checks spaced two seconds apart, then stops with an explicit delayed
state;
manual checks reuse that same narrow capability. Provider identity and toolkit must match before
activation, and callback verification cannot list, select, or activate another Connection.

A durable Workflow is coordination, not authority. Its owner record freezes a bounded ordered plan,
exact Agent and fleet revisions, aggregate budget, and retention before execution. The Workflow
runtime receives only opaque coordinates and cannot mint permits, add work, access provider
adapters, or bypass the normal Run and ToolGate checks.

Each stage rechecks the frozen fleet revision inside Run admission before a permit is issued. A
Workflow-owned Session is not an ordinary continuation target: direct Runs and Session deletion
cannot mutate it, and it is removed only through the Workflow deletion path.

An owner-private conversation handle is a convenience coordinate, not authority. Continuing it
requires both Run-write and Agent-read scope, resolves only inside the authenticated owner's Agent,
and retains the exact Session branch revision check. A stale handle cannot overwrite, fork, or
silently append to newer conversation state.

A Schedule is an occurrence source, not authority. Its revision freezes one exact Agent revision,
instruction, optional exact Brief revisions, time trigger, output contract, and schedule limits.
Configuring, pausing, resuming, and updating require owner autonomy authority and exact revisions.
Each occurrence has one deterministic
admission identity; delayed alarm recovery may retry that identity but cannot create a second Run,
and one alarm claims at most one occurrence per Schedule. A lifecycle mutation is rejected as busy
while an occurrence admission is pending, preventing an already-started Run from being relabeled as
skipped. Terminal occurrence history is deterministically pruned to its documented bound. A stale
Agent revision pauses or skips the Schedule rather than silently widening or retargeting it.

An Event Trigger is an occurrence source, not authority. Its revision freezes one exact Agent
revision, instruction, optional exact Brief revisions, connected-event source, output contract, and
provider limits. Pausing, resuming, updating, and deleting require owner autonomy authority and
exact revisions. Source
payloads remain untrusted context. Each occurrence has one deterministic admission identity;
delayed alarm recovery may retry that identity but cannot create a second Run, and one alarm claims
at most one occurrence per Event Trigger. A lifecycle mutation is rejected as busy while an
occurrence admission is pending, preventing an already-started Run from being relabeled as skipped.
Terminal occurrence history is deterministically pruned to its documented bound. A stale Agent
revision pauses or skips the Event Trigger rather than silently widening or retargeting it.

An Event Trigger additionally binds one exact active Connection, provider account, auth
configuration, event slug, event version, and trigger instance. Public Composio delivery is bounded
before parsing. One fixed installation ingress verifies the signature over the exact raw bytes in a
narrow timestamp window before signed owner routing; arbitrary unsigned owner keys cannot create
owner Durable Objects. Secret reconciliation is TTL- and cooldown-bounded, and installation webhook
secrets are encrypted at rest and never enter Agent prompts. Authenticated unmatched deliveries are
acknowledged without starting work. Provider trigger creation and lifecycle retries are bounded; an
unresolved operation cannot silently become active. Stable provider source identities deduplicate
repeated deliveries, and a provider-supplied source timestamp cannot replay an event from before the
Event Trigger existed. A provider payload cannot select, replace, or revise Brief context. Pending
event count and bytes are bounded per Event Trigger, and terminal
occurrence records discard the provider payload after admission or skip. Event Runs durably retain
exact Event Trigger and provider-event provenance.

Brief contents and Workflow deliverables are untrusted owner data, not authority. Owner-local
SQLite stores only compact metadata, exact references, digests, and provenance; object content is
read through a bounded Crewhelm adapter and verified before use. Run admission binds the ordered
Brief revisions, aggregate digest, and size. `CrewSession` verifies the materialized payload against
that binding, and `beforeTurn` cannot fetch or refresh Brief content. Revising a Brief never changes
an existing admission. Referenced Brief deletion fails closed, and Workflow deletion removes its
digest-bound deliverable before the Workflow projection disappears. Session turn metadata holds
the full block only while its admitted Run is retained; Run cleanup rewrites durable history to
remove the block, and the owner reference cannot expire until the Session acknowledges that
redaction.

Typed deliverable schemas and model-produced JSON are untrusted data, never authority. The owner
control plane canonicalizes and digests a bounded schema before admission; the Session must match
that exact contract, validate independently, and must not report invalid or truncated JSON as a
successful typed deliverable. A formatting repair has no tools, consumes the frozen Run budget,
and cannot rerun or erase an external effect. Exact content remains owner-scoped and follows the
Run or Workflow retention and deletion lifecycle.

Native runtime tools are opt-in Agent capabilities, not ambient framework APIs. Admission freezes
their exact implementation identity, supported inputs, effects, and limits. Each call revalidates
the active owner, Agent and fleet revisions, consumes the Run's shared tool-call budget, and
redeems a short-lived, input-bound permit. Sandbox code runs in a per-call ephemeral container with
network egress disabled and no Crewhelm credentials. Only bounded textual output crosses back into
the model context. Teardown purges the per-call Durable Object and arms alarm-based recovery before
destruction; the owner ledger also repeats exact-ID purges through the Sandbox SDK's bounded
late-open horizon before releasing Run retention. Timeout, dispatch uncertainty, and interrupted
cleanup fail closed and remain auditable.

Web search and controlled fetch do not grant ambient network authority. Search credentials remain
in the Worker and normalized results contain public HTTPS URLs only. A search-result fetch redeems
an HMAC source handle bound to the same active Run and exact normalized URL; an explicitly enabled
fetch capability may instead read one direct URL. Initial targets and every redirect reject
credentials, non-HTTPS schemes, nonstandard ports, local names, and
private, loopback, link-local, reserved, or documentation IPv4 literals; IPv6 literals are denied
conservatively while public DNS names remain supported. Media types, redirect count,
response bytes, normalized output bytes, and wall time are frozen at admission and enforced before
content enters model context. Cloudflare's `global_fetch_strictly_public` flag prevents global fetch
from bypassing mapped Workers or zone security settings through direct origin routing. Retrieved
content is evidence, never instructions or authority.

A remote MCP Connection grants access to one reviewed, digest-frozen tool catalog, not ambient
network access. Endpoints are canonical public HTTPS URLs; local and private targets, credentials in
URLs, nonstandard ports, cross-origin redirects, reconnects, subscriptions, resources, and prompts
are denied. Public, named-header API-key, bearer, and OAuth authentication share one execution
path. API-key and bearer setup use short-lived owner-bound browser capabilities. API-key header
names are bounded and cannot override reserved transport or protocol headers. OAuth requires protected-resource and
authorization-server discovery, authorization code with S256 PKCE, URL client IDs or dynamic
registration, an exact callback state, and public HTTPS credential endpoints on the discovered
authorization-server origin. Pending verifiers, client registrations, tokens, API keys, and bearer
credentials are encrypted at rest in the owner control plane; revocation always clears ciphertext
and attempts OAuth token revocation when advertised. OAuth refresh occurs before dispatch is
claimed, never widens the granted scope set, and failed refresh makes the Connection unavailable
until owner reauthentication. Raw credentials never enter MCP tool arguments, Agent state, model
context, logs, audit output, or provider results. Every remote call rechecks the active
Connection, Agent revision, frozen catalog digest, exact tool, canonical input digest, JSON Schema,
ToolGate decision, approval, duration, and output bound before a provider request. Untrusted remote
annotations cannot grant read authority: tools default to approval-gated writes, destructive tools
always require approval, and dispatch uncertainty remains an unresolved external effect.
Remote input schemas are compiled before persistence and admit only a bounded non-regex subset;
unsupported keywords, references, conditionals, and excessive composition fail closed.

An MCP authoring draft is bounded coordination state, not authority or approval. It is scoped to
one authenticated owner and OAuth client, stores only a contract-valid Recipe installation,
Recipe publication, Skill package, or Agent-blueprint package, and expires after 24 hours. Reads
and edits require the exact kind, revision, digest, and current scope; stale or cross-client
references fail closed. Preview and mutation resolve the server-held content again, and confirmed
operations remain bound to their independent confirmation digest. At most eight 160 KiB drafts
are retained per owner, with expired rows removed before new capacity is admitted.

Public Recipe and Skill packages are immutable hostile supply-chain input, never authority. A
Recipe pins exact Registry origin, publisher namespace, name, version, and digest for every Skill;
the owner instance fetches and verifies authoritative bytes from a canonical public HTTPS origin
rather than accepting model-returned content. Registry fetches reject local or private targets and
revalidate resolved addresses and redirects. Raw Skill files are exposed only through bounded exact
reads and rendered as inert source without active HTML, remote images, or automatic fetches. A Skill
may influence how an Agent uses existing grants, so local preview combines content findings with the
exact proposed authority, but neither automated review nor a model may mark it safe. Installation
imports a digest-pinned local copy, creates no authority implicitly, never starts work, and never
follows Registry updates at runtime. Registry restriction or loss cannot mutate an installed
owner-local version.

Public publishing requires both owner Full control and a short-lived Registry authorization bound
to one publication idempotency key. GitHub authentication and its session cookie remain at the
Registry. The owner instance retains only a derived verifier, confirms the exact public bundle
digest before writing, and cannot use that authorization for another mutation identity. Publishing
preparation replaces recurring exact Brief references with public named input slots. Publishing
never serializes owner-local IDs, credentials, grants, Brief contents, history, or runtime telemetry.

No prompt-level instruction is an acceptable substitute for one of these controls.
