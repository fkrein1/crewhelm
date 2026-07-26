# Contributing to Crewhelm

Crewhelm favors small, complete changes over large generated patches.

Before writing code:

1. State one observable objective and its non-goals.
2. List acceptance criteria and important abuse or failure cases.
3. Identify any security invariant or architecture decision affected.
4. Agree on the validation needed to prove the change.

Use the terms in [CONTEXT.md](CONTEXT.md). Design new or materially changed interfaces according to
[the module design standard](docs/engineering/module-design.md), and test behavior through those
interfaces instead of coupling tests to internals.

Keep production code, relevant tests, security controls, and necessary documentation together.
Do not submit intentionally insecure placeholders or defer correctness to a follow-up.

Run the local gate before opening a pull request:

```sh
pnpm verify
```

Use semantic commit and pull-request titles such as `feat: add recipe validation` or
`fix: reject expired approvals`. Keep commits green and independently reviewable.

Security-sensitive changes should include negative tests and update the threat model or a decision
record when they alter a trust boundary. Report vulnerabilities according to [SECURITY.md](SECURITY.md).

By contributing, you certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) for your contribution
using a signed-off commit (`git commit -s`).
