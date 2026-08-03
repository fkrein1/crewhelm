---
title: Run an Agent
description: Start, continue, inspect, approve, or cancel bounded Agent work through MCP.
type: how-to
audience: owner
area: runs
availability: available
sources:
  - docs/reference/mcp-tools.md
  - docs/architecture/mcp.md
  - docs/security/invariants.md
  - packages/contracts/src/run-admission.ts
---

Start one bounded Agent turn, inspect its exact state, and continue the same owner-private
conversation when another message is needed.

## Prerequisites

- Use agents or Full control access.
- An active Agent returned by Crewhelm.
- A bounded prompt with a clear expected outcome.
- Exact Brief revisions if this Run needs owner-provided context.

## Authority and custody

Each `run` operation creates a new Run. Admission freezes the Agent and fleet
revisions, prompt, optional Briefs, output contract, policy, and budget. A conversation handle is a
private coordinate for continuation, not permission to run.

Agent tools come from the admitted Agent revision. A visible tool still requires its current
grant, limits, effect classification, and any required owner approval before dispatch.

## Start a new conversation

1. Call `crewhelm_inspect_agents` with `operation.kind: "list"` and keep the selected Agent object.
2. Call `crewhelm_change_work` with `operation.kind: "run"`, that Agent, and the `message`. Omit
   `conversation` to start a new one.
3. Attach no more than the exact Brief revisions needed for this task.
4. Omit `outputContract` for normal Markdown. Use a bounded object-root JSON contract only when
   downstream software requires a typed final object.
5. Retain `run.runId` and the returned `conversation` unchanged.

## Inspect and continue

1. Call `crewhelm_inspect_work` with `operation.kind: "inspect_run"` and the Run ID. Request usage
   or timeline detail only when needed.
2. If the Run is waiting for a sensitive tool action, call
   `crewhelm_inspect_work` with `operation.kind: "list_approvals"` for that Run.
3. Review the exact action and call `crewhelm_change_work` with
   `operation.kind: "decide_approval"` to approve or reject it.
4. After the Run completes, pass the returned Agent and `conversation` objects unchanged in a new
   `run` operation for the next message.

Do not continue an old handle after a revision conflict. Inspect the current conversation before
deciding whether to retry the message.

## Verify the outcome

- Exact Run inspection reaches a terminal state or clearly reports what it is waiting for.
- The output corresponds to the admitted Agent revision and prompt.
- Typed output is reported successful only when Crewhelm validates it against the frozen schema.
- Any external effect has a known completion state or remains explicitly unresolved.

## Recover safely

- Use `crewhelm_change_work` with `operation.kind: "cancel_run"` only before an external tool
  effect has been dispatched. Cancellation
  cannot undo a provider write.
- If a conversation handle is lost, list and inspect that Agent's conversations through
  `crewhelm_inspect_work` to recover a fresh copy-ready object.
- On a revision or branch conflict, reread the exact Agent or conversation; do not overwrite newer
  state.
- If an external effect is unknown, stop equivalent writes and follow
  [diagnosis and recovery](/docs/guides/diagnose-and-recover/).

## Next action

Use a [Workflow](/docs/guides/workflows/) when the outcome already has a small ordered plan that
must continue after the MCP conversation disconnects.
