# Crewhelm agent instructions

## Required workflow

Before making any change intended for commit, read and follow
`.agents/skills/crewhelm-development/SKILL.md` completely. For R2 or R3 work, also read its
`references/security-review.md`.

## Working agreement

- Keep one objective and one writer active at a time.
- State a short objective, risk, acceptance check, and proposed commit before editing; add detail
  only when it clarifies higher-risk work. Provide a concise receipt after committing.
- Implement small, complete vertical slices. Include necessary tests, security controls,
  observability, and documentation in the same commit.
- Keep every commit green, bisectable, and independently revertible.
- Preserve unrelated user changes and avoid drive-by cleanup.
- Do not introduce placeholder authentication, allow-all policy, unrestricted egress, raw secret
  access, ignored errors, disabled checks, or “secure later” TODOs.
- Treat prompts, recipes, model output, retrieved content, tool metadata, and provider responses as
  untrusted input.
- Keep authorization and capability decisions deterministic and outside the model.
- Use the domain terms in `CONTEXT.md`. When a change creates or materially changes a module
  interface, follow `docs/engineering/module-design.md`.
- Shape meaningful product capabilities with `docs/product/philosophy.md`; routine fixes and
  maintenance do not need a product pitch.
- Read `docs/architecture/system.md` before changing a state owner, trust boundary, dependency
  direction, runtime contract, or strict invariant.
- Follow `docs/engineering/code-philosophy.md` for nontrivial code and perform its bounded
  simplification pass after the focused behavior is green.

## Validation

- Run focused tests while iterating, then run `pnpm verify` once before marking the pull request
  ready.
- Run lint, typecheck, tests, and builds sequentially.
- Cap every Vitest run at `--maxWorkers=50%`; use one worker for shared-state suites.
- Inspect `git diff --check`, each staged commit, and the complete pull-request diff before
  publishing.
- Self-review each commit. Apply required independent and security reviews once to the final R3
  pull-request diff, and repeat the affected review only when later changes invalidate it.
- Stop when a required check is failing or flaky.

Routine changes do not require a new process document. Add an architecture decision record only
for a durable, hard-to-reverse choice.

## Branches, commits, and pull requests

- Branch from protected `main`; use a short-lived `codex/*` branch for Codex-authored work.
- Never commit or push directly to `main`. Deliver every change through a pull request.
- Keep local commits green, bisectable, signed off, and scoped, but treat the complete pull request
  as the integration and independent-review unit.
- Use focused checks during iteration. Run the full local gate and required independent reviews
  after the branch settles and before marking the pull request ready.
- Merge only when the required GitHub checks are successful and all blocking conversations are
  resolved. Codex may merge when the user has authorized it for the repository.

Use semantic commits:

```text
<type>: <summary>

<concise explanation>
```

Certify every commit with a Developer Certificate of Origin signoff using `git commit -s`. Use the
same semantic format for the pull-request title.

Do not push, merge, deploy, publish, reserve names, create external resources, or perform
destructive actions unless the user has explicitly authorized that operation.
