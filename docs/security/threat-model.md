# Threat model

Status: authenticated MCP control plane

Crewhelm protects remote MCP administration, owner-local control state, isolated Agent execution,
provider integrations, and deployment authority. The [security invariants](invariants.md) define
the required properties; the [system architecture](../architecture/system.md) defines ownership
and authority flow. This document records threats, control choices, and residual risks.

## Assets and boundaries

Protected assets are owner identity and grants; OAuth clients, sessions, signing keys, and
revocations; Composio project authority and connected accounts; Agent configuration, Skill
packages, and execution state; audit, budgets, and recovery data; and repository or deployment
authority.

Trust changes at:

1. public OAuth and MCP ingress;
2. fixed GitHub identity endpoints and Auth D1;
3. authenticated ingress to the owner control plane;
4. the control plane to `CrewAgent`;
5. Crewhelm to fixed Composio catalog, connection, and execution endpoints;
6. recipes and model or provider output entering trusted policy;
7. the Worker reaching its dedicated Cloudflare AI Gateway;
8. build automation and the bootstrap CLI reaching release or Cloudflare resources.

## Threats and controls

| Threat                                                 | Required control                                                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token theft, confused identity, or cross-owner access  | Audience-bound short-lived tokens, exact owner and scope checks at ingress and execution, owner-named objects, explicit revocation                                                         |
| Malicious OAuth clients, replay, or storage exhaustion | S256 PKCE, HTTPS or exact-loopback redirects, protected state, bounded bodies and sessions, rate limits, expiring registrations, hashed rotating refresh tokens                            |
| Prompt injection or hostile provider data              | Treat all model, recipe, MCP, retrieved, and provider content as inert input; trusted code classifies authority, effects, targets, and cost                                                |
| Malicious Skill packages                               | Validate bounded UTF-8 files and safe paths, reject suspected credentials, store immutable content-addressed objects, never execute scripts, and never derive authority                    |
| Registry substitution or dependency drift              | Pin Registry origin, publisher namespace, name, version, and canonical digest; re-fetch and verify authoritative bytes during installation; never accept the orchestrator's returned copy  |
| Credential disclosure                                  | Keep provider credentials outside models and Crewhelm state; bound and normalize responses; exclude secrets from results, errors, telemetry, URLs, and backups                             |
| SSRF or redirected egress                              | Use fixed HTTPS provider endpoints, manual redirect handling, bounded response size and time, and no model-selected network destination                                                    |
| Stale, replayed, or amplified authority                | Bind permits and approvals to owner, client, Agent revision, action digest, budget, nonce, and short expiry; recheck current policy immediately before execution                           |
| Duplicate or partial external effects                  | Reserve idempotency before dispatch, use single-use permits, make cancellation and dispatch mutually exclusive, and block equivalent writes while outcomes are unknown                     |
| Runaway execution or cost                              | Bound models, turns, tools, Workflow stages and aggregate budget, schedules, concurrency, payloads, output, duration, and cost before work starts                                          |
| Workflow replay, callback injection, or stage skipping | Freeze plans and revisions owner-side; route only exact Workflow-to-Run mappings; use stage-specific terminal events and idempotent admission; never give the coordinator bearer authority |
| Model-driven policy escalation                         | Expose fleet mutation as preview-only to MCP; require a deterministic owner step-up path to apply a revision                                                                               |
| Unsafe persistence or recovery                         | Apply ordered checksummed migrations before admission; preserve revocation during backup, restore, deletion, and recovery                                                                  |
| Diagnostic disclosure or error amplification           | Return allowlisted compact error facts, opaque correlation IDs, bounded pages, and opt-in detail; never reflect exceptions, request bodies, provider payloads, or credentials              |
| Supply-chain or deployment compromise                  | Pin dependencies and automation, minimize CI permissions, validate release artifacts, and require explicit deployment authority                                                            |

Tool discovery never grants execution authority. Model output never grants permission or approves
an action. Routine writes may run only under an exact, versioned standing-authority grant created
through a separately owner-consented `autonomy:write` capability, with
bounded budgets; destructive actions remain approval-gated.

## Residual risks and recovery

### OAuth

