# Crewhelm

Crewhelm is an open-source personal control plane for creating and operating AI agents on
Cloudflare. It is designed to be administered through MCP, with a bootstrap CLI and declarative,
shareable agent recipes. Composio supplies the broad app and web integration plane, including
toolkits such as Firecrawl.

The implemented surface includes a deployable Worker, an authenticated MCP control plane with an
owner-scoped Agent registry, bounded Agent runs on Cloudflare Think, a pure ToolGate policy module,
dynamic Composio tool definitions and execution, and local bootstrap and diagnostic commands.
Composio remains the credential and account-authorization owner; Crewhelm attaches a connection to
an immutable Agent revision and applies its own standing authority, budgets, approvals, schedules,
and execution permits.

## Principles

- Personal ownership and simple self-hosting
- Cloudflare-native durable agents
- Full Agents/Think framework reach through policy-enforced Crewhelm adapters
- The full Composio app and web integration catalog instead of hand-built or curated subsets
- MCP as the primary administration interface
- Deterministic, deny-by-default capability policy
- Declarative recipes without secrets or executable code
- Small, independently validated changes

## Development

Use Node.js 24.18.0 and the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

## Bootstrap CLI

Build the local CLI, then deploy Crewhelm to a Cloudflare account already authenticated with
Wrangler:

```sh
pnpm --filter @crewhelm/cli build
node apps/cli/dist/crewhelm.js bootstrap \
  --endpoint https://YOUR_WORKER_HOST \
  --worker-name crewhelm \
  --database-name crewhelm-auth
```

Bootstrap selects the only Cloudflare account available to the authenticated Wrangler identity. If
that identity can access more than one account, select the intended account with `--account-id`.
Before a new deployment, provide `CREWHELM_GITHUB_CLIENT_ID`,
`CREWHELM_GITHUB_CLIENT_SECRET`, `CREWHELM_OWNER_GITHUB_USER_ID`, and
`CREWHELM_COMPOSIO_API_KEY` through the process environment. The owner value is the stable numeric
GitHub user ID, not a login or email. Avoid putting either secret directly in shell history.

Bootstrap creates or reuses the exact D1 database name, applies packaged migrations, generates the
Better Auth secret, deploys the packaged Worker and secrets together, and then diagnoses the public
origin. Bootstrap endpoints must use HTTPS. A retry preserves the D1 database and any secrets on an
existing Worker. Reusing an existing database requires its exact UUID through `--database-id`;
bootstrap verifies its table and migration provenance before changing it. Supply all three GitHub
settings together to update an existing deployment; omit all three to preserve its current OAuth
secrets. Supply `CREWHELM_COMPOSIO_API_KEY` to set or rotate the Composio project key; omit it on an
existing deployment to preserve the current key. Before any database change, bootstrap verifies
that an existing Worker already holds every required secret or that the missing value was supplied
for the pending deployment.

Diagnose without deploying:

```sh
node apps/cli/dist/crewhelm.js doctor --endpoint https://your-worker.example
```

Both commands finish by validating the health response, MCP protected-resource metadata, and OAuth
authorization server discovery through bounded, no-redirect reads. Use `--json` for versioned
machine-readable reports. HTTP is accepted only for exact loopback hosts during local development.

## Worker authentication

The Worker exposes Streamable HTTP MCP at `/mcp`. OAuth clients dynamically register at
`/api/auth/oauth2/register` and authenticate the owner through a GitHub OAuth App. Clients request
`control:read` to inspect control-plane status and Agent summaries, `control:write` to create Agent
definitions, `agents:read` to inspect full Agent definitions including instructions,
`agents:write` to replace Agent configuration through immutable revisions, `autonomy:write` to
grant standing authority and recurring schedules, `connections:read` to list bounded connection
summaries, `connections:write` to create private hosted connection links,
`connection-configs:read` to list project auth configurations, `connection-configs:write` to
enable Composio-managed authentication, and `integrations:read` to search Composio's catalog and
inspect exact tool schemas. Registrations default to all ten Crewhelm scopes plus the standard
`offline_access` scope; every token keeps the exact approved scope set, so adding a capability
never widens an issued token. The consent page discloses the bounded metadata sent to Composio.
The app callback URL must be:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

The bootstrap CLI configures these Worker secrets so account-specific identity and OAuth
configuration do not enter source control:

- `BETTER_AUTH_SECRET` — generated as 48 random bytes for a new deployment
- `COMPOSIO_API_KEY` — the project key used only for fixed-origin Composio catalog and hosted
  Connect Link requests
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `OWNER_GITHUB_USER_ID` — the stable numeric GitHub user ID, not a login or email

