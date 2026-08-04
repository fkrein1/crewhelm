---
title: Connect an external integration
description: Resolve provider authentication, authorize a Composio connected account, and grant selected version-pinned tools to one Agent revision.
type: how-to
audience: owner
area: connections
availability: available
sources:
  - docs/reference/mcp-tools.md
  - docs/architecture/mcp.md
  - docs/architecture/system.md
  - docs/security/threat-model.md
  - packages/contracts/src/connection-attachments.ts
  - packages/contracts/src/integrations.ts
---

Connect an external provider through Composio, then expose only selected, version-pinned tools to
one exact Agent revision.

## Prerequisites

- Full control access.
- The provider or integration you intend to connect.
- Authority to authorize the provider account.
- A clear list of provider actions the Agent needs and the smallest useful limits.

## Authority and custody

Composio holds provider credentials and refreshes supported OAuth credentials. Crewhelm stores an
owner-local Connection plus safe auth-config metadata—never credential values—and gives Agents only
the Connection's opaque ID. Provider auth-config setup, account consent, Connection activation,
tool attachment, and tool execution are separate steps.

Choose `approval_required` unless you explicitly intend to grant standing authority. Standing
authority is exact-tool, revisioned, limited, and optional. Destructive actions remain
approval-gated.

## Authorize the Connection

1. If the integration is unknown, call `crewhelm_inspect_connections` with
   `operation.kind: "search_providers"`. If it is known, skip search.
2. Optionally call `crewhelm_inspect_connections` with
   `operation.kind: "inspect_provider_auth"` and the exact `integrationSlug`. This read reports
   whether authentication is ready, needs an auth-config choice, or needs owner setup. It creates
   no reservation.
3. Call `crewhelm_change_connections` with `operation.kind: "connect_provider"` and the exact
   `integrationSlug`. Crewhelm behaves according to the current authentication state:
   - One active auth config: Crewhelm uses it and creates the account authorization link.
   - No active config with Composio-managed auth available: Crewhelm idempotently creates the
     managed config, then creates the authorization link.
   - Several active configs: choose one returned safe reference and repeat `connect_provider` with
     its `authConfigId`.
   - Custom setup required: no reservation is created. Do not put provider credentials in MCP;
     configure the auth config in Composio, then repeat this step.
4. Open the returned short-lived authorization URL yourself. Never send it to an Agent or another
   person.
5. After provider authorization, pass the returned link result unchanged to
   `crewhelm_change_connections` with `operation.kind: "inspect_provider_connection"`. Exact
   inspection verifies and activates the returned provider account.
6. Keep the returned Connection object unchanged.

## Grant selected tools to an Agent

1. Call `crewhelm_inspect_connections` with `operation.kind: "search_actions"` for the selected
   integration.
2. Retain the exact tool `slug` and immutable `version` pairs.
3. Inspect an individual tool only when its parameter schema needs review.
4. Call `crewhelm_change_connections` with `operation.kind: "grant_provider_actions"`, the returned
   Agent and Connection objects, selected tools, authorization mode, expiry, and the smallest
   useful duration, output, cost, concurrency, and per-Run call limits.
5. Retain the new Agent revision returned by the configuration change.

## Verify the Connection

- Exact Connection inspection reports `active` and the intended integration.
- Agent inspection reports only the selected tool versions and chosen authorization.
- A read or test Run stays within the configured limits.
- Approval-required actions wait for an owner decision before dispatch.

## Recover safely

- If provider authorization expires or fails, inspect the exact Connection lifecycle and follow
  its returned next action. Do not infer success from the browser redirect alone.
- A `setup_required` or `selection_required` result is a prerequisite, not an ambiguous write.
  Resolve it and call `connect_provider` again; there is no reservation to recover.
- If a write returns an ambiguous reservation, retry the same facade request only as directed after
  `recoverAfter`.
- Revoke a Connection through `crewhelm_recover` with `operation.kind: "revoke_connection"` and
  the returned Connection object to stop local use immediately. Provider-side consent and
  credential deletion remain Composio's responsibility.
- For an unknown provider effect, verify the result independently before reconciliation.

## Next action

[Run the Agent](/docs/guides/run-agent/) with a bounded task, or create an
[Event Trigger](/docs/guides/event-triggers/) from a supported event on the active Connection.