Changing the GitHub owner blocks new authorization and refresh but does not revoke an access token
already issued for its remaining lifetime of at most 15 minutes. Rotating only the GitHub client
secret does not invalidate existing Crewhelm refresh tokens. Refresh tokens are client-bound,
hashed at rest, rotate on use, invalidate their family on replay, and expire with the 30-day client
lease. Explicit revocation is immediate. Emergency global revocation uses a fresh migrated Auth D1
binding; the old database is quarantined and must never be rebound because doing so could
reactivate clients, sessions, signing keys, or tokens.

Crewhelm accepts only explicitly defined capability scopes plus standard `offline_access` for
refresh. Tokens and existing client registrations are never silently widened. GitHub login uses no
upstream scope, and its transient token is not persisted.

Authenticated CLI diagnosis uses an explicit browser flow with a random exact-loopback callback,
state, and S256 PKCE. It registers a leased native client for `crewhelm:view` only, requests no
refresh token, bounds every OAuth and MCP response, keeps authorization values out of reports, and
attempts to revoke the temporary access token on both success and later-stage failure. It verifies
that the token no longer reaches MCP; cleanup that cannot be confirmed is reported as a failed
diagnosis rather than hidden.

Codex browser mode does not print or invoke the signed authorization target. The CLI binds a
random-capability handoff to exact loopback, emits only that local URL, and requires an explicit
form continuation before returning one no-store, no-referrer redirect to the target. Wrong hosts,
methods, paths, queries, and continuation replay fail closed; timeout closes the listener. Codex
mode never falls back to the system browser.

Revisit this model before adding another identity provider, broader mutations, a multi-owner
service, or longer token lifetimes.

### Persistence and Agent execution

Control-plane state admits requests only after migration versions, names, checksums, required
tables, indexes, and foreign keys validate. Recovery uses a reviewed forward migration or
Cloudflare point-in-time recovery; partial or unknown schemas fail closed.

The owner control plane admits a run and issues short-lived, single-use authority bound to the
exact owner, client, Agent revision, prompt, idempotency key, and budget. `CrewAgent` cannot expose
its namespace or authority-bearing framework entrypoints to public callers. Interrupted inference
is charged when it cannot be proven unspent and is not silently repeated.

Agent capability configuration is inert owner input until its statically registered module
validates prerequisites and contributes to the admitted runtime plan. Modules may require grants;
they cannot create authority.

Native runtime tools are closed, statically registered capability contributions. The admitted plan
binds the exact adapter identity and limits; a model-generated call supplies data only. The owner
control plane rechecks the active Run, Agent revision, fleet revision, duplicate loop bound, and
shared tool-call budget before issuing a five-second permit bound to the input digest. Reservation,
dispatch, completion, failure, and uncertainty are durable audit transitions.

Sandbox code uses one Crewhelm-managed Cloudflare Sandbox container per call. Outbound networking
is disabled by the container class, no Crewhelm or provider credentials are injected, output is
reduced to bounded text, and the container is destroyed after the call. Its process and filesystem
are untrusted and ephemeral. Crewhelm arms an alarm before teardown, then purges the per-call
Durable Object's keys, schedules, runtime metadata, and alarm; an interrupted teardown retries from
that marker. The owner ledger retains the exact Sandbox ID and repeats idempotent purges through a
bounded horizon longer than the SDK's maximum late-open window; Run retention is not released until
one of those final purges succeeds. A dispatched call that does not durably complete is recorded
unknown; Crewhelm does not silently repeat it. Because native Sandbox computation has no external
effect, its audit evidence otherwise follows ordinary Run retention and does not enter the
external-effect reconciliation queue.

Native web search sends only the admitted bounded query and provider controls to the configured
search adapter; its credential never enters Agent storage, model input, results, traces, or errors.
Results are normalized and filtered to public HTTPS URLs. A result carries a source handle signed
for its exact normalized URL and active Run. Controlled fetch accepts that handle or one direct URL,
then revalidates the initial URL and each manual redirect, rejects local names and non-public IP
literals, limits textual media types, bytes, redirects, and time, strips active HTML, and returns a digest with bounded text.
Retrieved text and metadata are hostile evidence. Public reads have no durable external effect, so
an interrupted dispatch is recorded failed and is not silently replayed.

Skill contents are untrusted owner input. R2 stores immutable package versions; owner-local SQLite
stores only compact metadata and digests. Exact reads verify both before returning files. Publishing
or retiring a Skill grants no runtime capability, and `scripts/` remains inert.