The GitHub token is used only to read that numeric ID during authorization and is then discarded.
Better Auth owns the OAuth 2.1 protocol and GitHub login flow; Drizzle persists its protocol state
in the bound D1 database. D1 stores public client metadata with a 30-day Crewhelm lease,
authorization codes, consent, non-refreshing 10-minute login sessions, signing keys, hashed
rotating refresh tokens, and hashes of explicitly revoked access tokens. It never stores the
GitHub token or GitHub client secret. MCP access tokens are audience-bound JWTs that last 15
minutes; client-bound refresh tokens last at most 30 days, rotate on use, and invalidate their
family on replay. Expired protocol records are purged hourly. Authorization endpoints allow at
most 10 requests per minute per Cloudflare client address, and MCP allows 60.

Native and web MCP clients may dynamically register for authorization-code and refresh grants.
Explicit web clients must use HTTPS redirects, while native clients may use HTTPS or exact
loopback HTTP redirects.

The MCP surface exposes:

- `crewhelm_status` — return control-plane readiness; requires `control:read`.
- `crewhelm_list_agents` — return bounded Agent summaries; requires `control:read`.
- `crewhelm_get_agent` — return one Agent's current immutable definition; requires `agents:read`.
- `crewhelm_list_agent_revisions` — list bounded immutable revision summaries for one Agent,
  newest first; requires `agents:read`.
- `crewhelm_get_agent_revision` — return one exact historical immutable Agent definition;
  requires `agents:read`.
- `crewhelm_update_agent` — replace an Agent's editable configuration as a new immutable revision;
  requires `agents:write`, the expected current revision, and an idempotency key. Each Agent retains
  at most 1,000 revisions. Carrying standing grants onto the new revision also requires
  `autonomy:write`.
- `crewhelm_configure_agent_connection` — replace the version-pinned Composio tools exposed from
  one authorized connection on an Agent, or detach that connection by selecting no tools; requires
  `agents:write`, `connections:read`, and `integrations:read`. Selecting standing authority also
  requires the separately consented `autonomy:write` scope. The operation creates an immutable
  Agent revision and never returns the Composio connected-account ID. Each selected tool explicitly
  chooses approval-required or standing authority; destructive actions always require approval.
- `crewhelm_configure_agent_schedule` — configure, replace, or pause one versioned recurring
  schedule bound to an exact Agent revision; creating or replacing an active schedule requires
  `agents:write` and the separately consented `autonomy:write` scope. Pausing requires only
  `agents:write`.
- `crewhelm_get_agent_schedule` — inspect one Agent's current schedule, next trigger, and last
  scheduled run; requires `agents:read`.
- `crewhelm_start_run` — admit and durably start one bounded turn against an exact immutable Agent
  revision; requires `agents:write` and an idempotency key.
- `crewhelm_list_agent_runs` — list recent manual and scheduled runs for one Agent, including
  status and bounded output summaries; requires `agents:read`.
- `crewhelm_inspect_run` — inspect the status, bounded output, and chronological admission,
  approval, dispatch, cancellation, and outcome timeline of one owner-scoped run; requires
  `agents:read`.
- `crewhelm_cancel_run` — idempotently cancel one owner-scoped run while no external tool effect
  has been dispatched; requires `agents:write`.
- `crewhelm_list_run_tool_approvals` — list exact sensitive tool actions waiting on the owner;
  requires `agents:read`.
- `crewhelm_decide_run_tool_approval` — approve or reject one exact pending action; requires
  `agents:write`.
- `crewhelm_search_integrations` — search and paginate the complete non-deprecated Composio
  integration catalog, including Composio-managed and project toolkits; requires
  `integrations:read`.
- `crewhelm_list_integration_auth_configs` — list bounded enabled Composio authentication
  configurations for one exact integration; requires both `integrations:read` and
  `connection-configs:read`. Use the returned opaque `authConfigId` with
  `crewhelm_create_connection_link`.
- `crewhelm_enable_integration` — find or create the enabled Composio-managed authentication
  configuration for one exact integration; requires `connection-configs:write` and returns only
  an opaque `authConfigId`. Calls are idempotent and never return provider credentials.
- `crewhelm_search_integration_tools` — search exact tools and resolved versions across every
  current Composio integration, optionally within one integration; requires `integrations:read`.
- `crewhelm_inspect_integration_tool` — inspect bounded input and output parameter schemas for one
  exact tool and toolkit version; requires `integrations:read`.
