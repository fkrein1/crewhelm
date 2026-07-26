---
name: crewhelm-development
description: Deliver Crewhelm repository changes as small, secure, validated commits. Use for any Crewhelm implementation, bug fix, refactor, dependency update, configuration change, migration, security change, or documentation change intended for commit.
---

# Crewhelm Development

Complete one observable objective at a time. Keep the branch green and include the tests,
security controls, and documentation required to make that objective complete.

## Prepare the objective

1. Read `AGENTS.md`, `CONTEXT.md`, `docs/security/invariants.md`, and any relevant decision
   record.
2. Inspect the worktree and preserve unrelated changes.
3. Classify the work:
   - **R0**: documentation or isolated tooling.
   - **R1**: pure internal logic without persistence or external effects.
   - **R2**: persistence, schedules, provider adapters, or public contracts.
   - **R3**: authentication, authorization, secrets, MCP mutations, migrations, sandboxing,
     remote execution, deployment, destructive behavior, dependencies or lockfiles,
     package-manager or lifecycle policy, CI or release automation, and repository instructions
     that govern agents.
4. Load only the guidance this objective needs:
   - For a bug or performance regression, read `references/bug-diagnosis.md`.
   - For R2 or R3 work, read `references/security-review.md`.
   - When creating or materially changing a module interface, read
     `docs/engineering/module-design.md`.
5. Present a commit card before editing:

```text
Objective:
Why:
Non-goals:
Risk:
Invariants:
Acceptance:
Abuse and failure cases:
Validation:
Proposed commit:
```

Split the work when the objective combines unrelated outcomes. Pause when it requires an
unsettled architecture decision, a new trust boundary, or authority the user has not granted.

## Design the evidence

- Map every acceptance criterion to a test or deterministic check.
- Name the interface under test and verify observable behavior through it rather than through
  implementation details.
- Exercise the successful path and relevant invalid, unauthorized, failure, retry, and recovery
  paths.
- Work in vertical red-green slices when behavior is being added or fixed: one failing test, the
  smallest implementation that passes it, then the next slice. Never commit a red state.
- Use import, configuration, schema, or build checks for scaffolding where a behavioral unit test
  would be artificial.

## Implement the complete slice

- Keep one writer and one active objective.
- Make the smallest complete change, not a temporarily insecure change.
- Prefer deep modules with small, explicit interfaces. Keep orchestration and failure handling
  local; avoid pass-through layers and speculative seams.
- Keep authorization and policy enforcement outside model-controlled text.
- Avoid drive-by cleanup, speculative abstractions, hidden fallbacks, broad permissions,
  swallowed errors, unexplained `any`, disabled checks, and security TODOs.
- Stop and create a separate objective when an unrelated prerequisite appears.
- Add dependencies only with explicit rationale, exact versions, license review, and supply-chain
  review.

## Validate

Run validation workloads sequentially:

1. Run focused tests for the changed behavior.
2. Run `pnpm verify`.
3. Run any risk-specific integration, migration, recovery, packaging, or staging checks.
4. Inspect `git diff --check`, the complete diff, and the staged diff.
5. Confirm no secret, generated junk, unrelated formatting, or accidental public API change is
   present.

Every Vitest invocation must use a maximum of 50% workers. Use one worker for shared-state or
serial end-to-end suites.

## Review

Self-review every commit on two axes:

1. **Objective**: fidelity to acceptance criteria, test sensitivity, scope, and failure behavior.
2. **Standards**: repository instructions, module design, compatibility, and operations.

For R2 and R3 work, give a read-only reviewer the objective, invariants, diff, and validation
evidence and require the same two-axis report. For R3 work, require a separate security-focused
review.

Resolve every blocker and repeat affected validations. Do not let a reviewer approve its own fix.

## Commit and report

Stage explicit files and create one signed-off semantic commit with `git commit -s`:

```text
<type>: <summary>

<concise explanation of why and how>
```

Use `feat`, `fix`, `refactor`, `test`, `docs`, or `chore` as appropriate. Do not silently amend a
commit after reporting it complete.

Report a receipt containing the short hash, objective, acceptance result, exact validation
commands, review result, residual risk, and next objective. Do not push, deploy, publish, or mutate
external resources without explicit authorization.

## Stop the line

Do not commit when any required check is failing or flaky, a high-impact finding is unresolved,
the change widens scope unexpectedly, a migration lacks recovery evidence, a dependency is
unreviewed, or the objective cannot be demonstrated.
