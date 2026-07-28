---
name: crewhelm-development
description: Deliver Crewhelm repository changes as small, secure, validated commits. Use for any Crewhelm implementation, bug fix, refactor, dependency update, configuration change, migration, security change, or documentation change intended for commit.
---

# Crewhelm Development

Deliver one observable pull-request objective as a complete, green vertical slice.

## Prepare the objective

1. Read `AGENTS.md`, inspect the worktree, and preserve unrelated changes.
2. Classify risk by behavior:
   - **R0**: documentation, tests, or process wording with no executable product behavior.
   - **R1**: stateless internal logic or isolated tooling without persistence, authority, or
     external effects.
   - **R2**: public contracts, ordinary persistence, schedules, provider adapters, or ordinary
     exact-pinned dependencies or lockfiles that add no privileged lifecycle behavior.
   - **R3**: authentication, authorization, secrets, MCP or external mutations, state ownership,
     migrations, sandboxing, remote execution, deployment, destructive behavior, privileged
     package-manager or lifecycle policy, CI or release permissions, or dependencies with install
     scripts, native code, or runtime authority.
3. Load only applicable guidance:
   - For a bug or performance regression, read `references/bug-diagnosis.md`.
   - For R2 or R3 work, read `references/security-review.md`.
   - For a new product capability, read `docs/product/philosophy.md`.
   - When changing authority or execution, read `docs/security/invariants.md`.
   - When changing state ownership, a trust boundary, dependency direction, a runtime contract,
     or a strict invariant, read `docs/architecture/system.md` and the relevant decision records.
   - When materially changing a module interface, read `docs/engineering/module-design.md`.
   - For nontrivial code or a refactor, read `docs/engineering/code-philosophy.md`.
4. Before editing, state:

```text
Objective:
Risk:
Acceptance:
Proposed commit:
```

Add detail only when it clarifies R2 or R3 work. Split unrelated outcomes; pause for an unsettled
architecture decision, a new trust boundary, or missing authority.

## Build the slice

- Map acceptance criteria to observable tests or deterministic checks. Cover relevant invalid,
  unauthorized, retry, partial-failure, and recovery paths.
- Prefer deep modules with small interfaces. Keep orchestration and failure handling local; avoid
  speculative seams.
- Review new or changed direct dependencies for purpose, exact version, license, install behavior,
  and runtime authority. Investigate transitives only when a gate or privileged behavior warrants
  it.
- If a product capability exceeds its appetite, reduce scope without weakening correctness or
  security.

## Validate

1. Run focused tests for the changed behavior.
2. For nontrivial code, read `references/simplification-review.md`, perform the bounded review, and
   re-run focused tests after any change.
3. Once an R1 through R3 branch is settled, run `pnpm verify` once before marking the pull request
   ready. For an R0 documentation-only change, run the formatter, relevant document or foundation
   tests, and diff checks; run the full gate if executable configuration, tests, generated
   artifacts, or shared automation changed.
4. Run any risk-specific integration, migration, recovery, packaging, or staging checks.
5. Inspect `git diff --check`, the complete diff, and the staged diff.

Treat the pull request as the integration unit: run the full gate and final review once after it
settles, repeating only checks invalidated by later changes.

## Review

- Self-review every change for objective fidelity, test sensitivity, scope, failure behavior,
  compatibility, and operations.
- R0 through R2 need independent review only when uncertainty or impact warrants it.
- R3 requires one independent review of the settled pull-request diff. Follow
  `references/security-review.md` for security-review escalation.
- Resolve blockers and repeat only invalidated checks or reviews.

## Stop the line

Do not commit with a failing or flaky required check, unresolved high-impact finding, unreviewed
dependency, unproven migration recovery, or undemonstrated objective.