- `crewhelm_list_connections` — list bounded owner-scoped connection summaries in stable opaque-ID
  order; requires `connections:read`. The local `initiated` status means Crewhelm created the
  connection record. `authorizationOutcome` separately reports whether the hosted browser flow is
  pending, returned, failed, expired, or untracked for a connection created before return tracking;
  none of those values asserts that the provider account is active or executable.
- `crewhelm_create_connection_link` — create an idempotent private Composio Connect Link for any
  exact authentication configuration; requires `connections:write`. Crewhelm stores opaque
  connection, auth-configuration, and account references plus the short-lived hosted link, never
  provider credentials. The hosted flow returns to a one-time, expiring Crewhelm callback that
  records a receipt without granting an Agent or tool permission.
- `crewhelm_create_agent` — create an idempotent owner-scoped Agent revision with an explicit
  model, bounded instructions and execution limits, and no capability grants; requires
  `control:write`. Each owner can store at most 100 Agents.

`crewhelm_inspect_run` is the durable execution trace: it orders admission, authorization,
approval, reservation, provider dispatch, completion, cancellation, and safe failure reasons.
Workers Logs mirror that lifecycle as structured spans. Filter by `traceId`/`runId`; a
`toolCallId` is the child `spanId`, and `phase`, `checkpoint`, `outcome`, `reason`, and `durationMs`
show where and why execution stopped. The trace records no prompts, tool arguments, outputs,
provider account identifiers, credentials, or response bodies.

Crewhelm's scopes and capability grants control authority, not catalog reach. The MCP design
preserves access to the underlying Agent framework rather than defining a permanently reduced
facade, while deterministic policy decides which capabilities each Agent may use. Composio
discovery covers its complete current non-deprecated catalog, including project toolkits, without
a Crewhelm-maintained integration or tool allowlist. Authentication completes on Composio's hosted
page, so OAuth tokens and API keys do not pass through the MCP client. The browser return is not a
signed provider assertion: configuration and execution each verify the exact opaque account as
active at Composio. Crewhelm snapshots only bounded public tool metadata for selected, pinned
versions and converts those provider schemas through one generic runtime adapter; there is no
per-tool Crewhelm implementation or curated allowlist. Credential-retrieval tools are excluded.
Auth-config discovery returns only bounded display metadata and opaque IDs; credentials and
provider errors are excluded.
The ToolGate policy evaluates an immutable capability grant, a classified action containing
digests instead of raw arguments or targets, and a current policy and budget snapshot. An allow
decision is local policy evidence, not a cross-object execution permit and not permission to call
Composio; runtime admission, atomic budget reservation, single-use verified permits, approval
evidence, account revalidation, and connector execution remain separate boundaries.
Exact tools configured with standing authority may perform routine writes without interrupting the
owner. Destructive actions, policy changes, permission grants, and budget increases remain
approval-gated.

Changing `OWNER_GITHUB_USER_ID` blocks new authorization and refresh, but does not revoke an
already issued 15-minute access token. Rotating only the GitHub client secret blocks new login but
does not invalidate existing Crewhelm refresh tokens. For emergency global revocation, create a
fresh auth D1 database, apply the migrations, replace the `AUTH_DB` binding ID, and deploy. Retain
the old database in quarantine for forensics rather than deleting it. Do not restore or rebind
that database after declaring global revocation: doing so can reactivate its clients, sessions,
signing keys, and unexpired tokens. Recover data into another fresh auth database only through a
reviewed revocation-preserving migration. Then rotate the GitHub OAuth secret and reauthorize
clients. This deliberately invalidates every client, session, signing key, and token without
changing durable owner control-plane state.

Read [AGENTS.md](AGENTS.md) before using an AI coding agent in this repository. Human contribution
guidance lives in [CONTRIBUTING.md](CONTRIBUTING.md). Shared language is defined in
[CONTEXT.md](CONTEXT.md), engineering conventions in
[docs/engineering/design.md](docs/engineering/design.md), and security invariants in
[docs/security/invariants.md](docs/security/invariants.md).

## Architecture and philosophy

- [Product philosophy](docs/product/philosophy.md) explains how Crewhelm chooses and shapes work.
- [System architecture](docs/architecture/system.md) defines ownership, runtime boundaries, and
  dependency direction.
- [Engineering design](docs/engineering/design.md) defines the project's implementation standard.

Repository maintainers should apply the
[GitHub security and branch settings](docs/maintainers/github-settings.md) after creating the
remote repository.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted material.
