---
title: Schedule recurring Agent work
description: Create, inspect, pause, and revise bounded interval or wall-clock Agent Schedules.
type: how-to
audience: owner
area: schedules
availability: available
sources:
  - CONTEXT.md
  - docs/reference/mcp-tools.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - packages/contracts/src/agent-schedules.ts
---

Create a named recurring responsibility that starts a fresh bounded Run for one exact Agent
revision at an elapsed interval or a daily, weekly, or monthly wall-clock time.

## Prerequisites

- Full control access.
- An active Agent returned by Crewhelm.
- A bounded recurring instruction.
- Any exact Brief revisions the recurring responsibility needs.
- A trigger: interval, or calendar time with an IANA time zone.
- Capacity in the Agent's eight shared recurring-start slots for Schedules and Event Triggers.

## Authority and custody

A Schedule freezes one Agent revision, instruction, optional exact Brief revisions, trigger, output
contract, and schedule limits. It supplies an occurrence, not authority. Every occurrence still
passes normal Run admission and Tool gate checks.

Crewhelm owns alarm timing, one deterministic admission identity per occurrence, duplicate
suppression, history, and recovery. A late alarm advances to the next future occurrence instead of
replaying a backlog.

## Create a Schedule

1. Call `crewhelm_inspect_automations` with `operation.kind: "list_schedules"` and the returned
   Agent object to review existing responsibilities and available capacity.
2. Call `crewhelm_change_automations` with `operation.kind: "create_schedule"`, that Agent, and the
   schedule definition.
3. For an interval, choose from 60 seconds through 7 days. The first Run occurs one interval after
   creation.
4. For calendar timing, provide `HH:mm`, an IANA time zone, and the required daily, weekly, or
   monthly selector. A monthly day that does not exist in a month is skipped.
5. Omit the output contract for Markdown, or freeze one bounded JSON contract for every scheduled
   Run.
6. Add only the returned Brief objects needed for this recurring responsibility. Crewhelm keeps
   their exact immutable revisions internally.
   Crewhelm validates them without requiring the MCP client to read and resend their content.
7. Keep the returned Schedule object unchanged.

## Verify the Schedule

1. Call `crewhelm_inspect_automations` with `operation.kind: "inspect_schedule"` and the returned
   Schedule object.
2. Confirm its status, frozen Agent revision, trigger, and next dispatch time.
3. After an occurrence, inspect its most recent scheduled Run.

## Pause or update

- Pause one exact Schedule through `crewhelm_change_automations` with
  `operation.kind: "pause_schedule"` and the returned Schedule object.
- Update a paused Schedule with `operation.kind: "update_schedule"`, that Schedule object, and a
  new `definition` to reuse its bounded slot.
- Inspect the Schedule before every lifecycle mutation and pass back the newly returned object.

An Agent revision change makes the bound revision stale. Crewhelm pauses or skips the Schedule
instead of silently retargeting it.

## Recover safely

- If a Schedule is busy, inspect it and retry the lifecycle change only after the pending admission
  settles. Do not infer whether its Run started.
- On a revision conflict, inspect the Schedule again before deciding to update.
- Pause the Schedule or update its current configuration without the Brief to release the recurring
  reference. Deleting the Brief still fails closed while any admitted Run or Workflow retains the
  exact revision; inspect that resource and follow its retention lifecycle.
- Inspect the most recent occurrence and Run before manually replacing delayed work. Late alarms do
  not replay missed intervals.
- Pausing prevents future occurrences; it cannot undo an external effect from a Run already
  dispatched.

## Next action

Use an [Event Trigger](/docs/guides/event-triggers/) instead when a supported connected-app event,
not time, should start the work.
