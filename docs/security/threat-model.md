# Threat model

Status: authenticated MCP control plane

Crewhelm protects remote MCP administration, owner-local control state, isolated Agent execution,
provider integrations, and deployment authority. The [security invariants](invariants.md) define
the required properties; the [system architecture](../architecture/system.md) defines ownership
and authority flow. This document records threats, control choices, and residual risks.

## Assets and boundaries

Protected assets are owner identity and grants; OAuth clients, sessions, signing keys, and
revocations; Composio project authority and connected accounts; Agent configuration and execution
state; audit, budgets, and recovery data; and repository or deployment authority.

Trust changes at:

1. public OAuth and MCP ingress;
2. fixed GitHub identity endpoints and Auth D1;
3. authenticated ingress to the owner control plane;
4. the control plane to `CrewAgent`;
5. Crewhelm to fixed Composio catalog, connection, and execution endpoints;
6. recipes and model or provider output entering trusted policy;
7. build automation and the bootstrap CLI reaching release or Cloudflare resources.

## Threats and controls

| Threat                                                 | Required control                                                                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token theft, confused identity, or cross-owner access  | Audience-bound short-lived tokens, exact owner and scope checks at ingress and execution, owner-named objects, explicit revocation                                     |
| Malicious OAuth clients, replay, or storage exhaustion | S256 PKCE, HTTPS or exact-loopback redirects, protected state, bounded bodies and sessions, rate limits, expiring registrations, hashed rotating refresh tokens        |
| Prompt injection or hostile provider data              | Treat all model, recipe, MCP, retrieved, and provider content as inert input; trusted code classifies authority, effects, targets, and cost                            |
| Credential disclosure                                  | Keep provider credentials outside models and Crewhelm state; bound and normalize responses; exclude secrets from results, errors, telemetry, URLs, and backups         |
| SSRF or redirected egress                              | Use fixed HTTPS provider endpoints, manual redirect handling, bounded response size and time, and no model-selected network destination                                |
| Stale, replayed, or amplified authority                | Bind permits and approvals to owner, client, Agent revision, action digest, budget, nonce, and short expiry; recheck current policy immediately before execution       |
| Duplicate or partial external effects                  | Reserve idempotency before dispatch, use single-use permits, make cancellation and dispatch mutually exclusive, and block equivalent writes while outcomes are unknown |
| Runaway execution or cost                              | Bound models, turns, tools, schedules, concurrency, payloads, output, duration, and cost before work starts                                                            |
| Unsafe persistence or recovery                         | Apply ordered checksummed migrations before admission; preserve revocation during backup, restore, deletion, and recovery                                              |
| Supply-chain or deployment compromise                  | Pin dependencies and automation, minimize CI permissions, validate release artifacts, and require explicit deployment authority                                        |

Tool discovery never grants execution authority. Model output never grants permission or approves
an action. External writes remain approval-gated where policy classifies them as write or
destructive.

## Residual risks and recovery

### OAuth

Changing the GitHub owner blocks new authorization and refresh but does not revoke an access token
already issued for its remaining lifetime of at most 15 minutes. Rotating only the GitHub client
secret does not invalidate existing Crewhelm refresh tokens. Refresh tokens are client-bound,
hashed at rest, rotate on use, invalidate their family on replay, and expire with the 30-day client
lease. Explicit revocation is immediate. Emergency global revocation uses a fresh migrated Auth D1
binding; the old database is quarantined and must never be rebound because doing so could
reactivate clients, sessions, signing keys, or tokens.

Crewhelm permits only the explicit `control:read`, `control:write`, `agents:read`, `agents:write`,
`connections:read`, `connections:write`, `connection-configs:read`,
`connection-configs:write`, and `integrations:read` capability scopes, plus standard
`offline_access` for refresh. Tokens and existing client registrations are never silently widened.
GitHub login uses no upstream scope, and its transient token is not persisted.

Authorization-server metadata does not advertise the optional authorization response `iss`
parameter because current Codex clients discard it before validation. Crewhelm still emits `iss`;
fixed issuer and endpoints, exact redirect binding, S256 PKCE, authorization-code binding, and
audience-bound token validation remain enforced.

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

Tool execution rechecks the Agent lifecycle, current immutable grant, connection, effect, target,
approval, and budget before issuing a single-use adapter permit. Disabling an Agent or revoking a
connection or capability is owner-local, idempotent, audited, and blocks later admission,
approval, or dispatch. An ambiguous provider outcome remains `unknown` and blocks an equivalent
mutating effect until the owner records `applied` or `not_applied` from independent evidence.
Cancellation and revocation cannot claim to undo an effect that already crossed the provider
boundary.

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
default to approval-gated write. Credential-shaped tools and outputs are denied. Composio remains
the authority for provider consent, deletion, and credential refresh; Crewhelm revocation
immediately stops local use but does not revoke provider-side credentials.

### Observability and deployment

Cloudflare automatic traces and invocation logs remain disabled because request URLs may contain
OAuth or connection capabilities. Allowlisted custom events are diagnostic only and cannot prove a
durable transition. They may contain operation outcomes and durations, provider status and bounded
error identifiers, integration or tool slugs, and opaque owner-local Agent, connection, grant, run,
tool-call, or connection-link correlation identifiers. These identifiers support recovery
diagnosis without identifying a provider account. Events exclude credentials, provider account
identifiers, user content, and request or response bodies. Initial 100-percent custom-event
sampling must be reduced under an explicit retention and cost policy before sustained high-volume
operation.

The bootstrap CLI holds operator deployment authority. It uses pinned Wrangler without a shell,
an allowlisted environment, explicit account and database identity, validated release artifacts,
and bounded output. Ambiguous remote mutations stop with resources preserved for inspection; they
are not assumed successful or automatically repeated.

## Update triggers

Update this model when a change adds or materially changes a trust boundary, data class, identity
provider, permission, execution capability, external side effect, persistent store, recovery path,
telemetry surface, dependency authority, or release channel.
