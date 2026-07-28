# Threat model

Status: authenticated MCP control plane

## Scope

Crewhelm's security boundary covers remote MCP administration, a private control plane, isolated
agent runtimes, and provider connectors. This document records the minimum threats and controls for
that architecture, including boundaries whose runtime adapters are outside the implemented
surface.

## Assets

- Owner identity and authorization grants
- GitHub OAuth client secret and the transient upstream access token
- OAuth client registrations and leases, authorization state, login sessions, signing keys, and
  token-revocation hashes
- Composio project authority, connected accounts, and provider credentials
- Agent configuration, memory, artifacts, and schedules
- Recipe integrity and installed capability grants
- Audit history, budgets, and recovery material
- Repository instructions, automation, and release authority

## Trust boundaries

1. MCP client to Crewhelm's public OAuth and MCP ingress
2. Crewhelm authorization routes to GitHub's fixed OAuth and user API endpoints
3. OAuth ingress to the Cloudflare D1 database holding protocol state and signing keys
4. Authenticated MCP ingress to the owner-named private control plane
5. Authenticated MCP ingress to Composio's fixed toolkit and tool catalog endpoints
6. Control plane to agent runtime and workflows
7. Runtime to Composio and external toolkits
8. Repository recipe to installed, owner-approved configuration
9. Build and release automation to published packages and deployments
10. Local bootstrap CLI to the selected Cloudflare account, D1 database, and Worker deployment

## Primary threats

- Token theft, issuer/subject collision, confused-deputy behavior, and cross-owner references
- Missing or confused OAuth resource audiences, scope attenuation that survives only in token
  metadata, malicious dynamic client redirects, and stale grants after identity configuration
  changes
- OAuth state or authorization-code replay, session theft, signing-key disclosure, or an
  accidentally enabled refresh-token path
- Registration or token endpoint storage/cost exhaustion and oversized unauthenticated bodies
- GitHub outage, excessive upstream scopes, account substitution, or secret/error leakage
- Prompt injection causing unauthorized tools, destinations, data flow, or self-approval
- Stale or replayed approval after policy, connection, or revocation changes
- Tool-name/source collision or raw Composio paths bypassing `ToolGate`
- Child-agent privilege amplification or lost cancellation
- Credential disclosure through model context, logs, errors, URLs, or backups
- SSRF, redirect abuse, arbitrary egress, and hostile external MCP servers
- Idempotency-key collision, duplicate effects, and unknown provider outcomes during retries
- Runaway loops, schedules, fan-out, provider usage, and cost
- Malicious or silently widened marketplace recipes
- Unsafe migrations, deletion without revocation, and restore that reactivates execution
- Compromised dependencies, CI workflows, or package publication
- Instruction poisoning or unsafe pull-request automation causing an agent or maintainer to run
  attacker-controlled commands

## Required control families

- Exact `/mcp` OAuth resource binding, S256 PKCE, short-lived signed audience-bound access tokens,
  disabled refresh tokens, token-time owner/scope checks, method-level read/write enforcement, and
  immediate hash-based explicit revocation
- GitHub numeric-ID allowlisting with an empty upstream scope; the transient GitHub token is
  discarded before Crewhelm creates a grant
- HTTPS or loopback-only dynamic client redirects, explicit consent that shows the return origin,
  bounded OAuth request bodies, per-client-address platform rate limits, 24-hour client
  registration expiry, and hourly orphan/expiry purging
- Cryptographically protected OAuth state, secure cookies, non-refreshing 10-minute login sessions,
  fixed outbound GitHub hosts, bounded provider responses, safe errors, owner-named references,
  and scoped execution permits
- Execution-time capability intersection and owner approval distinct from model output
- Default-empty tool inventory, capability IDs, and authority attenuation for child agents
- Pinned Composio execution with explicit accounts; Sessions, raw proxy, and model connection
  management stay disabled
- Full Composio toolkit and exact-tool discovery through a fixed host, exact read scope, manual
  redirect handling, bounded time and response size, strict normalization, and
  provider-independent safe errors
- Private Composio Connect Links through a fixed mutation endpoint, a separate write scope,
  short-lived canonical hosted URLs, opaque owner and connection identifiers, bounded responses,
  durable idempotency reservations, and no connected-account credential reads
- Schema, provenance, size, and content validation
- Idempotency, audit, budgets, rate limits, and a kill switch
- Versioned migrations, backup, quarantined restore, and rollback procedures
- Locked dependencies, minimal CI permissions, review gates, and release provenance
- Review instruction, workflow, manifest, and lockfile changes before running agents or scripts on
  untrusted contributions; never expose repository secrets to fork pull requests

