# Engineering design

Crewhelm code should make important behavior easy to find, hard to misuse, and cheap to change.
Correctness and security outrank clarity, locality, consistency, and brevity.

## Design rules

- Solve demonstrated behavior; do not build frameworks for imagined variants.
- Prefer deep modules with small interfaces. Keep orchestration, policy, transactions, safe
  defaults, retries, normalization, and failure handling with the owning capability.
- Put seams at real changes in ownership, trust, persistence, or external dependency.
- Keep data flow, authority decisions, state transitions, cost, and failure explicit.
- Use precise domain names and avoid pass-through layers or generic utility containers.
- Add abstractions for demonstrated variation or hidden complexity, not hypothetical flexibility.
- Test observable contracts, state transitions, and negative policy behavior rather than private
  steps.
- Render browser pages through the owning runtime's page module and shared assets; route handlers
  must not inline document shells.

A valuable module hides complexity that would otherwise spread into callers. If deleting it only
removes indirection, the module is too shallow.

For a new or materially changed public or cross-trust interface, name its owner, callers,
dependencies, authority, failure behavior, and observable tests. Compare alternatives only when
the interface is genuinely unsettled.

Cloudflare Workflows coordinate durable order; they do not become a second control plane. Keep
owner data and frozen plans in `OwnerControlPlane`, exact runtime routing in `CrewAgent`, and Think
execution in `CrewSession`. Each Workflow stage must be observable as an ordinary admitted Run so
existing revision, budget, approval, ToolGate, inbox, and recovery behavior stays controlling.

Keep typed output enforcement at the Session completion boundary. The owner freezes the schema and
reserves one optional tool-free repair attempt across the frozen inference route; the Session
validates canonical JSON and stores only bounded
validation evidence. Do not mix schema validation into tool execution, infer success from model
claims, or rerun a Run to repair its final formatting.

## Simplification

After behavior works, review changed code and immediate callers. Remove accidental concepts,
nesting, indirection, duplication, weak names, and scattered logic without changing contracts or
invariants.

Never simplify away authentication, execution-time authorization, validation, redaction, audit,
idempotency, approval, budgets, bounded execution, partial-failure behavior, recovery,
observability, or an ownership or trust boundary.
