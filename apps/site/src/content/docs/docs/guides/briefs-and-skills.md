---
title: Add Briefs and Skills
description: Give work exact reference context with Briefs and configure reusable Agent guidance with versioned Skills.
type: how-to
audience: owner
area: context
availability: available
sources:
  - docs/product/philosophy.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - docs/reference/mcp/index.md
  - apps/worker/src/agent-capabilities/skills.ts
  - packages/contracts/src/briefs.ts
---

Use a Brief to attach exact owner-provided context to one Run or Workflow. Use a Skill when reusable
instructions should change how an Agent revision works.

## Prerequisites

- Full control access to create or revise a Brief, create or retire Skills, or revise an Agent.
- Use agents or Full control access to attach an existing Brief revision to work.
- Bounded UTF-8 text with no credentials or hidden authority.
- A clear choice between task-specific context and reusable Agent behavior.

## Authority and custody

Briefs and Skills are untrusted owner data. Neither grants a capability, Connection, credential,
approval, or scope. Crewhelm stores immutable content in owner-isolated object storage and keeps
compact metadata, digests, provenance, and lifecycle state in the owner control plane.

Brief content is frozen into Run admission. Skill references are frozen into an Agent revision's
`context.skills` capability. Updating either resource never changes work already admitted.

## Create and use a Brief

1. Call `crewhelm_change_context` with `operation.kind: "create_brief"`, a name, supported media
   type, and bounded content.
2. Keep the returned Brief object unchanged.
3. Pass that Brief object directly to a `run` or `start_workflow` operation. Do not fetch and resend
   the content merely to attach it.
4. Use `crewhelm_inspect_context` with `inspect_brief` for metadata and `read_brief` only when exact
   content is needed.
5. To change the material, call `crewhelm_change_context` with `operation.kind: "revise_brief"`,
   the returned Brief, and new content. Select the new returned revision explicitly for future work.

Briefs accept `text/markdown`, `text/plain`, or `application/json`. One Run or Workflow can attach
up to eight exact revisions.

## Create and use a Skill

1. Call `crewhelm_change_context` with `operation.kind: "publish_skill"` and leave `confirm` false.
2. Review its name, description, provenance, and files. Every package requires `SKILL.md`; other
   UTF-8 files may live only under `assets/`, `references/`, or `scripts/`.
3. Repeat the unchanged operation with `confirm: true` to apply it.
4. Use `crewhelm_inspect_context` with `list_skills` and `inspect_skill` to retain its ID and
   version.
5. Use `inspect_capabilities` to review the `context.skills` Agent capability descriptor.
6. Create or revise the Agent with that capability configured to the selected exact Skill ID and
   version. The module accepts one to eight unique Skill references.

Files under a Skill's `scripts/` directory remain inert. Crewhelm does not execute them.

## Verify the result

- Exact Brief or Skill inspection reports the intended immutable revision or version and digest.
- A Run records the exact Brief revisions admitted.
- Agent inspection reports the exact `context.skills` configuration used by its new revision.
- No content contains provider credentials, authorization tokens, or instructions presented as
  permission.

## Recover safely

- If a Brief revision conflicts, inspect current metadata before revising again.
- Referenced Brief deletion fails closed. Remove or retain the referencing work according to its
  lifecycle instead of forcing deletion.
- Retire a Skill to make it unavailable to future Runs. Existing immutable Agent revisions remain
  historical facts, but an Agent that references the retired version must be revised to an active
  Skill before it can admit more work.
- If object persistence was interrupted, use exact inspection and the returned recovery state. Do
  not create a duplicate package while the original outcome is uncertain.

## Next action

[Run an Agent](/docs/guides/run-agent/) with the exact Brief revision, or update an Agent only after
reviewing the capability change and resulting immutable revision.
