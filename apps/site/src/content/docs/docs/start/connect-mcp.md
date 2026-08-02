---
title: Connect an MCP client
description: Authorize an MCP client against your Crewhelm Worker and verify owner-scoped access.
type: tutorial
audience: mcp-client
area: authentication
availability: available
sources:
  - README.md
  - docs/architecture/mcp.md
  - apps/cli/src/doctor.ts
  - apps/worker/src/oauth/access-levels.ts
  - apps/worker/src/oauth/scopes.ts
---

Connect a Streamable HTTP MCP client to Crewhelm, authenticate as the configured GitHub owner, and
verify that the client can read fleet status.

## Prerequisites

- A verified [Crewhelm installation](/docs/start/install/).
- The HTTPS origin recorded in `crewhelm.installation.json`.
- An MCP client that supports Streamable HTTP and OAuth authorization for remote servers.
- Access to the GitHub account configured as the installation owner.

## Authority and custody

The client receives an OAuth access level chosen during authorization. The installation owner
defaults to Full control, but a narrower level is appropriate when the client only needs to
inspect or run Agents. Access levels map to fixed internal capabilities; they do not depend on
prompt wording.

The MCP endpoint and OAuth metadata contain no provider credential. Bearer tokens terminate at the
Worker and are rechecked against owner identity, audience, scope, and revocation.

## Connect

1. Add this remote MCP server URL to the client:

   ```text
   https://YOUR_WORKER_HOST/mcp
   ```

2. Start the client's authorization flow.
3. Sign in with the GitHub account configured as the Crewhelm owner.
4. Review and approve the requested [access level](/docs/reference/access-levels/).
5. After the client connects, call `crewhelm_status`.

Crewhelm dynamically registers compatible clients and advertises the OAuth metadata required for
authorization. Exact client configuration screens differ, so use the client's remote MCP setup
flow rather than copying credentials into configuration.

## Verify the connection

A successful `crewhelm_status` result reports `ready`, fleet usage, diagnostics, inbox attention,
and no more than three advisory next steps. Suggestions are guidance, not authority.

For an independent check, run:

```sh
npx @crewhelm/cli@beta doctor \
  --installation crewhelm.installation.json \
  --authenticated
```

## Recover safely

- If authorization reports the wrong GitHub identity, stop and verify the installation owner's
  configured account. Do not try another user's token.
- If a tool returns `insufficient_scope`, reconnect with the access level required for the intended
  operation. Do not treat broader prompt instructions as permission.
- If discovery fails, run the public `crewhelm doctor` check before changing client settings.
- Revoke the client authorization when the client should no longer administer Crewhelm.

## Next action

[Create and run your first Agent](/docs/start/first-agent/).
