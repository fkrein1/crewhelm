# Code philosophy

Crewhelm code should make important behavior easy to find, hard to misuse, and cheap to change.
Simplicity means fewer concepts and surprises, not fewer lines.

Priority order:

1. Correctness and security
2. Clarity
3. Locality and changeability
4. Consistency
5. Brevity

## Simple, complete design

- Solve demonstrated behavior; do not build frameworks for imagined variants.
- Prefer deep modules with small interfaces. Hide orchestration, safe defaults, normalization, and
  failure handling.
- Put seams at changes in ownership, trust, persistence, or external dependency.
- Keep data flow, policy decisions, state transitions, and failure explicit.
- Use precise domain names; avoid vague `Manager`, `Service`, `Helper`, and `Utils` containers.
- Keep behavior together when it shares an invariant and split it when it has a different owner or
  reason to change.
- Add abstractions for real hidden complexity or demonstrated variation, not one caller and one
  implementation.
- Test observable contracts, state transitions, and negative policy behavior—not private steps.

Challenge pass-through wrappers, speculative factories, boolean-heavy APIs, deep nesting, generic
utility buckets, provider details in domain contracts, duplicated policy, and hidden fallbacks.
Deletion of a valuable module should force its hidden complexity into callers; otherwise it is too
shallow.

## Simplify after behavior works

For nontrivial code, first make focused behavior tests green. Then:

1. Freeze observable behavior, public contracts, and invariants.
2. Review changed code and immediate callers only.
3. Ask: **Given what this implementation taught us, would a clean implementation use a materially
   simpler design?**
4. Remove accidental concepts, nesting, indirection, duplication, weak names, and scattered logic.
5. Re-run focused tests and `pnpm verify`.

Clarity outranks compactness. Do not expand scope or replace understood code with a fashionable
pattern.

Never simplify away authentication, execution-time authorization, validation, redaction, audit,
idempotency, approval, budgets, bounded execution, partial-failure behavior, recovery,
observability, or an ownership/trust boundary. Improve the interface while preserving the control.

## Influences

- [Crewhelm module design](module-design.md)
- Anthropic's Apache-2.0
  [code-simplifier](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md)
- [DHH: How to recover from microservices](https://world.hey.com/dhh/how-to-recover-from-microservices-ce3803cc)

This is original Crewhelm guidance, not a copy of Anthropic's prompt or an endorsement.
