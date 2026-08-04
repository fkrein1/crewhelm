---
title: Diagnose and recover
description: Diagnose installation, Run, approval, Connection, automation, and uncertain external-effect failures safely.
type: how-to
audience: operator
area: recovery
availability: available
sources:
  - README.md
  - docs/reference/errors.md
  - docs/reference/mcp/index.md
  - docs/security/threat-model.md
  - apps/cli/src/command.ts
  - packages/contracts/src/diagnostics.ts
---

Identify which boundary stopped, read its exact durable state, and take the bounded next action
Crewhelm returns. Preserve uncertain state until the outcome can be proved.

## Prerequisites

- The installation metadata or exact HTTPS Worker origin.
- An MCP client with the narrowest access needed for the recovery action.
- Exact Agent, Run, Workflow, Schedule, Event Trigger, Connection, or tool-call identifiers.
- Access to a provider's authoritative UI or API when an external effect is unknown.

## Authority and custody

Diagnostics return bounded allowlisted facts and opaque correlation IDs. They exclude raw
exceptions, provider payloads, request bodies, user content, credentials, and client IDs.

Reading state does not authorize a mutation. Reconciliation records an owner's independently
verified fact; it must never be based on Agent prose or an ambiguous transport response.

## Diagnose the installation

Run the public health and OAuth discovery checks:

```sh
npx @crewhelm/cli@beta doctor --installation crewhelm.installation.json
```

Add `--authenticated` for a temporary View only session that verifies MCP catalog access and fleet
status, then attempts and verifies token revocation. When both installation metadata and an
endpoint are supplied, an exact-origin mismatch stops before network access.

## Diagnose control-plane attention

1. Call `crewhelm_status`. Review active Runs, inbox attention, expired approvals, pending AI
   usage, active Workflows, and unresolved-effect counts when present.
2. Use `crewhelm_inspect_work` with `operation.kind: "list_inbox"` to list only the relevant
   severity or action-required items.
3. Inspect the exact resource named by the item rather than broad-listing the fleet.
4. Optionally call `crewhelm_status` with recent audit enabled for a bounded owner-local mutation
   timeline.

## Diagnose work and approvals

- Use `crewhelm_inspect_work` with `inspect_run`, `list_approvals`, or `inspect_workflow` for Runs,
  owner decisions, and durable work.
- Use `crewhelm_inspect_automations` with a returned Schedule or Event Trigger object for latest
  dispatch, deferral, or occurrence state.
- Use `crewhelm_inspect_connections` to list Connections. Exact provider inspection is a
  `crewhelm_change_connections` operation because it may verify and activate the account.

## Recover an uncertain external effect

1. Call `crewhelm_inspect_recovery` with `operation.kind: "unresolved_effects"` and keep the exact
   returned effect object.
2. Verify the outcome independently in the provider's authoritative UI or API.
3. If proven applied, pass the effect unchanged to `crewhelm_recover` with
   `operation.kind: "reconcile_effect"` and `resolution: "applied"`.
4. If proven not applied, use the same operation with `resolution: "not_applied"`; only this
   outcome permits an equivalent mutation to be retried.
5. If the outcome cannot be proven, do not reconcile and do not retry. Contact an operator.

## Recover ambiguous control writes

When an integration or Connection write returns `reservationId`, `recoverAfter`, and
`retry_same_request`, preserve the exact facade request. Before `recoverAfter`, Crewhelm does not
redispatch. Afterward, retry only the same request so Crewhelm can renew or
reconcile the reservation.

## Verify recovery

- The exact resource now reports a stable lifecycle state.
- Fleet status no longer reports the resolved item, or shows the expected remaining attention.
- The audit timeline records the bounded recovery action.
- No equivalent external write ran before an unknown outcome was resolved.

## Next action

Use the [error reference](/docs/reference/errors/) for common stable codes, or stop and preserve
state when Crewhelm cannot prove a safe next action.
