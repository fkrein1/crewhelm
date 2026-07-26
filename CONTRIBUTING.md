# Contributing to Crewhelm

Crewhelm favors small, complete changes over large generated patches.

Before writing code:

1. State one observable objective and its non-goals.
2. List acceptance criteria and important abuse or failure cases.
3. Identify any security invariant or architecture decision affected.
4. Agree on the validation needed to prove the change.

Use the [product philosophy](docs/product/philosophy.md) to shape a meaningful new capability.
Routine fixes and maintenance do not need a product pitch.

Use the terms in [CONTEXT.md](CONTEXT.md). Design new or materially changed interfaces according to
[the module design standard](docs/engineering/module-design.md), follow the
[system architecture](docs/architecture/system.md) when changing ownership or dependency
boundaries, and apply the [code philosophy](docs/engineering/code-philosophy.md) to nontrivial
implementations. Test behavior through interfaces instead of coupling tests to internals.

Keep production code, relevant tests, security controls, and necessary documentation together. Do
not submit intentionally insecure placeholders or defer correctness to a follow-up.

Create a short-lived branch from `main` and submit every change through a pull request. Direct
pushes to `main` are blocked. Use focused checks while iterating, then run the local gate before
marking the pull request ready:

```sh
pnpm verify
```

Use semantic commit and pull-request titles such as `feat: add recipe validation` or
`fix: reject expired approvals`. Keep commits green and independently reviewable. Sign off every
commit; the pull request's `DCO` check enforces this.

GitHub requires `Verify`, `Dependency review`, `Analyze JavaScript and TypeScript`, and `DCO` on
each pull request. `Verify` and CodeQL run again on the resulting `main` commit for monitoring;
dependency review runs only on pull requests because it compares the proposed dependency graph
with the base branch. Merge only after the required checks pass and blocking conversations are
resolved.

Security-sensitive changes should include negative tests and update the threat model or a decision
record when they alter a trust boundary. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

By contributing, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) for your contribution
using a signed-off commit (`git commit -s`).