## OAuth recovery and residual risk

Changing the configured GitHub owner ID or client secret stops new authorization but does not revoke
an access token already issued for up to 15 minutes. Explicit OAuth revocation takes effect
immediately through a D1 record containing only the token's SHA-256 hash. Emergency global
revocation creates a fresh auth D1 database, applies the migrations, replaces the `AUTH_DB`
binding, and deploys the Worker. That invalidates all registered clients, sessions, signing keys,
and tokens while leaving owner control-plane state untouched. Retain the prior database in
quarantine for forensics; deletion is a separate destructive action. Never restore or rebind that
database after declaring global revocation, because its old client, session, key, and token state
can become active again. Recovery must import only reviewed, revocation-preserving data into
another fresh migrated auth database.

The scheduled purge removes expired sessions, codes, token records, revocations, signing keys, and
clients whose 24-hour Crewhelm registration lease has expired. D1 provides the consistency needed
for authorization-code consumption and immediate revocation. Public registration remains
rate-limited and bounded, while the lease limits storage duration. An access token issued just
before its client's lease expires remains valid for at most its independent 15-minute lifetime.

Better Auth owns OAuth 2.1 mechanics, JWT/JWKS handling, GitHub login state, and secure session
cookies. Crewhelm still owns the stricter authorization boundary: only HTTPS or exact loopback
redirects, the explicit `control:read`, `control:write`, `agents:read`, `agents:write`,
`connections:read`, `connections:write`, and `integrations:read` scopes, one exact resource, the
configured GitHub numeric owner, a 24-hour public-client lease, no refresh grant, no upstream scope,
and no persisted upstream token. The consent page distinguishes control-plane summary read, full
Agent-definition read, Agent creation, Agent revision updates, local connection-summary read,
Composio catalog egress, and private connection-link creation; each implementation independently
enforces its required scope. Existing clients and tokens are never silently widened. Database hooks
force every upstream token field to null before persistence. Revisit the provider configuration and
threat model before adding broader mutation classes, multi-owner service, refresh tokens,
additional identity providers, or longer token lifetimes.

Dynamic registration accepts only bounded public-client metadata. It recognizes the standard
`native` and `web` application types, requires HTTPS redirects for an explicit web client, and
continues to allow only HTTPS or exact-loopback HTTP redirects overall. Crewhelm records and returns
the validated application type. A client may advertise `refresh_token` alongside
`authorization_code` for interoperability, but Crewhelm normalizes the stored registration to
authorization-code-only before Better Auth sees it. Missing PKCE at authorization and every
refresh-token exchange still fail at the Crewhelm boundary. Duplicate raw JSON object members,
duplicate or additional grant types, unsupported application types, and understood authority-bearing
provider fields fail closed before forwarding. Harmless unknown extension fields are ignored and
dropped when Crewhelm reconstructs the provider request.

The provider seeds the exact MCP resource in insert-only mode so public requests cannot turn
configuration into repeated D1 writes. Scope and access-token lifetime changes require explicit
migrations of the stored resource row; changing configuration alone intentionally does not
overwrite it. Scope migrations update only an explicitly recognized prior representation.

## Control-plane persistence integrity

Drizzle owns the SQLite schema and every feature-level control-plane query. Generated migration SQL
is bundled as immutable Worker input and applied under Durable Object initialization serialization
before any RPC is served. The runtime verifies contiguous migration versions, names, and SHA-256
checksums against its journal. Unknown entries, modified migration content, missing tables or
required indexes, and foreign-key violations make the object incompatible; Crewhelm does not infer
or reconstruct authoritative state from a partial schema. Recovery blocks admissions and uses a
reviewed forward migration or Cloudflare SQLite point-in-time recovery. Migration and
fault-injection tests may use raw SQL to construct hostile states, but production feature paths do
not.

## Agent registry authority and residual risk

The owner-named Durable Object generates Agent IDs and stores configurations as immutable
revisions. Creation requires `control:write`; replacement creates a new revision and requires the
separately consented `agents:write`; status and bounded summary listing require `control:read`;
exact current-definition reads require `agents:read`. Exact reads return instructions only after
validating the owner-generated Agent ID inside the owner-bound Durable Object. The same
`agents:read` scope permits bounded newest-first revision summaries and one exact historical
definition; summaries omit instructions, and stable numeric cursors prevent overlap while new
revisions are appended. Missing, malformed, wrong-owner, and insufficient-scope requests use fixed
failures, and a read creates no audit mutation. Caller input cannot select a Durable Object name or
alter capability grants. Starting a run requires the separately consented `agents:write` scope and
an exact current Agent revision; inspection requires `agents:read`. Instructions and model
identifiers remain inert until the control plane admits a run against their immutable revision.