Public Registry content adds a separate hostile supply-chain boundary. Recipe and Skill blobs are
immutable and content-addressed; compact D1 projections support discovery but do not replace exact
package verification. GitHub publisher login uses browser-bound, single-use PKCE state; provider
responses are stream-bounded, tokens are used only during the callback and are not retained, and
opaque Registry sessions are stored as hashes. Publication reserves typed D1 intent and
version state before R2 writes. Abandoned writes enter a quarantine grace period before a second
pass deletes only their reserved object keys, preventing late storage completion from escaping
cleanup. Initial public Skill artifacts reject `scripts/`, floating or transitive
dependencies, and missing license or provenance. The self-hosted owner instance fetches exact files,
verifies their pinned digest, runs deterministic checks, and exposes bounded raw content to the MCP
orchestrator as inert untrusted source. The orchestrator can explain findings but cannot grant
authority or establish safety. Local preview reports how Skill instructions can influence each
proposed grant, including whole-catalog remote MCP authority. Installation independently re-fetches
and verifies packages, copies Skills into owner-local R2, and records local IDs and provenance.
Before mutation it durably records the confirmed plan and exact selected Skill packages. Child
writes use deterministic idempotency keys; an interrupted install resumes from the same receipt
without trusting new Registry bytes or duplicating completed imports. The created Agent is disabled,
has no grants, and has no active Schedule or Event Trigger. Selected Connection IDs and operation
templates remain inert plan data until a later explicit authority or autonomy change.
Installed Agents neither read the Registry at runtime nor update automatically. Restriction,
retirement, outage, or later package versions cannot alter an installed copy.

Run and tool authority is also bound to the exact fleet-configuration revision admitted. Any later
configuration revision invalidates unconsumed admission, approval, and dispatch authority; the
owner starts a new run under the new policy.

Durable Agent Workflows freeze objectives and stage prompts in the owner control plane. The
Cloudflare Workflow receives opaque coordinates, advances a fixed two-to-eight-stage sequence, and
must ask the control plane to admit every Run against the frozen Agent and fleet revisions. Only
that admitted Run path passes a canonical objective-and-stage envelope into the isolated Session.
The `CrewAgent` accepts callbacks and terminal events only for its exact stored Workflow and Run
mapping. Stage-specific event types and idempotent completion make duplicate or late delivery inert.
Coordinator failure marks the owner projection failed and prevents later stages; an already
admitted bounded Run may finish, but cannot authorize another stage. Cancellation is revision-bound
and propagates to the active Run. Terminal deletion removes the isolated Session and retained
correlated execution data before the Workflow projection disappears. Explicit Brief inputs are
stored as immutable R2 revisions with owner-local metadata. Admission verifies their media type,
size, digest, and deterministic rendering before freezing aggregate context into the Run or
Workflow record. The Session accepts only the exact frozen payload and treats it as untrusted data,
so its text cannot grant tools or authority. A successful final stage produces one bounded,
digest-verified deliverable; default projections omit its content, and deletion removes it before
the Workflow projection. A durable pre-upload intent makes final-output attachment recoverable:
cancellation or failure deletes an unattached object, while an attached digest is retained until
normal Workflow deletion. Session Run cleanup redacts raw Brief blocks from retained turn metadata
and then acknowledges the deletion boundary before the owner reference may expire.

Tool execution rechecks the Agent lifecycle, current immutable grant, connection, effect, target,
approval, and budget before issuing a single-use adapter permit. Disabling an Agent or revoking a
connection or capability is owner-local, idempotent, audited, and blocks later admission,
approval, or dispatch. An ambiguous provider outcome remains `unknown` and blocks an equivalent
mutating effect until the owner records `applied` or `not_applied` from independent evidence.
Fleet status reports the unresolved count, and a bounded owner-local recovery read exposes only
the opaque run, Agent, connection, tool, and time metadata needed to find that evidence. It never
returns provider payloads, account identity, credentials, or action input. A blocked authorization
or unresolved execution projects as a failed run and inbox exception even if untrusted model prose
claims success.
Cancellation and revocation cannot claim to undo an effect that already crossed the provider
boundary.

MCP diagnostics expose only bounded, owner-local, allowlisted facts. They omit client IDs, provider
text, payloads, credentials, and exceptions. Opaque diagnostic IDs correlate safe logs but grant no
read authority. Ambiguous writes expose only a reservation and recovery time; the idempotency key
remains pinned until recovery permits a new attempt.

