# MCP errors and recovery

Errors use stable codes and fixed messages. Dependency failures add `diagnostic`: an optional
opaque log-correlation `id` plus bounded `certainty`, `phase`, `reason`, `disposition`, and
`nextAction`. Raw exceptions, payloads, credentials, provider text, and user content are excluded.

Use the named `nextAction`. Recovery reads are bounded:

- `crewhelm_inspect_run`: diagnosis, retention, optional usage, and paged timeline.
- `crewhelm_list_run_tool_approvals`: pending and expired approvals.
- `crewhelm_list_unresolved_tool_effects`: effects requiring independent verification.
- `crewhelm_list_connections` with `connectionId`: lifecycle and next action.
- `crewhelm_status` with `includeRecentAudit`: recent actions without client IDs.
- `crewhelm_list_agent_schedules`: exact schedule identities and current trigger state.
- `crewhelm_get_agent_schedule`: latest dispatch or deferral for one exact schedule.
- `crewhelm_agent_event_triggers`: available connected-app event sources plus exact Event Trigger
  lifecycle and bounded occurrence history.

`event_trigger_busy` means one exact occurrence is still being admitted or recovered. Inspect
Event Trigger history and retry the lifecycle change after that pending occurrence settles; do not
guess whether its Run started.

## Ambiguous writes

Unknown integration or connection writes return `reservationId`, `recoverAfter`, and
`retry_same_request`. Reuse the idempotency key: before `recoverAfter` Crewhelm does not
redispatch; afterward the same request renews the reservation. Reconcile external effects only
from independent evidence.
