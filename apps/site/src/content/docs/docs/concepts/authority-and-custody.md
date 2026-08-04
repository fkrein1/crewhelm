---
title: Authority and custody
description: Understand where Crewhelm stores authority, credentials, policy, execution state, and owner content.
type: explanation
audience: owner
area: security
availability: available
sources:
  - docs/security/invariants.md
  - docs/security/threat-model.md
  - docs/architecture/system.md
  - CONTEXT.md
---

Crewhelm keeps authority in deterministic control-plane state and keeps credentials out of Agent
context. Models may propose an action, but they cannot grant permission, approve themselves,
change policy, or bypass enforcement.

## Who owns which facts

The Worker authenticates each MCP request and derives owner and client authority. Auth D1 stores
OAuth state, signing keys, refresh-token records, and revocation. One owner-local control plane
stores Agent and Connection lifecycle, grants, policy, Brief metadata, automation, Run admission,
approvals, effect recovery, and audit state.

Each Agent directory owns conversation discovery and retention. Each isolated Session owns its
transcript and active execution. Workflows coordinate opaque identifiers and ordered stage events
without receiving prompts or provider authority.

## Credential custody

Composio holds managed and custom provider credentials and refreshes supported OAuth credentials.
For custom setup, a short-lived Crewhelm browser session relays entered values directly from the
Worker to Composio; the owner control plane stores only digests, a frozen safe field plan, and the
resulting auth-config reference. Agents receive only opaque Connection identifiers and bounded use
through Crewhelm's adapter. Custom auth-config references are owner-held: readiness intersects the
owner's completed Crewhelm setup records with the bounded active configuration set in Composio.
An installation-level custom config is never adopted merely because it exists. For a bearer or
OAuth remote MCP Connection, Crewhelm encrypts
credentials at rest in the owner control plane and never places them in MCP arguments, Agent state,
model context, logs, audit results, or provider results.

The bootstrap CLI briefly holds deployment authority. Local installation metadata contains
non-secret coordinates, not deployed secret values.

## Authority is checked more than once

Tool visibility is not permission. Before a provider or native runtime tool runs, Crewhelm checks
the authenticated owner, access level, active Agent and fleet revisions, exact capability or
Connection, target, effect classification, approval, limits, budget, and a short-lived single-use
permit.

Changing fleet configuration, revising an Agent, disabling it, or revoking a Connection or grant
invalidates unconsumed authority.

## Data is not authority

Prompts, Briefs, Skill packages, web content, Event Trigger payloads, remote MCP metadata, tool
results, and model output are untrusted. Crewhelm validates and bounds them before use. Their text
cannot widen scope, approve a write, create a grant, or change a security decision.

## External effects require honest recovery

Cancellation and revocation block later work but cannot undo an effect already dispatched to a
provider. If dispatch occurred and the result is uncertain, Crewhelm records an unresolved effect
and blocks an equivalent mutation. The owner must verify the outcome in the provider's
authoritative UI or API before recording `applied` or `not_applied`.

If the outcome cannot be proven, do not reconcile and do not retry.

Read [owner responsibilities](/docs/security/owner-responsibilities/) before granting external or
autonomous authority.
