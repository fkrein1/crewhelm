---
title: Operating model
description: Understand how the CLI, MCP control plane, Agents, Runs, Workflows, and automation divide responsibility.
type: explanation
audience: owner
area: architecture
availability: available
sources:
  - CONTEXT.md
  - docs/product/philosophy.md
  - docs/architecture/system.md
  - docs/architecture/mcp.md
---

Crewhelm separates installation, administration, execution, and external effects so each boundary
can enforce its own policy and recovery rules.

## CLI bootstraps; MCP operates

The local CLI deploys, upgrades, diagnoses, and rehearses an installation. It is not the ongoing
Agent administration interface. After installation, an authorized MCP client creates and revises
Agents, starts Runs, manages Connections and automation, reviews approvals, and performs recovery.

## Agent revisions define how work happens

An Agent is a long-lived, owner-controlled actor. Its name, instructions, capability modules,
Skills, integration grants, and execution limits form an immutable Agent revision. A configuration
change creates a new revision instead of altering the historical definition used by existing work.

An Agent revision answers: **How should this work be performed?**

## Runs are bounded attempts

Each message starts one Run under a fixed policy and budget snapshot. Admission binds the owner,
Agent revision, fleet revision, prompt, optional Brief revisions, output contract, and limits.
Tool calls consume the Run's shared budget and cross a deterministic Tool gate before dispatch.

A direct Run can continue an owner-private conversation, but each message remains a separate
bounded Run.

## Workflows preserve a known sequence

A Workflow is appropriate when one outcome already has two to eight ordered stages and should
survive an MCP disconnect. Crewhelm freezes the objective, stages, Agent revision, Briefs,
aggregate budget, and retention before starting. Each stage is still admitted as a normal Run.

A Workflow coordinates; it does not grant authority, add stages, or interpret output as policy.
An explicitly deferrable stage can checkpoint while external work is pending. The checkpoint ends
the current Run; Crewhelm sleeps durably and later admits a fresh bounded Run for the same stage and
Workflow-owned Session. The Workflow's elapsed-time, deferral, and aggregate limits still apply.

## Schedules and Event Triggers start fresh work

A Schedule starts work from time. An Event Trigger starts work from a matching connected-app
event. Both freeze an exact Agent revision and instruction, and each occurrence starts a fresh
bounded Run. They are occurrence sources, not authority.

Use a Schedule for elapsed or wall-clock recurrence. Use an Event Trigger when a supported event
from one exact active Connection should start work.

## Briefs provide context; capabilities provide reach

Briefs are immutable owner-provided reference material attached to a particular Run or Workflow.
Skills and integration grants are configured on an Agent revision and change how the Agent works.
Brief content, Skill files, retrieved pages, and provider results remain untrusted data.

An Agent revision answers how. A Brief revision answers which context this work may read.

## Inspection supports decisions

Fleet status, compact lists, exact inspection, the owner inbox, approval reads, and unresolved
effect reads help an owner decide what to do next. They are projections for discovery and
recovery; they do not grant execution authority.

Continue with [authority and custody](/docs/concepts/authority-and-custody/) or choose a procedure
from the [documentation overview](/docs/).
