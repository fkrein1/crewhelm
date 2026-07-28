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

For bugs and regressions, first reproduce the exact symptom with a fast, deterministic check. For
non-obvious failures, test specific falsifiable hypotheses. Turn the minimized reproduction into a
failing regression test, verify it passes after the fix, and rerun the original scenario. Remove
temporary instrumentation before finishing.

For R2/R3, cover relevant abuse and failure paths:

- Treat model, provider, tool, and retrieved data as untrusted. Validate any identity, URL,
  destination, scope, resource, action, or cost it influences.
- Keep authorization deterministic and enforce ownership, audience, scope, expiry, and revocation
  again at execution.
- Bound retries, concurrency, output, network access, and cost; handle duplicate, timed-out, and
  partially completed effects safely.
- Prevent secrets from entering results, errors, logs, traces, audit records, URLs, or backups.
- Fail denied and recoverably. Verify deletion, restoration, and migration do not reactivate
  authority or leave partial unsafe state.
- Update the threat model or operational guidance when trust boundaries, enforcement, recovery, or
  deployment authority changes.

## Finish

1. Run focused checks.
2. For nontrivial code, simplify changed code and immediate callers without changing behavior,
   contracts, security, recovery, observability, or ownership; then repeat affected checks.
3. Run risk-specific integration, migration, recovery, packaging, or staging checks.
4. Once an R1-R3 pull-request diff settles, run `pnpm verify`. For R0, run formatting, relevant
   document/foundation tests, and diff checks unless executable configuration or automation changed.
5. Inspect `git diff --check`, the complete diff, and the staged diff.
6. Self-review every change.
7. Before pull-request creation, use one independent reviewer for the settled diff. Provide the
   objective, risk context, and validation already completed. Ask for a holistic review covering
   simplicity, correctness, security risks introduced or affected by the change, and unintended
   compatibility breaks. The reviewer must not delegate or repeat successful checks unless
   investigating a specific finding or missing evidence. Address blocking findings and repeat only
   checks invalidated by later changes. Add a second security-focused reviewer when the change
   creates or changes authentication, authorization, secret lifecycle, sandboxing or remote
   execution, destructive behavior, migration recovery, deployment authority, or another trust or
   enforcement boundary.

Do not commit with a failing or flaky required check, unresolved high-impact finding, unreviewed
dependency, unproven migration recovery, or undemonstrated objective.
