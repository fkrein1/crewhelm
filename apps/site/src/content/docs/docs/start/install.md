---
title: Install Crewhelm
description: Provision and verify a personal Crewhelm control plane on your Cloudflare account with the guided CLI.
type: tutorial
audience: owner
area: installation
availability: available
sources:
  - README.md
  - apps/cli/README.md
  - apps/cli/src/command.ts
  - apps/cli/src/bootstrap.ts
  - docs/security/threat-model.md
---

Install a Crewhelm Worker, its durable storage, and owner authentication on your Cloudflare
account. The guided installer deploys the control plane and verifies the resulting public origin.

## Prerequisites

- Node.js 24.18.0 or later within the Node.js 24 release line.
- A terminal authenticated with Cloudflare.
- A Cloudflare account where you can create the required Worker and storage resources.
- A Composio project API key.
- An HTTPS origin for the Crewhelm Worker.

Cloudflare Containers are optional and require Workers Paid. A dedicated AI Gateway hard spend
limit and Brave-backed Agent web search are also optional.

## Authority and custody

The bootstrap CLI holds deployment authority during installation. It stores provider secrets in
the deployed Worker, not in installation metadata. The local `crewhelm.installation.json` file
contains non-secret resource coordinates and becomes authoritative when targeting that
installation later.

Keep the installation file private enough to prevent operational confusion, even though it does
not contain provider credentials. Keep the Composio project key and any optional Cloudflare or
Brave token out of shell history, logs, and committed files.

## Install the control plane

1. From a terminal, run:

   ```sh
   npx @crewhelm/cli@beta up
   ```

2. Follow the prompts to select the Cloudflare account and HTTPS Worker origin.
3. Complete the private GitHub App setup used to authenticate the installation owner.
4. Enter the Composio project key through the secure prompt.
5. Choose whether to configure an AI Gateway daily dollar limit.
6. Wait while the CLI applies packaged migrations, creates isolated Skill storage, deploys the
   Worker, and verifies it.

To add bounded Agent code execution during setup, run `crewhelm up --sandbox`. To keep or return
to the Free-compatible core, run `crewhelm up --no-sandbox`. Sandbox selection is remembered by
later upgrades and never turns on implicitly.

## Verify the installation

Run an installation-backed diagnosis:

```sh
npx @crewhelm/cli@beta doctor --installation crewhelm.installation.json
```

The public diagnosis checks the Worker health and OAuth discovery contract without requesting
owner access. Add `--authenticated` for a temporary View only session that checks MCP discovery
and fleet status, then verifies token revocation before exit.

## Recover safely

- Repeat `crewhelm up` to upgrade or resume setup. It preserves deployed secrets and an existing
  Gateway route, reconciles triggers, and skips an identical Worker upload.
- If installation metadata is missing, rerun `crewhelm up`. Crewhelm verifies the active Worker,
  origin, D1 binding, schema provenance, and optional Gateway route before recreating metadata.
- Stop if Crewhelm reports conflicting or ambiguous remote state. Do not adopt resources or delete
  them by name alone.
- If an authenticated diagnosis cannot confirm temporary token revocation, treat the diagnosis as
  failed. The token still expires after 15 minutes.

## Next action

[Connect an MCP client](/docs/start/connect-mcp/) to the installed `/mcp` endpoint.
