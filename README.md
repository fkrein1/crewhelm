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

## Install and upgrade

Build the CLI, then deploy to a Cloudflare account already authenticated with Wrangler:

```sh
pnpm --filter @crewhelm/cli build
node apps/cli/dist/crewhelm.js up \
  --endpoint https://YOUR_WORKER_HOST
```

On a fresh installation, `crewhelm up` creates a private GitHub App in your browser and securely
prompts for the Composio project key. Interactive setup recommends Cloudflare AI Gateway spend
protection, asks for the daily USD limit when enabled, and also lets you skip it. The CLI applies
packaged migrations, deploys, and diagnoses the public origin. It saves only non-secret
coordinates in `crewhelm.installation.json`; repeat upgrades preserve deployed secrets and an
existing Gateway route, and skip an identical Worker upload while still reconciling triggers.
If that local file is missing but the named Worker already exists, `up` verifies its single active
version, origin, D1 binding and provenance, and optional Gateway route before recreating the file
and starting any deployment mutation. Conflicting or ambiguous remote state stops the upgrade.

Pass `--ai-budget-usd <dollars>` to enable or change the optional Gateway hard limit. Without a
Gateway, Crewhelm keeps run and tool-loop safeguards but has no hard dollar ceiling. Use
`--account-id` when Wrangler can access multiple Cloudflare accounts. If Wrangler's OAuth
credential cannot manage AI Gateways, the CLI opens Cloudflare's API token page and securely
prompts for a scoped token with AI Gateway Edit. Environment variables remain available for
unattended setup; see `crewhelm --help`.

Diagnose without deploying:

```sh
node apps/cli/dist/crewhelm.js doctor --endpoint https://YOUR_WORKER_HOST
```

Add `--authenticated` for an end-to-end installation check. The CLI opens the owner login,
requests only temporary **View only** access, verifies MCP discovery and fleet status, then
attempts and verifies access-token revocation. The diagnosis fails if cleanup cannot be confirmed;
the token expires after 15 minutes regardless. The default diagnosis remains public and
non-interactive.

Both commands support `--json`. Public endpoints require HTTPS; exact loopback HTTP is accepted
for local development.

## MCP

The Worker exposes Streamable HTTP MCP at `/mcp`. Clients dynamically register at
`/api/auth/oauth2/register` and authenticate the configured owner through the private GitHub App:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

Clients request one stable access level: **View only** inspects fleet state, **Use agents** also
operates runs and decides run-time approvals, and **Full control** reconfigures Agents,
integrations, automation, and policy. The installation owner defaults to Full control. The Worker
maps each level to precise internal capabilities before a module handles the request.

Internally, capabilities separate control-plane, Agent, autonomy, connection,
authentication-configuration, and integration access. Tool visibility does not grant execution
authority: Crewhelm revalidates the owner, access level, immutable Agent revision, capability,
approval, connection, budget, and
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
- [MCP architecture](docs/architecture/mcp.md)
- [Engineering design](docs/engineering/design.md)
- [Security invariants](docs/security/invariants.md)
- [Threat model and recovery](docs/security/threat-model.md)
- [GitHub repository settings](docs/maintainers/github-settings.md)

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted material.