Every creation and update carries a bounded idempotency key scoped to the authenticated MCP client
and its operation class. An exact replay returns the original Agent revision without another
mutation, while key reuse by that client with different normalized input fails closed. Records
store only request digests. Updates are full configuration replacements, require the expected
current revision, reject no-ops and stale writes, and preserve capability grants. The Agent
revision, current pointer, idempotency record, and one minimal audit event commit in one synchronous
SQLite transaction. Durable Object serialization admits only one of two concurrent writes against
the same revision. Listing omits instructions and uses bounded pages so a large or hostile
configuration cannot amplify MCP output. A transactional ceiling of 100 Agents per owner bounds
initial Agent storage; exact creation retries still succeed at the ceiling, while new creations
fail without partial writes. Each Agent retains at most 1,000 immutable revisions; the final
allowed update and its exact retries succeed, while a distinct update at the ceiling fails without
partial writes. Agent registry methods have no delete or connection-grant operation; connection
onboarding and run admission are separate scoped state machines.

## CrewAgent runtime reachability and defaults

The production Worker exports and binds the SQLite-backed `CrewAgent` class and Workers AI.
`OwnerControlPlane` derives the exact Agent object name and issues a 30-second, single-use permit
that binds the owner, MCP client, Agent revision, run, prompt digest, expiry, nonce, idempotency
key, and an explicit budget reservation. The reservation permits one model call, one turn, no
tools, the exact instruction-plus-prompt character count, bounded output tokens, and a total
wall-clock duration. Admission accepts only explicitly classified runnable models and reserves
against finite rolling 24-hour per-owner ceilings for input characters, model calls, and output
tokens. Only the nonce digest is stored. Verification and redemption occur in the owner object
before `CrewAgent` calls Think submission APIs. Immediately before inference, the Agent asks the
owner object to verify the exact redeemed reservation and current Agent revision again; that
transaction atomically claims the one permitted model call. A concurrent verification, retry, or
crash recovery cannot claim it again, and a crash after the claim is deliberately charged as spent.
The accepted runtime record stores the validated configuration and prompt digest, not the prompt
or nonce.

Run admission is retry-safe across the cross-object boundary. Reissuing an unredeemed idempotent
request rotates the nonce but preserves the original expiry and retention window, so retries cannot
keep a reservation alive after it falls out of budget accounting; reusing the key with different
input fails closed. A run ID is also the Think submission ID and idempotency key. If the owner
records redemption before the Agent submits, a retry can resume only through a five-second,
single-use receiver capability minted inside the original client's authorized owner request.
Inspection uses a distinct capability bound to the inspecting client; a raw run ID cannot call the
Agent receiver. Stale, malformed, replayed, expired, cross-owner, wrong-client, wrong-object,
wrong-prompt, and wrong-revision inputs return fixed failures without exposing model or provider
errors.

MCP and HTTP callers never receive a `CrewAgent` namespace or stub. The production Worker and
`OwnerControlPlane` are the only holders of that internal object capability, and their call sites
use the three Crewhelm receiver methods. Crewhelm additionally shadows the inherited Think
configuration, fetch, transcript, cancellation, approval, submission-management, MCP, host,
workflow, fiber, agent-tool, sub-agent-routing, and facet-scheduling entrypoints that carry
authority outside the admitted execution path. Think's internal transcript and alarm helpers
remain available to the framework; they are not an authentication boundary and are not routed from
untrusted requests. A pinned inherited-method fingerprint and explicit override checks make an
upstream surface change fail tests for review.

Safe lifecycle reads return empty inventories so Think can initialize without creating ambient
authority. Grant-free turns expose no active tools and deny Think action authority. Workspace Bash,
automatic MCP tool materialization, fetch tools, reasoning emission, and model or tool payload
telemetry are disabled. These are deny-by-default policy settings, not a replacement for Think's
framework features or the namespace capability boundary.

A persisted total wall-clock deadline schedules cancellation before submission and remains
effective after Durable Object eviction; cancellation failures propagate so the durable schedule
can retry. Automatic provider-turn recovery is disabled because an interrupted inference cannot be
proven unspent and must not be silently duplicated. Pre-provider submission recovery remains
idempotent. Terminal Agent records, transcript branches, submissions, and materialized output are
deleted after 24 hours. Inspection passes through the owner-authorized control plane, reads output
incrementally, and returns at most 64 KiB of text.

## ToolGate policy authority and residual risk

