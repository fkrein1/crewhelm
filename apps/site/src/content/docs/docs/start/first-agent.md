---
title: Create your first Agent
description: Create an owner-scoped Agent with bounded defaults and start its first durable Run.
type: tutorial
audience: owner
area: agents
availability: available
sources:
  - CONTEXT.md
  - docs/reference/mcp-tools.md
  - docs/product/philosophy.md
  - packages/contracts/src/control-plane.ts
---

Create an Agent with a clear responsibility, then start one bounded Run and inspect its result.
Agent creation does not grant access to an external provider.

## Prerequisites

- An authorized MCP client with Full control access for Agent creation.
- A short Agent name.
- Stable instructions describing its responsibility and boundaries.
- One concrete task for the first Run.

## Authority and custody

An Agent is owner-scoped. Its definition becomes an immutable revision, and every Run records the
exact revision it uses. Omit optional capability configuration and execution limits for the first
Agent to inherit the current fleet defaults.

Creating an Agent grants no external authority. Connections, native capabilities, and standing
tool authority are separate, explicit configuration choices.

## Create and run the Agent

1. Call `crewhelm_status` to confirm that the control plane is ready.
2. Call `crewhelm_create_agent` with a name, instructions, and a fresh idempotency key.
3. Retain the returned `agent.id` and `agent.revision`.
4. Call `crewhelm_start_run` with that exact Agent ID and revision, a fresh idempotency key, and
   the first prompt. Omit `conversation`, `continuation`, Briefs, and `outputContract`.
5. Retain the returned `run.runId` and `conversation` object.
6. Call `crewhelm_inspect_run` with the Run ID until the Run reaches a terminal state.

For a useful first task, ask for a bounded Markdown result that needs no external tool. This proves
Agent admission and model execution before introducing Connection authority.

## Verify the result

- The Run refers to the same Agent ID and revision returned at creation.
- The Run reaches a terminal state and exposes its Markdown result.
- `crewhelm_get_agent` returns the immutable current definition.
- A later follow-up can pass the returned `conversation` unchanged to `crewhelm_start_run`.

## Recover safely

- On an Agent revision conflict, call `crewhelm_get_agent` and decide whether the current revision
  still matches your intent before starting again.
- If the conversation handle is lost, use `crewhelm_agent_sessions` to list that Agent's
  conversations and inspect the selected one for a fresh handle.
- If the Run waits for approval, inspect the pending action before approving or rejecting it.
- Do not silently retry an external write whose result is unknown. Follow
  [diagnosis and recovery](/docs/guides/diagnose-and-recover/).

## Next action

[Run an Agent](/docs/guides/run-agent/) for continued work, or
[connect an integration](/docs/guides/connections/) when the Agent needs an external provider.
