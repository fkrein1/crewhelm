---
title: Owner responsibilities
description: Operate Crewhelm without widening authority, exposing credentials, or hiding uncertain external effects.
type: explanation
audience: owner
area: security
availability: available
sources:
  - docs/security/invariants.md
  - docs/security/threat-model.md
  - docs/architecture/system.md
  - README.md
---

Crewhelm enforces deterministic policy, but the owner still decides what to install, connect,
grant, approve, automate, retain, and delete. Safe operation depends on making those decisions from
exact current state.

## Protect owner and deployment authority

- Keep the configured GitHub owner account secure.
- Revoke MCP clients that no longer need access and choose the narrowest
  [access level](/docs/reference/access-levels/).
- Protect Cloudflare deployment access, the Composio project key, GitHub App secret, optional Brave
  key, and any process-scoped AI Gateway token.
- Do not commit secrets or place them in prompts, Briefs, Skills, tool arguments, URLs, or support
  reports.
- Treat `crewhelm.installation.json` as the authoritative target coordinate for that installation.

## Grant the minimum

- Start Agents without external grants, then add only demonstrated capabilities.
- Prefer approval-required tool authority. Grant standing authority only for an exact reviewed
  action, bounded target, useful expiry, and small limits.
- Remember that Schedules and Event Triggers create occurrences, not permission. Their Runs use the
  Agent revision's current frozen authority.
- Review a remote MCP server's entire frozen catalog before attachment.
- Use an AI Gateway daily limit when you require an installation-wide hard dollar ceiling.

Without a dedicated AI Gateway, Run and loop limits remain enforced but there is no hard dollar
ceiling across the installation.

## Treat content as untrusted

Prompts, provider payloads, web pages, Briefs, Skill files, remote MCP metadata, tool output, and
model results may be incorrect or malicious. Do not accept text that claims to grant permission,
approve an effect, reveal a credential, or override Crewhelm policy.

Review typed output as data even after schema validation. Schema validity does not prove factual
correctness.

## Review autonomous work

- Keep Agent instructions and grants narrow enough that each scheduled or event-driven Run has a
  predictable responsibility.
- Inspect pending approvals and the owner inbox.
- Pause stale or noisy automation rather than broadening limits to make errors disappear.
- Keep the provider Connection active only while Crewhelm should use it.
- Verify retained Workflows, Runs, Briefs, and deliverables match your data-retention intent.

## Respond honestly to uncertain effects

Cancellation, Agent disablement, and Connection revocation stop later authority. They do not undo
an effect already dispatched. If Crewhelm records an unknown provider outcome:

1. Stop equivalent writes.
2. Verify the outcome in the provider's authoritative UI or API.
3. Reconcile only the fact you can prove.
4. Leave the effect unresolved and contact an operator if proof is unavailable.

Never use Agent prose, a browser redirect, or a timeout alone as proof that a provider write did or
did not happen.

## Maintain recoverability

- Retry only the exact same facade request; preserve an explicit `requestKey` when one was supplied.
- Reread current revisions after a conflict instead of forcing stale state.
- Repeat `crewhelm up` for supported upgrades and interrupted installation recovery.
- Preserve ambiguous resources and receipts for inspection; do not delete by guessed name.
- Treat failed temporary-token revocation verification as a failed diagnosis.

Continue with [authority and custody](/docs/concepts/authority-and-custody/) or the
[recovery guide](/docs/guides/diagnose-and-recover/).
