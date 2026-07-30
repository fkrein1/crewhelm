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
- `crewhelm_get_agent_schedule`: latest dispatch or deferral.

## Ambiguous writes

Unknown integration or connection writes return `reservationId`, `recoverAfter`, and
`retry_same_request`. Reuse the idempotency key: before `recoverAfter` Crewhelm does not
redispatch; afterward the same request renews the reservation. Reconcile external effects only
from independent evidence.
