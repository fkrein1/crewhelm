# Contributing to Crewhelm

Crewhelm favors small, complete changes over large generated patches.

Before writing code, state one observable objective, its acceptance criteria, important failure
cases, and the validation that will prove it. Use the [product philosophy](docs/product/philosophy.md)
for new capabilities, the [system architecture](docs/architecture/system.md) for ownership
boundaries, the [engineering design](docs/engineering/design.md) for interfaces, and the
[security invariants](docs/security/invariants.md) for authority or execution.

Keep production code, relevant tests, security controls, and necessary documentation together. Do
not submit intentionally insecure placeholders or defer correctness to a follow-up.

Create a short-lived branch from `main` and submit every change through a pull request. Direct
pushes to `main` are blocked. Use focused checks while iterating and run the local gate once after
an executable change settles:

```sh
pnpm verify
```

For prose-only changes, formatting, relevant document or foundation tests, and diff checks are
sufficient. Keep successful output compact and expand logs when diagnosing a failure.

For an `OwnerControlPlane` schema change, edit
`apps/worker/src/owner/schema.ts`, then run:

```sh
pnpm --filter @crewhelm/worker db:control-plane:generate
```

The command runs Drizzle Kit and rebuilds the Worker migration manifest. Commit and review the
generated SQL, snapshot, journal, and manifest together. Never edit generated migration SQL or a
previously committed migration; fix the schema or add a new migration instead.

Use semantic commit and pull-request titles such as `feat: add connection validation` or
`fix: reject expired approvals`. Keep commits green and independently reviewable. Sign off every
commit; the pull request's `DCO` check enforces this.

GitHub requires `Verify`, `Dependency review`, `Analyze JavaScript and TypeScript`, and `DCO` on
each pull request. `Verify` and CodeQL run again on the resulting `main` commit for monitoring;
dependency review runs only on pull requests because it compares the proposed dependency graph
with the base branch. Merge only after the required checks pass and blocking conversations are
resolved.

Sensitive changes should include relevant negative tests and update the threat model when they
alter a trust boundary. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

By contributing, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) for your contribution
using a signed-off commit (`git commit -s`).