The pure ToolGate policy module accepts only closed, bounded Crewhelm contracts. It intersects an
immutable capability grant, a trusted adapter's classified action, and an authoritative current
policy and budget snapshot. Exact owner, Agent revision, capability, grant, Crewhelm connection,
Composio integration, tool, pinned toolkit version, effect, and target-digest bindings must match.
The policy denies inactive or stale Agents, grants, and connections; kill-switch activation;
expired grants; exhausted call, concurrency, duration, output, or cost budgets; and unknown cost.
Write and destructive effects return `requires_approval` rather than allow. Valid catalog slugs
are schema-bounded but not curated, so project toolkits and newly discovered Composio integrations
remain eligible without becoming authorized.

Every status and budget snapshot identifies its exact owner, Agent revision, run, grant,
capability, and connection. ToolGate rejects the snapshot before consuming any authority when
those bindings do not match both the grant and classified action, preventing one object's active
status or unused budget from authorizing another object.

The evaluator uses its own current time rather than accepting the snapshot timestamp as current.
It rejects future-dated and more than five-second-old snapshots, checks grant expiry against that
trusted time, and never extends local decision evidence beyond 30 seconds from either evaluation
or snapshot creation.

Raw tool arguments, target values, provider responses, credentials, and secrets do not enter the
policy contract. Input and target digests are authority only when produced by a trusted, versioned
adapter; ToolGate derives the complete canonical action digest. Model output and Composio tags
cannot classify their own effect, targets, or cost. The current allow result is local policy
evidence only. It is not signed, reserves no budget, cannot cross a Durable Object boundary, and no
connector accepts it. Runtime integration remains denied until the execution owner can reserve
budget atomically, rerun the gate against current revocation and kill-switch state, and issue a
short-lived verified permit. Approval-required effects remain unavailable until a distinct
owner-authenticated approval channel exists.

## Composio catalog authority and residual risk

The `integrations:read` MCP catalog tools send bounded searches, optional exact integration
filters, opaque pagination cursors, and exact tool/version inspection requests only to Composio's
fixed toolkit and tool endpoints. `control:read` alone grants no provider egress. Crewhelm always
requests `managed_by=all` for toolkits, resolves current tool definitions explicitly, excludes
deprecated entries, and does not maintain a toolkit or tool allowlist. Newly available Composio
and project integrations and their exact tools therefore remain discoverable without a Crewhelm
code change. Catalog discovery and inspection grant no connection or execution authority.

The adapter sends the project key only in the fixed request header, rejects redirects, propagates
request cancellation, limits latency and response bytes, validates provider structure, and returns
small normalized summaries. Search omits input and output schemas; exact inspection requires the
selected tool slug and concrete toolkit version, rejects provider identity substitution, and
returns only inert JSON parameter maps bounded by raw bytes, nesting depth, node count, container
width, key length, and string length. A later grant flow can snapshot that reviewed contract.
Provider bodies, errors, request IDs, URLs, and the API key never enter MCP failures, logs, D1, or
Durable Objects. A successful provider payload is also rejected if any normalized output string
contains the exact project key. Names and descriptions remain untrusted external text even after
structural validation. A provider outage, schema drift, malformed cursor, missing key, or reflected
key fails closed as one catalog-unavailable result. Connection setup, exact tool classification,
grants, and execution remain separate boundaries.

## Composio connection-link authority and residual risk

The `connections:read` MCP tool queries only the authenticated owner's Durable Object and requires
its dedicated scope at that boundary. It returns at most 50 Crewhelm connection IDs,
auth-configuration references, local statuses, authorization-return outcomes, and creation
timestamps in stable ID order. It never performs Composio egress and excludes connected-account
IDs, hosted links, provider state, and credentials. The current `initiated` status records only
successful local link finalization. Authorization outcomes distinguish a pending, returned,
failed, or expired hosted browser flow; `untracked` identifies a pre-v4 connection for which no
callback evidence exists. None is evidence that provider consent completed or that a connection is
active.

The `connections:write` MCP tool accepts any structurally valid Composio auth-config ID; it has no
toolkit allowlist and grants no Agent or execution authority. The owner Durable Object first binds
the normalized request digest to the authenticated MCP client and idempotency key, reserves a
connection slot, and writes a minimal audit event. Only then does the adapter send the exact auth
config and opaque owner key to Composio's fixed link endpoint. It explicitly requests a private
account, rejects redirects, bounds time and bytes, and accepts only an unexpired canonical
`https://connect.composio.dev/link/ln_…` URL whose token matches the provider response. Provider
bodies, errors, headers, and project keys are never persisted or returned.

