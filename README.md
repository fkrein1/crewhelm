# Crewhelm

Crewhelm is an open-source personal control plane for creating and operating AI agents on
Cloudflare. MCP is the administration surface, a local CLI bootstraps and diagnoses the
deployment, and Composio supplies the external integration plane.

Website: [crewhelm.app](https://crewhelm.app)

The current implementation provides an authenticated, owner-scoped Agent registry; immutable
Agent revisions; bounded manual and scheduled runs on Cloudflare Think; deterministic capability,
approval, budget, and recovery controls; durable ordered Agent workflows that survive MCP
disconnects; and version-pinned Composio tool discovery and execution.
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

Run the guided installer from a terminal authenticated with Cloudflare:

```sh
npx @crewhelm/cli@beta up
```

On a fresh installation, `crewhelm up` creates a private GitHub App in your browser and securely
prompts for the Worker URL and Composio project key. Interactive setup recommends Cloudflare AI
Gateway spend protection, asks for the daily USD limit when enabled, and also lets you skip it. The
CLI applies packaged migrations, provisions isolated Skill package storage, deploys, and diagnoses
the public origin. It saves only non-secret
coordinates in `crewhelm.installation.json`; `crewhelm.installation.example.json` shows the shape.
Repeat upgrades preserve deployed secrets and an existing Gateway route, and skip an identical
Worker upload while still reconciling triggers.
If that local file is missing but the named Worker already exists, `up` verifies its single active
version, origin, D1 binding and provenance, and optional Gateway route before recreating the file
and starting any deployment mutation. Conflicting or ambiguous remote state stops the upgrade.
The public health contract includes a non-secret packaged-build fingerprint and deployment-protocol
version. `doctor` reports whether the installed Worker matches the CLI, production smoke commands
stop before authorization when it does not, and an interactive smoke offers to run the explicit
matching `up`. A newer Worker protocol is never replaced by an older CLI.

One Cloudflare account may host multiple installations when each uses explicit, distinct Worker,
D1, R2, metadata, and callback coordinates. Rate-limit counters and Durable Objects remain
Worker-specific; shared Gateways and GitHub Apps must be explicit, with every callback allowlisted.

Pass `--ai-budget-usd <dollars>` to enable or change the optional Gateway hard limit. Without a
Gateway, Crewhelm keeps run and tool-loop safeguards but has no hard dollar ceiling. Use
`--account-id` when Wrangler can access multiple Cloudflare accounts. If Wrangler's OAuth
credential cannot manage AI Gateways, interactive setup prints the exact account-scoped AI Gateway
Edit recipe, opens Cloudflare's token page, or lets the operator skip or stop. The token is hidden
and process-only. Environment variables remain available for unattended setup; see
`crewhelm --help`.

Use explicit installation metadata to keep a dedicated target authoritative:

```sh
node apps/cli/dist/crewhelm.js up \
  --installation crewhelm.testing.installation.json \
  --json
node apps/cli/dist/crewhelm.js doctor \
  --installation crewhelm.testing.installation.json
```

Installation-backed diagnosis and smoke commands derive their endpoint from the metadata. When
both `--installation` and `--endpoint` are supplied, Crewhelm rejects a mismatch before making a
network request.

Interactive commands accept `--browser system`, `--browser codex`, or `--browser none`. Codex mode
prints a capability-bearing `CODEX_BROWSER_HANDOFF` loopback URL to stderr. Open it in the Codex
in-app browser, then choose **Continue to Crewhelm**. The continuation is single-use; the CLI never
prints the signed authorization target or falls back to the system browser.

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

Stable failure fields and bounded follow-up reads are documented in
[MCP errors and recovery](docs/reference/errors.md).

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