### Composio

Catalog reads, auth-configuration reads, managed auth-configuration creation, connection links,
Agent tool attachment, and execution are separate capabilities. All use fixed Composio endpoints,
bounded requests and responses, manual redirect handling, normalized safe errors, and opaque
identifiers.

Reading enabled auth configurations requires `connection-configs:read`. Enabling a
Composio-managed configuration requires `connection-configs:write` and performs a bounded,
idempotent find-or-create for one exact toolkit. Concurrent duplicate writes are suppressed. An
ambiguous create remains unknown unless a bounded follow-up read proves the configuration exists.

Connect Link callbacks are short-lived bearer capabilities visible to Composio and browser
infrastructure. Crewhelm stores only a digest, authenticates the exact owner-local reservation,
returns no identifiers, and treats the callback as lifecycle evidence rather than authorization.
Active account state is established separately when tools are attached and checked again before
execution.

Provider names, descriptions, tags, schemas, and results remain untrusted. Unknown tool effects
default to approval-gated write. Standing authority is selected per exact tool and never applies to
destructive actions. Credential-shaped tools and outputs are denied. Composio remains the authority
for provider consent, deletion, and credential refresh; Crewhelm revocation immediately stops
local use but does not revoke provider-side credentials.

### Remote MCP

Remote MCP server metadata, JSON Schemas, annotations, and results are hostile provider data.
Crewhelm accepts only canonical public HTTPS Streamable HTTP endpoints, relies on strict-public
global fetch routing, handles redirects manually without crossing origins, and creates a fresh
bounded client for discovery or one tool call. It does not expose arbitrary headers, resources,
prompts, subscriptions, or persistent remote sessions.

Public, bearer, and OAuth Connections use the same frozen-catalog and execution path. Bearer setup
occurs through an expiring signed browser handoff bound to the authenticated owner and exact
endpoint. OAuth adds a distinct signed setup capability and request-bound callback state, S256 PKCE,
standards discovery, URL client IDs or dynamic registration, bounded responses, and exact public
HTTPS authorization-server endpoints. Requested scopes are explicit; refresh and reauthentication
cannot widen the frozen granted set. Pending OAuth state, client registration, tokens, and bearer
credentials are encrypted with installation-derived owner storage keys and decrypted only by the
owner-side adapter. Refresh completes before ToolGate records dispatch; failure marks the
Connection unavailable so the owner can reauthenticate the same Connection without replacing its
attachments or grants. Creation, inspection, attachment, execution, reauthentication, and
revocation never return credentials. Revocation clears local ciphertext before attempting any
advertised provider revocation endpoint.

Attaching a Connection creates grants for its entire reviewed catalog at one exact snapshot digest.
Remote hints cannot reduce authority: unknown and nominally read-only operations are classified as
writes, while destructive names or hints remain destructive. ToolGate freezes authorization and
limits, binds a short-lived provider-specific permit to canonical arguments, and records dispatch
before network I/O. The owner revalidates the exact catalog tool and its JSON Schema. Timeouts,
oversized outputs, token reflection, transport failures, and interrupted responses fail closed;
post-dispatch failures remain unknown until owner reconciliation.

### Observability and deployment

Cloudflare automatic traces and invocation logs remain disabled because request URLs may contain
OAuth or connection capabilities. Allowlisted custom events are diagnostic only and cannot prove a
durable transition. They may contain operation outcomes and durations, provider status and bounded
error identifiers, integration or tool slugs, and opaque owner-local Agent, connection, grant, run,
tool-call, or connection-link correlation identifiers. These identifiers support recovery
diagnosis without identifying a provider account. Events exclude credentials, provider account
identifiers, user content, and request or response bodies. Sampling and retention must follow an
explicit cost and data-retention policy.

The optional dedicated AI Gateway is the installation-wide hard dollar guard. Crewhelm does not
duplicate that ceiling locally. When enabled, it persists a provisional cost estimate with pending
Gateway log IDs until exact cost reconciliation. Gateway enforcement and log availability are
eventually consistent, so small in-flight overshoot remains a residual risk; concurrency, run
duration, model-token limits, tool-loop controls, and the Gateway rule limit the exposure. Gateway
request and response payload logging is disabled, while model, token, cost, latency, status, and
opaque Crewhelm correlation metadata remain available for diagnosis.

