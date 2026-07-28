---
name: crewhelm-development
description: Deliver Crewhelm repository changes as small, secure, validated commits. Use for any Crewhelm implementation, bug fix, refactor, dependency update, configuration change, migration, security change, or documentation change intended for commit.
---

# Crewhelm Development

Ship one observable pull-request objective as a complete, green slice.

## Frame

1. Classify by the highest affected risk:
   - **R0**: documentation or process wording with no executable behavior.
   - **R1**: isolated stateless logic or tooling.
   - **R2**: public contracts, ordinary persistence, schedules, provider adapters, or exact-pinned
     dependencies or lockfiles without privileged lifecycle behavior.
   - **R3**: authority, secrets, external effects, state ownership, migrations, sandboxing, remote
     execution, deployment, CI/release permissions, or privileged dependencies.
2. Read only relevant guidance:
   - Bug or performance regression: `references/bug-diagnosis.md`.
   - R2/R3: `references/security-review.md`.
   - New capability: `docs/product/philosophy.md`.
   - Authority or execution: `docs/security/invariants.md`.
   - State, trust, dependency, or contract boundary: `docs/architecture/system.md`.
   - Module interface or refactor: `docs/engineering/module-design.md` and
     `docs/engineering/code-philosophy.md`.
3. State:

```text
Objective:
Risk:
Acceptance:
Proposed commit:
```

Pause for an unsettled architecture decision, a new trust boundary, or missing authority. Split
unrelated outcomes.

## Implement

- Map acceptance to observable tests or deterministic checks, including relevant unauthorized,
  retry, partial-failure, and recovery paths.
- Prefer deep modules with small interfaces. Keep policy, transactions, and failure handling with
  the owning capability; avoid speculative seams.
- Review changed direct dependencies for purpose, exact version, license, install behavior, and
  runtime authority.
- Reduce scope when a capability exceeds its appetite; never defer correctness or security.

## Finish

1. Run focused checks.
2. For nontrivial code, apply `references/simplification-review.md` and repeat affected checks.
3. Run risk-specific integration, migration, recovery, packaging, or staging checks.
4. Once an R1-R3 pull-request diff settles, run `pnpm verify`. For R0, run formatting, relevant
   document/foundation tests, and diff checks unless executable configuration or automation changed.
5. Inspect `git diff --check`, the complete diff, and the staged diff.
6. Self-review every change. R3 requires one independent review of the settled diff; follow
   `references/security-review.md` for escalation. Repeat only checks invalidated by later changes.

Do not commit with a failing or flaky required check, unresolved high-impact finding, unreviewed
dependency, unproven migration recovery, or undemonstrated objective.
