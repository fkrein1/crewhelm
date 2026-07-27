# Crewhelm

Crewhelm is an open-source personal control plane for creating and operating AI agents on
Cloudflare. It is designed to be administered through MCP, with a bootstrap CLI and declarative,
shareable agent recipes. Composio supplies the broad app and web integration plane, including
toolkits such as Firecrawl.

The repository is implementing its first Cloudflare runtime slices. A deployable health Worker,
authenticated read-only MCP status tool, and local diagnostic CLI are available, but no usable
agent runtime has been released yet.

## Principles

- Personal ownership and simple self-hosting
- Cloudflare-native durable agents
- Composio-backed app and web tools instead of hand-built integrations
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

Build the local CLI and diagnose a deployed Worker origin:

```sh
pnpm --filter @crewhelm/cli build
node apps/cli/dist/crewhelm.js doctor --endpoint https://your-worker.example
```

The command validates the health response, MCP protected-resource metadata, and OAuth authorization
server discovery through bounded, no-redirect reads. Use `--json` for the versioned machine-readable
report. HTTP is accepted only for exact loopback hosts during local development.

## Development Worker authentication

The Worker exposes Streamable HTTP MCP at `/mcp`. OAuth clients dynamically register at
`/api/auth/oauth2/register`, request the single `control:read` scope, and authenticate the owner
through a GitHub OAuth App. The app callback URL must be:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

Before the first deployment, create a dedicated auth database:

```sh
pnpm --filter @crewhelm/worker exec wrangler d1 create YOUR_AUTH_DB_NAME
```

Replace the development `database_name` and `database_id` checked into
`apps/worker/wrangler.jsonc` with the values returned for your database. Set `PUBLIC_ORIGIN` in
that file to the exact HTTPS origin users will visit, with no path or trailing slash. Then apply
the checked-in migrations before deploying:

```sh
pnpm --filter @crewhelm/worker exec wrangler d1 migrations apply AUTH_DB --remote
```

Configure these Worker values with `wrangler secret put` so account-specific identity and OAuth
configuration do not enter source control:

- `BETTER_AUTH_SECRET` — at least 32 random bytes, unique to the deployment
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
minute per Cloudflare client address, and MCP allows 60. The current `crewhelm_status` MCP tool
returns the authenticated owner's control-plane readiness.

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
- [Decision records](docs/decisions/) capture durable choices without turning routine work into
  process.

Repository maintainers should apply the
[GitHub security and branch settings](docs/maintainers/github-settings.md) after creating the
remote repository.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted material.
