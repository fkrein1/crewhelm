---
title: Install a Recipe
description: Discover and install an immutable public Recipe as inert owner-local Agent and Skill state.
type: how-to
audience: owner
area: recipes
availability: available
sources:
  - docs/product/recipes.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - docs/reference/mcp/index.md
  - packages/contracts/src/recipe-installations.ts
---

Use the Recipe inspect and change surfaces to find a responsibility, inspect its exact public
content, preview how it maps onto your installation, and create a disabled Agent with pinned local Skills. Installation
does not create Connections, grant tool authority, activate recurring work, or start a Run.

## Before you begin

- Full control access for preview and installation.
- Existing active Connections for every required Recipe slot.
- Any required installation capability bindings, such as Workers AI.
- A deliberate choice for every optional Skill, Schedule, Event Trigger, and owner-selected time
  zone.
- Exact owner-local Brief revisions for required slots used by selected recurring operations.

Registry packages and raw Skill files are public untrusted input. Crewhelm fetches them from the
configured canonical Registry origin and verifies exact version digests. Do not treat a publisher,
review label, search rank, or Skill text as authority.

Setup parameters are stored in the owner-local installation plan. Do not use them for credentials.

## Discover and inspect

1. Call `crewhelm_inspect_recipes` with `operation.kind: "search"` and describe the outcome you
   want.
2. Select one exact Recipe coordinate and digest from the bounded results.
3. Call `crewhelm_inspect_recipes` with `operation.kind: "inspect"` and the returned target. Review its responsibility boundaries, requested
   authority, configured primary and fallback models, limits, inputs, Skill dependencies, and
   operation templates.
4. For a selected Skill, call `operation.kind: "read_skill"` with one exact file path. Start with `SKILL.md`; read
   other files only when needed. Skill Markdown remains inert text.

## Preview and install

1. Call `crewhelm_change_recipes` with `operation.kind: "prepare_install"`, the exact Recipe target,
   and a `requestKey`. Keep the returned draft reference unchanged.
2. Update the draft one decision at a time. Use `set_setup` for each setup value,
   `bind_connection` for each existing Connection, `bind_brief` for exact Brief revisions,
   `select_optional_skill` for optional Skills, and `select_operations` for retained Schedules and
   Event Triggers. Each edit returns a new draft revision; use that returned reference for the next
   edit. Include a time zone when a selected calendar Schedule requires one.
3. Call `operation.kind: "preview_install"` with the latest draft. Confirm `ready: true`. Review the rendered Agent, every pinned Skill, Connection compatibility,
   Brief availability, requested authority, execution limits, and retained operations. A selected
   operation with a missing required Brief slot keeps the plan unready; a missing optional slot does
   not. Bindings that exceed the combined Brief context limit are reported as
   `combination_unavailable` and also keep the plan unready.
4. Preserve the returned `confirmationDigest`. If any local fact or public artifact changes, run a
   new preview instead of approving a different plan implicitly.
5. Call `operation.kind: "install"` with the latest draft and confirmation digest. Crewhelm resolves
   the stored plan; do not resend it.
6. After a confirmed installation, or when abandoning the plan, call
   `operation.kind: "discard_install_draft"` with the latest draft reference.

## Verify the result

The receipt reports `status: "installed"`, the imported or reused local Skill IDs and versions,
the disabled Agent ID and revision, exact owner-local Brief bindings, and the retained Schedule and
Event Trigger names. Inspect the Agent to confirm it is disabled, references the intended
`context.skills` versions, and has no capability grants.

Connection choices and operation templates remain in the owner-local receipt. The Registry receives
no installation identity or private usage telemetry, and it is not read when the Agent eventually
runs.

## Recover safely

If install returns `installation_incomplete`, call `crewhelm_change_recipes` with
`operation.kind: "recover_install"` and the returned installation ID. Recovery resumes the same
stored plan and deterministic child writes; completed Skill imports are reused.

To abandon an incomplete installation, keep the Agent disabled and retire any imported Skill only
after confirming no other Agent references it. An installed Recipe never follows Registry updates;
preview a new version as a new change.

## Next step

Inspect the disabled Agent, then [connect integrations](/docs/guides/connections/) and configure only
the authority it needs. Activate a [Schedule](/docs/guides/schedules/) or
[Event Trigger](/docs/guides/event-triggers/) only after that separate review.
