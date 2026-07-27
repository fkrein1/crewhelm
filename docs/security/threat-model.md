# Threat model

Status: authenticated MCP ingress foundation

## Scope

Crewhelm will expose a remote MCP administration surface, a private control plane, isolated agent
runtimes, and provider connectors. This document records the minimum threats that architecture and
implementation must address as those components are introduced.

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
5. Control plane to agent runtime and workflows
6. Runtime to Composio and external toolkits
7. Repository recipe to installed, owner-approved configuration
8. Build and release automation to published packages and deployments

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
  disabled refresh tokens, token-time owner/scope checks, and immediate hash-based explicit
  revocation
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
redirects, one read-only scope, one exact resource, the configured GitHub numeric owner, a
24-hour public-client lease, no refresh grant, no upstream scope, and no persisted upstream token.
Database hooks force every upstream token field to null before persistence. Revisit the provider
configuration and threat model before adding mutation scopes, multi-owner service, refresh tokens,
additional identity providers, or longer token lifetimes.

The provider seeds the exact MCP resource in insert-only mode so public requests cannot turn
configuration into repeated D1 writes. A future scope or access-token lifetime change requires an
explicit migration of the stored resource row; changing configuration alone intentionally does not
overwrite it.

## Update triggers

Update this model whenever a change adds a trust boundary, data class, provider, execution
capability, external side effect, authentication flow, persistent store, migration, or release
channel.
