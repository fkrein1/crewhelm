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
- An active Agent ID and exact revision.
- A bounded recurring instruction.
- A trigger: interval, or calendar time with an IANA time zone.
- Capacity in the Agent's eight shared recurring-start slots for Schedules and Event Triggers.

## Authority and custody

A Schedule freezes one Agent revision, instruction, trigger, output contract, and schedule limits.
It supplies an occurrence, not authority. Every occurrence still passes normal Run admission and
Tool gate checks.

Crewhelm owns alarm timing, one deterministic admission identity per occurrence, duplicate
suppression, history, and recovery. A late alarm advances to the next future occurrence instead of
replaying a backlog.

## Create a Schedule

1. Call `crewhelm_list_agent_schedules` for the Agent to review existing responsibilities and
   available capacity.
2. Call `crewhelm_configure_agent_schedule` with the exact Agent revision, `scheduleId: null`,
   `expectedScheduleRevision: null`, a fresh idempotency key, and the schedule definition.
3. For an interval, choose from 60 seconds through 7 days. The first Run occurs one interval after
   creation.
4. For calendar timing, provide `HH:mm`, an IANA time zone, and the required daily, weekly, or
   monthly selector. A monthly day that does not exist in a month is skipped.
5. Omit the output contract for Markdown, or freeze one bounded JSON contract for every scheduled
   Run.
6. Retain the returned Schedule ID and revision.

## Verify the Schedule

1. Call `crewhelm_get_agent_schedule` with the Agent and exact Schedule ID.
2. Confirm its status, frozen Agent revision, trigger, and next dispatch time.
3. After an occurrence, inspect its most recent scheduled Run.

## Pause or update

- Pause one exact Schedule through `crewhelm_configure_agent_schedule` with its current revisions
  and a null schedule definition.
- Update a paused Schedule with a new exact definition to reuse that Schedule's bounded slot.
- Reread the Schedule before every lifecycle mutation and use the returned revisions.

An Agent revision change makes the bound revision stale. Crewhelm pauses or skips the Schedule
instead of silently retargeting it.

## Recover safely

- If a Schedule is busy, inspect it and retry the lifecycle change only after the pending admission
  settles. Do not infer whether its Run started.
- On a revision conflict, reread both the Agent and Schedule before deciding to update.
- Inspect the most recent occurrence and Run before manually replacing delayed work. Late alarms do
  not replay missed intervals.
- Pausing prevents future occurrences; it cannot undo an external effect from a Run already
  dispatched.

## Next action

Use an [Event Trigger](/docs/guides/event-triggers/) instead when a supported connected-app event,
not time, should start the work.
