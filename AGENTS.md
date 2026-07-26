# Crewhelm agent instructions

## Required workflow

Before making any change intended for commit, read and follow
`.agents/skills/crewhelm-development/SKILL.md` completely. For R2 or R3 work, also read its
`references/security-review.md`.

## Working agreement

- Keep one objective and one writer active at a time.
- Present a commit card before editing and a commit receipt after committing.
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

## Validation

- Run focused tests first, then `pnpm verify`.
- Run lint, typecheck, tests, and builds sequentially.
- Cap every Vitest run at `--maxWorkers=50%`; use one worker for shared-state suites.
- Inspect `git diff --check`, the full diff, and the staged diff before committing.
- Self-review every commit. Require independent review of objective fidelity and repository
  standards for R2 and R3 work, and a separate security review for R3.
- Stop when a required check is failing or flaky.

Routine changes do not require a new process document. Add an architecture decision record only
for a durable, hard-to-reverse choice.

## Commits and external actions

Use semantic commits:

```text
<type>: <summary>

<concise explanation>
```

Certify every commit with a Developer Certificate of Origin signoff using `git commit -s`.

Do not push, deploy, publish, reserve names, create external resources, or perform destructive
actions unless the user has explicitly authorized that operation.
