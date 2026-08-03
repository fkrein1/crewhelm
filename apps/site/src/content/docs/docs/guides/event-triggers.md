---
title: Start work from connected-app events
description: Create and operate an Event Trigger that starts bounded Agent Runs from supported Composio events.
type: how-to
audience: owner
area: event-triggers
availability: available
sources:
  - CONTEXT.md
  - docs/reference/mcp-tools.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - packages/contracts/src/agent-event-triggers.ts
---

Create a named Event Trigger that starts a fresh Run when one exact supported event occurs on an
active connected account. Crewhelm owns provider delivery and recovery; you do not configure a
webhook URL or bearer token.

## Prerequisites

- Full control access.
- An active Composio [Connection](/docs/guides/connections/).
- An active Agent ID and exact revision.
- Capacity in the Agent's eight shared recurring-start slots for Event Triggers and Schedules.
- A clear event, supported filters, and bounded instruction for each occurrence.
- Any exact Brief revisions the recurring responsibility needs.

## Authority and custody

An Event Trigger freezes the Agent revision, instruction, Connection, provider account, auth
configuration, event slug and version, delivery kind, filters, optional output contract, optional
exact Brief revisions, and limits. The source payload is untrusted context and cannot grant
authority or choose Brief context.

Crewhelm verifies signed provider delivery before owner routing, deduplicates stable event
identities, bounds pending payloads, and gives each occurrence one deterministic Run admission
identity.

## Discover and create the Event Trigger

1. Call `crewhelm_agent_event_triggers` with `action: "sources"` and the exact active Connection
   ID.
2. Review the returned event slug, event version, delivery kind, and supported filters.
3. Call the tool with `action: "create"`, the exact Agent revision, a fresh idempotency key, and an
   Event Trigger definition using those returned source fields.
4. Write the instruction as the Agent's responsibility for each matching event.
5. Omit the output contract for Markdown, or freeze one bounded JSON contract for every event Run.
6. Add only the exact Brief `{id, revision}` references needed for every matching event.
7. Retain the Event Trigger ID and revision.

## Verify delivery

1. Call `action: "inspect"` for the exact Agent and Event Trigger.
2. Confirm the Connection, source identity, filters, frozen Agent revision, and lifecycle state.
3. Call `action: "history"` to review bounded pending, dispatched, and skipped occurrences.
4. Inspect the Run ID recorded for a dispatched occurrence.

Crewhelm retains the latest 100 terminal occurrences per Event Trigger. It bounds each trigger to
20 pending events and 128 KiB of pending event data; overflow is recorded as skipped rather than
silently accepted.

## Pause, resume, update, or delete

- Use the exact current Agent and Event Trigger revisions for `pause`, `resume`, `update`, and
  `delete` actions.
- Update only with source values returned for the intended active Connection.
- Delete only after confirming no future event should start work. Deletion removes the provider
  trigger, redacts prior definitions, retains an auditable tombstone, and releases the shared slot.

## Recover safely

- `event_trigger_busy` means one exact occurrence is still being admitted or recovered. Inspect
  history and retry the lifecycle change after it settles.
- If a provider lifecycle operation is unknown, inspect the exact Event Trigger and follow its
  recovery state. Do not create a duplicate trigger with a new idempotency key.
- A stale Agent revision pauses or skips the trigger rather than retargeting it.
- Update the Event Trigger without the Brief, or complete Event Trigger deletion, to release the
  recurring reference. Deleting the Brief still fails closed while any admitted Run or Workflow
  retains the exact revision; inspect that resource and follow its retention lifecycle.
- An authenticated but unmatched stale delivery is acknowledged without starting work.
- Pausing or deleting cannot undo an external effect from an already-started Run.

## Next action

Review [diagnosis and recovery](/docs/guides/diagnose-and-recover/) before leaving an autonomous
integration with standing authority.
