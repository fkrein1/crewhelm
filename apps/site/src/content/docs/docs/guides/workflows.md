---
title: Run a durable Workflow
description: Coordinate a known two-to-eight-stage objective as ordered durable Agent Runs.
type: how-to
audience: owner
area: workflows
availability: available
sources:
  - docs/reference/mcp-tools.md
  - docs/product/philosophy.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - packages/contracts/src/agent-workflows.ts
---

Start a durable Workflow when one outcome has a known sequence of two to eight bounded stages and
should continue even if the MCP conversation disconnects.

## Prerequisites

- Use agents or Full control access.
- An active Agent ID and exact revision with the required Skills and Connections.
- One objective and two to eight short, ordered stages.
- Exact Brief revisions needed across all stages.

## Authority and custody

Workflow start freezes the owner, Agent and fleet revisions, objective, stage prompts, Briefs,
aggregate budget, retention, and optional final output contract. The coordinator receives opaque
identifiers only. It cannot add work, grant authority, call providers, or bypass normal Run and
Tool gate checks.

Every stage executes as a normal bounded Run in one isolated Workflow-owned Session. That Session
cannot be continued or deleted as an ordinary Agent conversation.

## Start the Workflow

1. Confirm that each stage has one distinct purpose and that later stages depend on earlier output.
2. Call `crewhelm_agent_workflows` with `action: "start"`, the exact Agent revision, a fresh
   idempotency key, one objective, and the ordered stages.
3. Add exact Brief revisions without reading and resending their content.
4. Omit `outputContract` for a Markdown deliverable. If software requires JSON, provide one bounded
   object-root schema; it applies only to the final stage.
5. Retain the returned `workflowId` and `revision`.

Use a direct Run instead when the plan is not yet known. A Workflow is not a general graph or a way
to ask the model to invent future authority.

## Inspect progress

1. List active Workflows with a small limit for compact progress.
2. Inspect the selected Workflow by exact ID.
3. Keep `includePrompts` false unless debugging the frozen plan.
4. After completion, inspect compact deliverable metadata first. Request deliverable content only
   when it is needed.

## Verify the outcome

- Stages advance in the submitted order.
- A later stage starts only after the prior Run succeeds.
- The final deliverable records exact Workflow, stage, and Run provenance.
- A typed final object is returned as successful only after schema validation.

## Recover safely

- Cancel active work with `action: "cancel"` and the Workflow's current revision. Cancellation
  prevents later stages but cannot undo an already-dispatched external effect.
- Inspect a failed Workflow before starting a replacement. Do not assume a stage made no external
  change merely because coordination failed.
- Delete only a terminal Workflow after owner confirmation and with Full control access. Terminal
  deletion also removes the Workflow-owned Session, retained execution data, prompts, and
  deliverable.
- On a revision conflict, inspect the current Workflow and use its returned revision.

## Next action

Use [Briefs](/docs/guides/briefs-and-skills/) to freeze exact reference material across all stages,
or [diagnose and recover](/docs/guides/diagnose-and-recover/) a failed Workflow.
