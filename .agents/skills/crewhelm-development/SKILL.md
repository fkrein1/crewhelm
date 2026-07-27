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
3. Classify the work. Risk is determined by behavior, not file type:
   - **R0**: documentation, tests, or process wording with no executable product behavior.
   - **R1**: stateless internal logic or isolated tooling without persistence, authority, or
     external effects.
   - **R2**: public contracts, ordinary persistence, schedules, provider adapters, or ordinary
     exact-pinned dependencies or lockfiles that add no privileged lifecycle behavior.
   - **R3**: authentication, authorization, secrets, MCP or external mutations, state ownership,
     migrations, sandboxing, remote execution, deployment, destructive behavior, privileged
     package-manager or lifecycle policy, CI or release permissions, or dependencies with install
     scripts, native code, or runtime authority.
4. Load only the guidance this objective needs:
   - For a bug or performance regression, read `references/bug-diagnosis.md`.
   - For R2 or R3 work, read `references/security-review.md`.
   - For a meaningful product capability, read `docs/product/philosophy.md`.
   - When changing state ownership, a trust boundary, dependency direction, a runtime contract,
     or a strict invariant, read `docs/architecture/system.md` and the relevant decision records.
   - When creating or materially changing a module interface, read
     `docs/engineering/module-design.md`.
   - For nontrivial code or a refactor, read `docs/engineering/code-philosophy.md`.
5. Before the first edit, state one short objective card for the pull request with the objective,
   risk, acceptance evidence, and proposed first commit. Update it only when the objective, risk,
   or intended commit boundary materially changes. Add why, non-goals, invariants, abuse cases, and
   detailed validation only when they materially clarify R2 or R3 work.

```text
Objective:
Risk:
Acceptance:
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
  swallowed errors, unexplained `any`, disabled checks outside the evidence-gated leaf-package
  declaration exception defined in `AGENTS.md`, and security TODOs.
- Stop and create a separate objective when an unrelated prerequisite appears.
- Review each new or updated direct dependency for rationale, exact version, license, and relevant
  supply-chain risk. Let automated audit and license gates cover the unchanged transitive graph.
  Trace transitive packages manually only when a gate flags them or they add native code,
  lifecycle scripts, unclear licensing, or sensitive runtime authority.
- If a capability grows materially beyond its shaped appetite, counteroffer with a smaller,
  coherent outcome instead of silently widening the bet.

## Validate

Run validation workloads sequentially:

1. Run focused tests for the changed behavior.
2. For nontrivial code, read `references/simplification-review.md`, perform the bounded review, and
   re-run focused tests after any change.
3. Once the branch is settled, run `pnpm verify` once before marking the pull request ready.
4. Run any risk-specific integration, migration, recovery, packaging, or staging checks.
5. Inspect `git diff --check`, the complete diff, and the staged diff.
6. Confirm no secret, generated junk, unrelated formatting, or accidental public API change is
   present.

After a fix, re-run the affected focused check. Re-run `pnpm verify` only when code or configuration
changed after the last full gate.

Every Vitest invocation must use a maximum of 50% workers. Use one worker for shared-state or
serial end-to-end suites.

## Review

Self-review every commit on two axes:

1. **Objective**: fidelity to acceptance criteria, test sensitivity, scope, and failure behavior.
2. **Standards**: repository instructions, module design, compatibility, and operations.

R0 through R2 require self-review; request independent review when uncertainty or impact warrants
it. For R3, require one independent review of the settled pull-request diff covering objective,
standards, and the relevant security questions. Require a second, security-focused reviewer only
when the change directly alters a trust boundary, authentication, authorization, secret handling,
MCP or external mutations, sandboxing, remote execution, destructive behavior, migration recovery,
or deployment and release authority.

Resolve every blocker and repeat affected validations. Do not let a reviewer approve its own fix.

## Commit, publish, and report

Work on a short-lived branch, never directly on `main`. Stage explicit files and create signed-off
semantic commits with `git commit -s`:

```text
<type>: <summary>

<concise explanation of why and how>
```

Use `feat`, `fix`, `refactor`, `test`, `docs`, or `chore` as appropriate. Keep each commit green,
bisectable, and independently revertible, but do not repeat the full gate or independent review
after every intermediate commit when the pull-request objective is still in progress.

When pushing is authorized, publish the feature branch and open a pull request with the same
semantic title. Mark it ready only after the full local gate and required review are complete.
Merge only when required GitHub checks pass and blocking conversations are resolved.

Report a receipt containing the commit hashes, pull-request URL and state, objective, acceptance
result, exact validation commands, review result, residual risk, and next objective. Do not push,
merge, deploy, publish, or mutate external resources without explicit authorization.

## Stop the line

Do not commit when any required check is failing or flaky, a high-impact finding is unresolved,
the change widens scope unexpectedly, a migration lacks recovery evidence, a dependency is
unreviewed, or the objective cannot be demonstrated.
