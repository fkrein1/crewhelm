# Crewhelm

Crewhelm is an open-source personal control plane for creating and operating AI agents on
Cloudflare. MCP is the administration surface, a local CLI bootstraps and diagnoses the
deployment, and Composio supplies the external integration plane.

The current implementation provides an authenticated, owner-scoped Agent registry; immutable
Agent revisions; bounded manual and scheduled runs on Cloudflare Think; deterministic capability,
approval, budget, and recovery controls; and version-pinned Composio tool discovery and execution.
Declarative, shareable Agent recipes are part of the longer-term product vision, not the current
surface.

## Principles

- Personal ownership and simple self-hosting
- Cloudflare-native durable agents
- MCP-first administration
- Deterministic, deny-by-default authority
- Composio integrations without provider credentials entering Crewhelm
- Bounded execution, explicit side effects, and recoverable state

## Development

Use Node.js 24.18.0 and the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Read [AGENTS.md](AGENTS.md) before using an AI coding agent. Human contribution guidance is in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Bootstrap

Build the CLI, then deploy to a Cloudflare account already authenticated with Wrangler:

```sh
pnpm --filter @crewhelm/cli build
node apps/cli/dist/crewhelm.js bootstrap \
  --endpoint https://YOUR_WORKER_HOST \
  --worker-name crewhelm \
  --database-name crewhelm-auth \
  --ai-budget-usd 1
```

For a new deployment, provide these process-scoped environment variables:

- `CREWHELM_GITHUB_CLIENT_ID`
- `CREWHELM_GITHUB_CLIENT_SECRET`
- `CREWHELM_OWNER_GITHUB_USER_ID` — the stable numeric GitHub user ID
- `CREWHELM_COMPOSIO_API_KEY`

Bootstrap creates or reuses the exact D1 database and a dedicated AI Gateway, applies packaged
migrations, configures Worker secrets, deploys, and diagnoses the public origin. The Gateway's
rolling daily ceiling defaults to $1 when created; later runs preserve a verified existing limit
unless `--ai-budget-usd` is supplied. Use `--account-id` when Wrangler can access multiple
Cloudflare accounts and `--database-id` when reusing an existing database. If Wrangler's OAuth
credential cannot manage AI Gateways, provide a process-scoped
`CREWHELM_CLOUDFLARE_API_TOKEN` with AI Gateway Read and Edit.

Diagnose without deploying:

```sh
node apps/cli/dist/crewhelm.js doctor --endpoint https://YOUR_WORKER_HOST
```

Both commands support `--json`. Public endpoints require HTTPS; exact loopback HTTP is accepted
for local development.

## MCP

The Worker exposes Streamable HTTP MCP at `/mcp`. Clients dynamically register at
`/api/auth/oauth2/register` and authenticate the configured owner through a GitHub OAuth App:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

OAuth scopes separate control-plane, Agent, autonomy, connection, authentication-configuration,
and integration access. Tool visibility does not grant execution authority: Crewhelm revalidates
the owner, scope, immutable Agent revision, capability, approval, connection, budget, and
single-use permit at the relevant boundaries.

The complete [MCP tool reference](docs/reference/mcp-tools.md) is generated from the authenticated
`tools/list` response:

```sh
pnpm docs:mcp
```

For interactive exploration, use the
[official MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector).

## Design and operations

- [Domain language](CONTEXT.md)
- [Product philosophy](docs/product/philosophy.md)
- [System architecture](docs/architecture/system.md)
- [Engineering design](docs/engineering/design.md)
- [Security invariants](docs/security/invariants.md)
- [Threat model and recovery](docs/security/threat-model.md)
- [GitHub repository settings](docs/maintainers/github-settings.md)

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted material.
