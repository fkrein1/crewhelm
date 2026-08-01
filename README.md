<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="packages/design/assets/crewhelm-readme-header-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="packages/design/assets/crewhelm-readme-header-light.svg">
    <img alt="CREWHELM — Give Agents a mandate. Not a master key." src="packages/design/assets/crewhelm-readme-header-light.svg" width="620">
  </picture>
</p>

<p align="center">
  <strong><a href="https://crewhelm.app">Website</a></strong> ·
  <strong><a href="#bring-up-your-helm">Quick start</a></strong> ·
  <strong><a href="docs/reference/mcp-tools.md">MCP reference</a></strong> ·
  <strong><a href="docs/architecture/system.md">Architecture</a></strong>
</p>

**Own the control plane. Grant the minimum. Let routine work run.** Crewhelm creates and operates
long-lived Agents on your Cloudflare account—with exact capability grants, immutable revisions,
budgets, approvals, and a complete audit trail.

MCP is the administration surface. A local CLI bootstraps and diagnoses the deployment. Composio
holds provider credentials while Agents receive only bounded use.

## Why Crewhelm

| Principle                  | What it means                                                                     |
| -------------------------- | --------------------------------------------------------------------------------- |
| **Own the control plane**  | Durable state, policy, and operational control stay in infrastructure you own.    |
| **Grant the minimum**      | Capability grants are explicit; provider credentials remain in Composio.          |
| **Let routine work run**   | Runs proceed within standing authority and fixed budgets.                         |
| **Keep stops recoverable** | Approve, deny, disable, revoke, retry, and inspect without improvising authority. |

> [!NOTE]
> **Available today:** an authenticated, owner-scoped Agent registry; immutable revisions;
> bounded manual and scheduled runs; durable ordered workflows; deterministic authority,
> approval, budget, and recovery controls; and version-pinned Composio tool execution.
>
> Declarative, shareable Agent recipes remain part of the longer-term product vision.

## Bring up your helm

Run the guided installer from a terminal authenticated with Cloudflare:

```sh
npx @crewhelm/cli@beta up
```

`crewhelm up` provisions the control plane, deploys it, and verifies what came up. It stores only
non-secret coordinates in `crewhelm.installation.json`; see
`crewhelm.installation.example.json` for the shape.

Bounded Agent code execution is optional because Cloudflare Containers require Workers Paid. Add
`--sandbox` to `crewhelm up` to check plan access, provision it, and wait for readiness; repeat
upgrades remember that choice. Use `--no-sandbox` to opt out again. Without Sandbox, the capability
catalog returns the missing prerequisite, paid-plan requirement, and setup command while the rest
of Crewhelm remains usable on the Free plan.

Native Agent web search is independently opt-in. Supply `CREWHELM_BRAVE_SEARCH_API_KEY` when
running `crewhelm up`, then enable `tools.web-search` on the Agent. `tools.web-fetch` needs no
additional paid Worker feature and can read either a direct public HTTPS URL or an exact source
handle returned by search in the same Run. Without the key, the MCP capability catalog keeps
search visible and returns its missing prerequisite and setup command; fetch and all other
capabilities remain available.

### Guided setup

- **Connect.** Create a private GitHub App and securely enter the Worker URL and Composio project
  key.
- **Protect spend.** Enable an optional Cloudflare AI Gateway hard limit or continue without one.
- **Provision.** Apply packaged migrations, create isolated Skill package storage, and deploy the
  Worker.
- **Verify.** Diagnose the public origin against the CLI's packaged build and deployment protocol.

### Upgrade and recovery guarantees

- Repeat upgrades preserve deployed secrets and an existing Gateway route, reconcile triggers,
  and skip an identical Worker upload.
- If local installation metadata is missing, `up` verifies the Worker's active version, origin, D1
  binding, provenance, and optional Gateway route before recreating it. Conflicting or ambiguous
  remote state stops the upgrade.
- Production rehearsal commands stop before authorization when the installed Worker does not match
  the CLI. An older CLI never replaces a newer Worker protocol.

Run `crewhelm rehearse --help` to discover the Agent, integration, installation, and upgrade
journeys. Each command is explicit about the production state it creates and cleans up.

### Operator controls

| Need                         | Use                                                        |
| ---------------------------- | ---------------------------------------------------------- |
| Set a hard AI spend limit    | `--ai-budget-usd <dollars>`                                |
| Select a Cloudflare account  | `--account-id <id>`                                        |
| Choose browser handling      | `--browser system`, `--browser codex`, or `--browser none` |
| Target installation metadata | `--installation <path>`                                    |
| Produce machine output       | `--json`                                                   |

Without an AI Gateway, Crewhelm still enforces run and tool-loop safeguards but has no hard dollar
ceiling. If Wrangler cannot manage AI Gateways, guided setup provides the exact account-scoped
token recipe; the token remains hidden and process-only. Environment variables are available for
unattended setup—see `crewhelm --help`.

### Target multiple installations

One Cloudflare account may host multiple installations when each has distinct Worker, D1, R2,
metadata, and callback coordinates. Rate-limit counters and Durable Objects remain Worker-specific;
shared Gateways and GitHub Apps must be explicit, with every callback allowlisted.

Use explicit installation metadata to keep a dedicated target authoritative:

```sh
node apps/cli/dist/crewhelm.js up \
  --installation crewhelm.testing.installation.json \
  --json
node apps/cli/dist/crewhelm.js doctor \
  --installation crewhelm.testing.installation.json
```

Installation-backed diagnosis and rehearsal commands derive their endpoint from the metadata. When
both `--installation` and `--endpoint` are supplied, Crewhelm rejects a mismatch before making a
network request.

### Diagnose without deploying

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

### Use the Codex browser handoff

Codex browser mode prints a capability-bearing `CODEX_BROWSER_HANDOFF` loopback URL to stderr.
Open it in the Codex in-app browser, then choose **Continue to Crewhelm**. The continuation is
single-use; the CLI never prints the signed authorization target or falls back to the system
browser.

## Administer through MCP

The Worker exposes Streamable HTTP MCP at `/mcp`. Clients register dynamically and authenticate the
configured owner through the private GitHub App:

```text
https://YOUR_WORKER_HOST/api/auth/callback/github
```

### Choose an access level

| Access           | Authority                                                   |
| ---------------- | ----------------------------------------------------------- |
| **View only**    | Inspect fleet state.                                        |
| **Use agents**   | Inspect state, operate runs, and decide run-time approvals. |
| **Full control** | Reconfigure Agents, integrations, automation, and policy.   |

The installation owner defaults to **Full control**. Crewhelm maps each stable access level to
precise internal capabilities before a module handles the request.

### Authority stays explicit

Internally, capabilities separate control-plane, Agent, autonomy, connection,
authentication-configuration, and integration access. Tool visibility does not grant execution
authority: Crewhelm revalidates the owner, access level, immutable Agent revision, capability,
approval, connection, budget, and single-use permit at the relevant boundaries.

### Explore the surface

- [MCP tool reference](docs/reference/mcp-tools.md) — generated from the authenticated
  `tools/list` response.
- [MCP errors and recovery](docs/reference/errors.md) — stable failure fields and bounded
  follow-up reads.
- [Official MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) — interactive
  protocol exploration.

## Development

Use Node.js 24.18.0 and the pinned pnpm version:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

Run `pnpm docs:mcp` after changing the MCP surface. Read [AGENTS.md](AGENTS.md) before using an AI
coding agent; human contribution guidance is in [CONTRIBUTING.md](CONTRIBUTING.md).

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
