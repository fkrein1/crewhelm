# Crewhelm

Crewhelm is an open-source personal control plane for creating and operating AI agents on
Cloudflare. It is designed to be administered through MCP, with a bootstrap CLI and declarative,
shareable agent recipes. Composio supplies the broad app and web integration plane, including
toolkits such as Firecrawl.

The implemented surface includes a deployable Worker, an authenticated MCP control plane with an
owner-scoped Agent registry, bounded no-tool Agent runs on Cloudflare Think, a pure ToolGate policy
module for classified Composio actions, and local bootstrap and diagnostic commands. Composio
catalog discovery and connection onboarding are available; granting and executing integration
tools remain outside the runtime surface.

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
`agents:write` to replace Agent configuration through immutable revisions, `connections:read` to
list bounded connection summaries, `connections:write` to create private hosted connection links,
and `integrations:read` to search Composio's catalog and inspect exact tool schemas. Registrations
default to all seven
scopes; every token keeps the exact approved scope set, so adding a capability never widens an
issued token. The consent page discloses that integration searches send terms to Composio. The app
callback URL must be:

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
in the bound D1 database. D1 stores public client metadata with a 24-hour Crewhelm lease,
authorization codes, consent, non-refreshing 10-minute login sessions, signing keys, and hashes of
explicitly revoked access tokens. It never stores the GitHub token or GitHub client secret. MCP
access tokens are audience-bound JWTs that last 15 minutes, refresh tokens are disabled, and
expired protocol records are purged hourly. Authorization endpoints allow at most 10 requests per
minute per Cloudflare client address, and MCP allows 60.

Native and web MCP clients may dynamically register. Some native clients, including Codex,
advertise `refresh_token` during registration even when the authorization server does not support
it; Crewhelm records those clients as authorization-code-only and never issues a refresh token.
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
  at most 1,000 revisions.
- `crewhelm_start_run` — admit and durably start one bounded no-tool turn against an exact immutable
  Agent revision; requires `agents:write` and an idempotency key.
- `crewhelm_inspect_run` — inspect the status and bounded output of one owner-scoped run; requires
  `agents:read`.
- `crewhelm_search_integrations` — search and paginate the complete non-deprecated Composio
  integration catalog, including Composio-managed and project toolkits; requires
  `integrations:read`.
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

Crewhelm's scopes and capability grants control authority, not catalog reach. The MCP design
preserves access to the underlying Agent framework rather than defining a permanently reduced
facade, while deterministic policy decides which capabilities each Agent may use. Composio
discovery covers its complete current non-deprecated catalog, including project toolkits, without
a Crewhelm-maintained integration or tool allowlist. Authentication completes on Composio's hosted
page, so OAuth tokens and API keys do not pass through Crewhelm or the MCP client. The browser
return is not a signed provider assertion: Crewhelm records it as lifecycle information and still
requires a later deterministic grant and execution check before any tool can use the connection.
The ToolGate policy accepts any valid exact Composio toolkit, tool, and pinned version rather than
a curated catalog subset. It evaluates only an immutable capability grant, a classified action
containing digests instead of raw arguments or targets, and a current policy and budget snapshot.
An allow decision is local policy evidence, not a cross-object execution permit and not permission
to call Composio; runtime admission, atomic budget reservation, verified permits, approval
evidence, and connector execution remain separate boundaries.

Changing `OWNER_GITHUB_USER_ID` or the GitHub client secret blocks new authorization but does not
revoke an already issued 15-minute access token. For emergency global revocation, create a fresh
auth D1 database, apply the migrations, replace the `AUTH_DB` binding ID, and deploy. Retain the
old database in quarantine for forensics rather than deleting it. Do not restore or rebind that
database after declaring global revocation: doing so can reactivate its clients, sessions, signing
keys, and unexpired tokens. Recover data into another fresh auth database only through a reviewed
revocation-preserving migration. Then rotate the GitHub OAuth secret and reauthorize clients. This
deliberately invalidates every client, session, signing key, and token without changing durable
owner control-plane state.

Read [AGENTS.md](AGENTS.md) before using an AI coding agent in this repository. Human contribution
guidance lives in [CONTRIBUTING.md](CONTRIBUTING.md). Shared language is defined in
[CONTEXT.md](CONTEXT.md), module conventions in
[docs/engineering/module-design.md](docs/engineering/module-design.md), and security invariants in
[docs/security/invariants.md](docs/security/invariants.md).

## Architecture and philosophy

- [Product philosophy](docs/product/philosophy.md) explains how Crewhelm chooses and shapes work.
- [System architecture](docs/architecture/system.md) defines ownership, runtime boundaries, and
  dependency direction.
- [Code philosophy](docs/engineering/code-philosophy.md) defines the project's standard for
  simple, complete implementations.

Repository maintainers should apply the
[GitHub security and branch settings](docs/maintainers/github-settings.md) after creating the
remote repository.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted material.