The reservation transaction also binds a 256-bit random callback token to the exact owner-local
reservation and conservative recovery deadline while storing only its SHA-256 digest. Before
sending the callback URL, the Worker adds a domain-separated HMAC over the owner, reservation,
conservative expiry, and random token. Successful finalization atomically stores a
Crewhelm-generated connection ID, Composio's opaque connected-account ID, the auth-config
reference, the expiring hosted link, the idempotency result, and one audit event; it also binds the
callback row to that account and replaces the conservative deadline with the shorter provider link
expiry. The raw token and authenticator exist only in the callback URL sent to Composio and in
transient MCP request handling; neither is returned in the MCP result or persisted. The adapter
rejects a normalized Composio result that reflects either secret.

The public callback accepts only GET, the exact capability path, one documented `status`, and at
most one exact connected-account ID. Before an untrusted owner key can select a Durable Object, the
Worker rejects an expired conservative deadline and verifies the HMAC using its secret binding.
The owner object then verifies the random-token digest, the potentially shorter provider expiry,
the reservation, and the connected-account ID. Malformed, forged, cross-owner, substituted,
expired, or contradictory replays receive one fixed denial. Exact terminal replay is inert.
Responses contain no identifiers, use no-store, a no-referrer policy, deny framing, and a
default-deny content security policy. Callback requests share a coarse per-address authorization
rate-limit key that excludes the capability. Recording a return changes only the local
authorization outcome and adds a bounded audit event; it cannot create a grant, execution permit,
or active status.

Callback authentication is domain-separated but derives from the Worker authentication secret.
Rotating that secret intentionally invalidates every outstanding callback URL; the owner must
request a new Connect Link.

An owner-local alarm normally scrubs an expired capability URL and expires an unused callback at
its exact expiry while retaining non-secret idempotency and callback tombstones. The
recovery-deadline alarm is scheduled before provider egress, so cleanup remains bounded by the
30-minute recovery window even if exact-expiry rescheduling fails. Crewhelm never calls
credential-bearing connected-account list or get endpoints. Exact retries replay the same
unexpired link; conflicting key reuse fails. A dispatched request with no validated response
remains unknown and cannot dispatch again. Another key for the same auth config is blocked for the
conservative recovery window, after which any unreceived hosted link has expired and a new intent
may proceed. Link-attempt and connection ceilings bound owner-local storage.

The Composio browser redirect is not a signed provider assertion. Someone who obtains an unexpired
callback URL could submit its one-time receipt, and Composio or browser infrastructure may observe
the bearer URL. The exact account binding, short lifetime, digest-only storage, no-referrer
response, and lack of execution authority bound that residual risk. Completing consent remains a
human action; active-account evidence, labels, grants, execution, disablement, and deletion require
separate reviewed slices.

## Bootstrap and deployment authority

The bootstrap CLI holds the operator's Cloudflare deployment authority. It runs the exact pinned
Wrangler package without a shell, from a private temporary directory, with an allowlisted
environment so an ambient Worker config, `.env`, API base override, or Worker-name override cannot
redirect that authority. It resolves one account from validated `whoami` output, requires explicit
selection when more than one account is available, writes that account ID into every remote command
configuration, and requires HTTPS before any external mutation.

Packaged Worker code, source maps, configuration, and migrations are treated as a release artifact.
Bootstrap validates their exact inventory, file types, size limits, and security-critical config
shape before contacting Cloudflare. An existing D1 database is never selected by name alone: the
operator must confirm its UUID, and Crewhelm checks its table and migration provenance before
applying packaged migrations. A new database that appears after an ambiguous create is preserved
but not trusted automatically.

GitHub OAuth values and the Composio project key enter through the parent process environment, are
removed from Wrangler's child environment, and are passed to Cloudflare only through a mode-0600
file inside the private directory. Existing Worker secrets are additive and preserved. Bootstrap
reads only their names, validates the inventory as hostile input, and rejects an incomplete
point-in-time snapshot before any D1 creation or migration. Another operator can delete a secret
after that snapshot; strict deployment revalidates the required names and fails with the migrated D1
database preserved for a safe retry. The directory is removed after Wrangler has exited. Wrangler
output is bounded and never reflected to the user. On timeout or excess output, the CLI terminates
the process with bounded escalation and marks the remote outcome unknown. Database creation,
migration, and deployment are reconciled through validated Cloudflare inventory; an unconfirmed
result stops with resources preserved for inspection and an explicit retry.

## Update triggers

Update this model whenever a change adds a trust boundary, data class, provider, execution
capability, external side effect, authentication flow, persistent store, migration, or release
channel.
