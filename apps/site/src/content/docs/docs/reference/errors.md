---
title: Errors and recovery
description: Interpret Crewhelm stable error codes, bounded diagnostics, and safe recovery actions.
type: reference
audience: operator
area: recovery
availability: available
sources:
  - docs/reference/errors.md
  - docs/reference/mcp-tools.md
  - packages/contracts/src/diagnostics.ts
  - packages/contracts/src/run-admission.ts
  - packages/contracts/src/agent-schedules.ts
  - packages/contracts/src/agent-event-triggers.ts
  - packages/contracts/src/tool-execution.ts
---

Crewhelm errors use stable codes and fixed messages. A dependency failure may add a bounded
`diagnostic` with an opaque correlation `id`, `certainty`, `phase`, `reason`, `disposition`, and
`nextAction`.

Diagnostics exclude raw exceptions, provider text, payloads, credentials, request bodies, and user
content. Follow the named `nextAction`; do not infer recovery from omitted detail.

## Common codes

| Code                              | Meaning                                                                  | Safe response                                                                       |
| --------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `invalid_request`                 | The request shape, field combination, identifier, or bound is invalid.   | Correct the request from the current tool schema. Do not add unadvertised fields.   |
| `invalid_authority`               | The presented authorization is invalid for the request.                  | Reauthorize the client; do not reuse or forward the rejected token.                 |
| `owner_mismatch`                  | The request does not belong to the authenticated installation owner.     | Stop and verify the installation and GitHub identity.                               |
| `insufficient_scope`              | The client access level lacks the required capability.                   | Reauthorize at the required access level only if the broader authority is intended. |
| `incompatible_schema`             | Persisted state does not match the supported migrated schema.            | Stop admission and use the supported upgrade or recovery path.                      |
| `revision_conflict`               | An immutable resource changed after the caller read it.                  | Reread the exact resource, review the new revision, and decide again.               |
| `idempotency_conflict`            | An idempotency key was reused with different input.                      | Use the original exact request, or a new key for genuinely new intent.              |
| `agent_unavailable`               | The Agent is missing, disabled, stale, or otherwise not admissible.      | Inspect the exact Agent and its current revision.                                   |
| `brief_unavailable`               | An exact Brief revision is missing, deleting, or cannot be materialized. | Inspect the Brief reference and bind an available exact revision.                   |
| `run_unavailable`                 | The Run cannot accept the requested operation.                           | Inspect the Run timeline and terminal or waiting state.                             |
| `session_busy`                    | Another exact conversation operation is active.                          | Inspect the Session and retry only after the current operation settles.             |
| `workflow_busy`                   | The Workflow is processing a state transition.                           | Inspect it and retry the lifecycle action against its current revision.             |
| `schedule_busy`                   | A Schedule occurrence admission is pending.                              | Inspect the Schedule and recent Run before retrying the lifecycle change.           |
| `event_trigger_busy`              | An Event Trigger occurrence is being admitted or recovered.              | Inspect occurrence history and wait for that exact occurrence to settle.            |
| `connection_unavailable`          | The Connection is not active or cannot currently dispatch.               | Inspect its exact lifecycle and returned next action.                               |
| `integration_enablement_rejected` | Composio conclusively rejected managed authentication setup.             | Review provider availability and configuration before retrying.                     |
| `capability_unavailable`          | A configured capability or prerequisite is unavailable.                  | Inspect the capability descriptor and its missing prerequisite or setup command.    |
| `budget_exhausted`                | The frozen Run or Workflow budget cannot admit more work.                | Inspect usage; start new work only after an explicit owner decision.                |
| `approval_expired`                | The pending approval passed its validity window.                         | Inspect the Run; do not treat the old approval as authority.                        |
| `unreconciled_effect`             | An equivalent provider effect has an unknown outcome.                    | Verify the existing effect independently before reconciliation or retry.            |

## Recovery reads

- `crewhelm_inspect_work` with `inspect_run` or `list_approvals`: Run diagnosis and owner decisions.
- `crewhelm_inspect_recovery` with `unresolved_effects`: effects requiring independent verification.
- `crewhelm_inspect_connections` and exact provider inspection through
  `crewhelm_change_connections`: lifecycle and next action.
- `crewhelm_status` with recent audit enabled: bounded owner-local mutation history.
- `crewhelm_inspect_automations`: Schedule state, event-source discovery, Event Trigger lifecycle,
  and bounded occurrence history.

## Ambiguous writes

Unknown integration or Connection writes may return `reservationId`, `recoverAfter`, and
`retry_same_request`. Preserve the original facade request and any explicit `requestKey`. A repeated
integration-enablement request first queries Composio: Crewhelm completes the reservation from a
discovered configuration. An empty or uncertain lookup preserves the reservation until
`recoverAfter`; a conclusive provider rejection may release it immediately. Other Connection
writes do not redispatch before `recoverAfter`.

An unknown provider tool effect is different: verify it in the provider's authoritative UI or API
before calling `crewhelm_recover` with `operation.kind: "reconcile_effect"`. Only a proven
`not_applied` result permits an equivalent mutation to be retried.

See [Diagnose and recover](/docs/guides/diagnose-and-recover/) for the full operator procedure.