Without a dedicated Gateway, the direct Cloudflare AI path retains the same admitted token, turn,
duration, and concurrency bounds but has no installation-wide hard dollar ceiling or Gateway cost
reconciliation. The capability boundary remains explicit so owners can add the stronger budget and
observability controls without changing the default model.

The bootstrap CLI holds operator deployment authority. It uses pinned Wrangler without a shell,
an allowlisted environment, explicit account, database, and R2 identity, validated release
artifacts, and bounded output. Ambiguous remote mutations stop with resources preserved for
inspection; they are not assumed successful or automatically repeated.

Fresh-install rehearsal cleanup is limited to exact resources recorded after creation in a bounded
local receipt. Occupied names are never adopted, and unverified deletion remains retryable.

Supported-upgrade rehearsal accepts only an existing pinned fixture and the current packaged
Worker. Before mutation, a private bounded receipt records exact coordinates and SHA-256 evidence
for owner state, migrations, and secret names—not values. Retries accept only the recorded
baseline or target build, preserve ambiguous fixtures, and require a second deployment to be a
no-op.

The public health response exposes only a deployment-protocol version and SHA-256 fingerprint of
the packaged Worker assets; it does not expose credentials, owner identity, configuration, or
runtime state. The CLI compares that identity before production rehearsals and verifies it after
deployment. Interactive rehearsal may offer the operator an explicit matching deployment, while
non-interactive use fails with recovery guidance. A CLI never automatically replaces a Worker that
advertises a newer deployment protocol.

Installation-backed diagnosis and rehearsals treat validated local installation metadata as the
target authority. When an operator also supplies an endpoint, an exact-origin mismatch stops before
network access or authorization.

When local installation metadata is missing, bootstrap adopts an existing Worker only from one
fully active version. It verifies the Worker shape, exact public origin, D1 binding, bounded D1
inventory and Crewhelm schema provenance, plus the optional Gateway binding. It persists those
non-secret coordinates before migrations, Gateway updates, or deployment; split traffic,
conflicting flags, duplicate bindings, unknown databases, and malformed inventory fail closed.

Public pull-request code runs only on disposable, read-only runners after external-contributor
approval. Privileged triggers and shell interpolation of event data are forbidden; actions are
allowlisted and commit-pinned. Dependency resolution uses scoped names, frozen integrity locks, a
minimum release age, registry-only sources, and explicit lifecycle-script policy. Release jobs
restore no caches. A release tag from main builds one allowlisted CLI tarball without install
scripts, verifies its isolated installation and packaged identity, and attests it. A separate
publisher job checks out no code, installs no dependencies, runs no artifact code, and receives
only a workflow- and environment-bound npm OIDC identity. It publishes the verified tarball before
a separate GitHub-write job creates the immutable prerelease; retries require the existing npm and
GitHub artifacts to match exactly.

Pull requests, including forks, and protected-main pushes receive secretless Registry and site
verification in GitHub. Cloudflare Workers Builds owns deployment from the connected repository;
its build token remains in Cloudflare custody and is not exposed to GitHub. A site build token needs
Worker deployment authority; a Registry build token additionally needs remote D1 migration
authority. Registry GitHub OAuth credentials remain runtime Worker secrets and are not build
inputs.

Registry deployment applies ordered D1 migrations before uploading the Worker. Registry and site
builds are independent, so their service contract and every migration remain compatible with the
prior deployed version. Cloudflare deployment and D1 permissions remain account-scoped residual
authority. Suspected compromise requires disabling builds, rotating the affected Cloudflare build
token from the Worker build settings, auditing migrations and Worker versions, restoring verified
Worker versions where needed, and repairing D1 schema state forward.

AI Gateway management may use a process-scoped `CREWHELM_CLOUDFLARE_API_TOKEN` limited to
account-level AI Gateway Edit. Interactive recovery prints a scoped token recipe and never stores
or deploys the token. Bootstrap skips Gateway management unless the operator chooses a daily USD
limit. Routine upgrades preserve only the non-secret Gateway route; an explicit limit change is
applied and read back through Cloudflare.

## Update triggers

Update this model when a change adds or materially changes a trust boundary, data class, identity
provider, permission, execution capability, external side effect, persistent store, recovery path,
telemetry surface, dependency authority, or release channel.
