# MCP errors and recovery

Errors use stable codes and fixed messages. Dependency failures add `diagnostic`: an optional
opaque log-correlation `id` plus bounded `certainty`, `phase`, `reason`, `disposition`, and
`nextAction`. Raw exceptions, payloads, credentials, provider text, and user content are excluded.

Use the named `nextAction`. Recovery reads are bounded:

- `crewhelm_inspect_work` with `inspect_run` or `list_approvals`: Run diagnosis and owner decisions.
- `crewhelm_inspect_recovery` with `unresolved_effects`: effects requiring independent verification.
- `crewhelm_inspect_connections` and exact provider inspection through
  `crewhelm_change_connections`: lifecycle and next action.
- `crewhelm_status` with `includeRecentAudit`: recent actions without client IDs.
- `crewhelm_inspect_automations`: Schedule state, event sources, Event Trigger lifecycle, and
  bounded occurrence history.

`event_trigger_busy` means one exact occurrence is still being admitted or recovered. Inspect
Event Trigger history and retry the lifecycle change after that pending occurrence settles; do not
guess whether its Run started.

## Ambiguous writes

Unknown integration or connection writes return `reservationId`, `recoverAfter`, and
`retry_same_request`. Preserve an explicit `requestKey` when one was supplied. A repeated
integration-enablement request first queries Composio: Crewhelm completes the reservation from a
discovered configuration. An empty or uncertain lookup preserves the reservation until
`recoverAfter`; a conclusive provider rejection may release it immediately. Other Connection
writes do not redispatch before `recoverAfter`. Reconcile external effects only from independent
evidence.
