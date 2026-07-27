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

Use `--json` for machine-readable output. HTTP is accepted only for exact loopback hosts during
local development.

## Development Worker authentication

The Worker exposes Streamable HTTP MCP at `/mcp`. OAuth clients dynamically register at
`/oauth/register`, request the single `control:read` scope, and authenticate the owner through a
GitHub OAuth App. The app callback URL must be:

```text
https://YOUR_WORKER_HOST/oauth/github/callback
```

Configure these Worker values with `wrangler secret put` so account-specific identity and OAuth
configuration do not enter source control:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `OWNER_GITHUB_USER_ID` — the stable numeric GitHub user ID, not a login or email

The GitHub token is used only to read that numeric ID during authorization and is then discarded.
OAuth KV stores dynamically registered client metadata for at most 24 hours, authorization grants,
and hashed tokens with wrapped encrypted props. It never stores the GitHub token or GitHub client
secret. Access tokens last 15 minutes, refresh tokens are disabled, expired OAuth records are
purged hourly, authorization endpoints allow at most 10 requests per minute per Cloudflare client
address, and MCP allows 60. The hourly pass also removes grants whose 24-hour client registration
has expired; because KV is eventually consistent, an authorization completed immediately before a
purge can rarely require reauthorization. The current `crewhelm_status` MCP tool returns the
authenticated owner's control-plane readiness.

Changing `OWNER_GITHUB_USER_ID` or the GitHub client secret blocks new authorization but does not
revoke an already issued 15-minute access token. For emergency global revocation, create a fresh
OAuth KV namespace, replace the `OAUTH_KV` binding ID, and deploy. Retain the old namespace for
forensics or rollback rather than deleting it. Then rotate the GitHub OAuth secret and reauthorize
clients. This deliberately invalidates every client, grant, and token without changing durable
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
