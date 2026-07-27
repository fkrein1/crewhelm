# Threat model

Status: authenticated MCP ingress foundation

## Scope

Crewhelm will expose a remote MCP administration surface, a private control plane, isolated agent
runtimes, and provider connectors. This document records the minimum threats that architecture and
implementation must address as those components are introduced.

## Assets

- Owner identity and authorization grants
- GitHub OAuth client secret and the transient upstream access token
- OAuth client registrations, authorization state, token hashes, and wrapped encrypted token props
- Composio project authority, connected accounts, and provider credentials
- Agent configuration, memory, artifacts, and schedules
- Recipe integrity and installed capability grants
- Audit history, budgets, and recovery material
- Repository instructions, automation, and release authority

## Trust boundaries

1. MCP client to Crewhelm's public OAuth and MCP ingress
2. Crewhelm authorization routes to GitHub's fixed OAuth and user API endpoints
3. OAuth ingress to the Cloudflare KV namespace holding clients, grants, and token material
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
- OAuth state, authorization-code, or refresh-token replay; eventual-consistency races in KV
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

- Exact `/mcp` OAuth resource binding, S256 PKCE, short-lived audience-bound access tokens, disabled
  refresh tokens, and token-time scope binding to encrypted owner authority
- GitHub numeric-ID allowlisting with an empty upstream scope; the transient GitHub token is
  discarded before Crewhelm creates a grant
- HTTPS or loopback-only dynamic client redirects, explicit consent that shows the return origin,
  bounded OAuth request bodies, per-client-address platform rate limits, 24-hour client
  registration expiry, and hourly orphan/expiry purging
- Cryptographically random cookie-bound state, fixed outbound GitHub hosts, bounded provider
  responses, safe errors, owner-named references, and scoped execution permits
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
an access token already issued for up to 15 minutes. Emergency global revocation replaces the
`OAUTH_KV` binding with a fresh namespace and deploys the Worker, invalidating all registered
clients, grants, and tokens while leaving owner control-plane state untouched. Retain the prior
namespace for forensics or rollback; deletion is a separate destructive action.

The scheduled purge removes grants after their 24-hour client registration expires. A
cross-colocation KV negative read can briefly be stale, so an authorization completed immediately
before the hourly purge may rarely lose its grant and require reauthorization. This
availability-only race is accepted for the individual release: it cannot widen authority, and
access tokens remain independently audience-bound and expire after 15 minutes. Purge runs inspect
up to 50 records to stay within Cloudflare operation limits and fail visibly rather than silently
accepting an incomplete scan; emergency KV rotation remains the bounded recovery when the
individual deployment outgrows that scan.

Cloudflare's OAuth provider stores authorization codes and grants in KV. PKCE, a required exact
resource, disabled refresh tokens, fixed read-only scope, and 15-minute access tokens contain the
impact if two concurrent exchanges observe an eventually consistent code record: both tokens have
the same owner, client, audience, and read-only authority. This individual-release tradeoff is
accepted in preference to a custom token server. Custom consent and GitHub state are also
cookie-bound and expire after 10 minutes; the upstream GitHub authorization code remains
single-use. Revisit strongly consistent grant coordination before adding mutation scopes,
multi-owner service, refresh tokens, or longer token lifetimes.

## Update triggers

Update this model whenever a change adds a trust boundary, data class, provider, execution
capability, external side effect, authentication flow, persistent store, migration, or release
channel.
