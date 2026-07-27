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
`CREWHELM_GITHUB_CLIENT_SECRET`, and `CREWHELM_OWNER_GITHUB_USER_ID` through the process
environment. The last value is the stable numeric GitHub user ID, not a login or email. Avoid
putting the client secret directly in shell history.

Bootstrap creates or reuses the exact D1 database name, applies packaged migrations, generates the
Better Auth secret, deploys the packaged Worker and secrets together, and then diagnoses the public
origin. Bootstrap endpoints must use HTTPS. A retry preserves the D1 database and any secrets on an
existing Worker. Reusing an existing database requires its exact UUID through `--database-id`;
bootstrap verifies its table and migration provenance before changing it. Supply all three GitHub
settings together to update an existing deployment; omit all three to preserve its current secrets.

Diagnose without deploying:

```sh
node apps/cli/dist/crewhelm.js doctor --endpoint https://your-worker.example
```

Both commands finish by validating the health response, MCP protected-resource metadata, and OAuth
authorization server discovery through bounded, no-redirect reads. Use `--json` for versioned
machine-readable reports. HTTP is accepted only for exact loopback hosts during local development.

## Development Worker authentication

The Worker exposes Streamable HTTP MCP at `/mcp`. OAuth clients dynamically register at
`/api/auth/oauth2/register`, request the single `control:read` scope, and authenticate the owner
through a GitHub OAuth App. The app callback URL must be:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

The bootstrap CLI configures these Worker secrets so account-specific identity and OAuth
configuration do not enter source control:

- `BETTER_AUTH_SECRET` — generated as 48 random bytes for a new deployment
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
