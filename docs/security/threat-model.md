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
redirects, the explicit `control:read`, `control:write`, and `integrations:read` scopes, one exact
resource, the configured GitHub numeric owner, a 24-hour public-client lease, no refresh grant, no
upstream scope, and no persisted upstream token. The consent page distinguishes control-plane
read, Agent creation, and Composio catalog egress; each implementation independently enforces its
required scope. Existing clients and tokens are never silently widened. Database hooks force every
upstream token field to null before persistence. Revisit the provider configuration and threat
model before adding broader mutation classes, multi-owner service, refresh tokens, additional
identity providers, or longer token lifetimes.

The provider seeds the exact MCP resource in insert-only mode so public requests cannot turn
configuration into repeated D1 writes. Scope and access-token lifetime changes require explicit
migrations of the stored resource row; changing configuration alone intentionally does not
overwrite it. Scope migrations update only an explicitly recognized prior representation.

## Agent registry authority and residual risk

The owner-named Durable Object generates Agent IDs and stores each initial configuration as
immutable revision 1. Creation requires `control:write`; status and bounded summary listing require
`control:read`. Caller input cannot select a Durable Object name, add a capability grant, or start
execution. Instructions and model identifiers are stored as inert validated data; using them in a
run requires a separately reviewed runtime authorization boundary.

Every creation carries a bounded idempotency key scoped to the authenticated MCP client. An exact
replay returns the original Agent, while key reuse by that client with different normalized input
fails closed. The record stores only a digest of the normalized request. The Agent, revision,
idempotency record, and minimal audit event commit in one synchronous SQLite transaction. Listing
omits instructions and uses bounded pages so a large or hostile configuration cannot amplify MCP
output. A transactional ceiling of 100 Agents per owner bounds the Agent, revision, idempotency,
audit, and maximum instruction storage created by this surface; exact retries still succeed at the
ceiling, while new creations fail without partial writes. The registry has no edit, delete, run,
connection, or grant operation.

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
file inside the private directory. Existing Worker secrets are additive and preserved. The
directory is removed after Wrangler has exited. Wrangler output is bounded and never reflected to
the user. On timeout or excess output, the CLI terminates the process with bounded escalation and
marks the remote outcome unknown. Database creation, migration, and deployment are reconciled
through validated Cloudflare inventory; an unconfirmed result stops with resources preserved for
inspection and an explicit retry.

## Update triggers

Update this model whenever a change adds a trust boundary, data class, provider, execution
capability, external side effect, authentication flow, persistent store, migration, or release
channel.
