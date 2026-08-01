---
name: crewhelm-delivery
description: Deliver Crewhelm repository changes as small, secure, reviewed pull-request slices. Use for any Crewhelm implementation, bug fix, refactor, dependency update, configuration change, migration, security change, or documentation change intended for commit or pull request.
---

# Crewhelm delivery

Ship one observable pull-request objective as a complete, green slice.

## Frame

1. Classify the change:
   - **Docs**: prose only, with no executable behavior.
   - **Code**: ordinary executable behavior.
   - **Sensitive**: authority, secrets, external effects, persistence recovery, sandboxing, remote
     execution, deployment, CI/release permissions, or privileged dependencies.
2. Read only relevant guidance:
   - New capability: `docs/product/philosophy.md`.
   - Authority or execution: `docs/security/invariants.md`.
   - State, trust, dependency, or contract boundary: `docs/architecture/system.md`.
   - Module interface or refactor: `docs/engineering/design.md`.
3. State the objective, category, acceptance evidence, and proposed commit. Pause for an unsettled
   architecture decision, a new trust boundary, or missing authority. Split unrelated outcomes.

```text
Objective:
Category:
Acceptance:
Proposed commit:
```

## Implement

- Map acceptance to observable tests or deterministic checks, including relevant unauthorized,
  retry, partial-failure, and recovery paths.
- Prefer deep modules with small interfaces. Keep policy, transactions, and failure handling with
  the owning capability; avoid speculative seams.
- Review changed direct dependencies for purpose, exact version, license, install behavior, and
  runtime authority.
- Document what matters beyond the code, omit change history, and make every word carry its weight.
- Do not disable checks. The sole `skipLibCheck` exception is defined in
  `references/declaration-check-exception.md`.
- Reduce scope when a capability exceeds its appetite; never defer correctness or security.

For bugs and regressions, first reproduce the exact symptom with a fast, deterministic check. For
non-obvious failures, test specific falsifiable hypotheses. Turn the minimized reproduction into a
failing regression test, verify it passes after the fix, and rerun the original scenario. Remove
temporary instrumentation before finishing.

For sensitive changes, cover relevant abuse and failure paths:

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
2. For nontrivial code, apply the simplification pass in `docs/engineering/design.md`, then repeat
   affected checks.
3. Run risk-specific integration, migration, recovery, packaging, or staging checks.
4. Once a code or sensitive diff settles, run `pnpm verify`. For docs, run formatting, relevant
   document or foundation tests, and diff checks unless executable configuration or automation
   changed.
5. Inspect `git diff --check`, the complete diff, and the staged diff. Self-review every change.
6. Before pull-request creation, use one independent reviewer for the settled diff. Provide the
   objective, category, and validation already completed. Ask for a holistic review covering
   simplicity, correctness, security risks introduced or affected by the change, and unintended
   compatibility breaks. The reviewer must not delegate or repeat successful checks unless
   investigating a specific finding or missing evidence. Address blocking findings and repeat only
   checks invalidated by later changes.
7. For changed public MCP or CLI behavior, explicitly account for live evidence before calling the
   slice complete. When test-installation deployment is authorized, read and use
   `../crewhelm-live-validation/SKILL.md`; otherwise state that live validation remains pending.
   Never describe deterministic or local rehearsal coverage as live validation.

Do not commit with a failing or flaky required check, unresolved high-impact finding, unreviewed
dependency, unproven migration recovery, or undemonstrated objective.

Follow the branch, commit, pull-request, and authority rules in `AGENTS.md`.
