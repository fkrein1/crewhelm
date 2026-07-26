# 0001: Controlled development loop

Status: accepted

## Context

Crewhelm will administer long-lived agents, credentials, tools, schedules, and external side
effects. Large generated changes would be difficult to audit and would encourage security controls
to arrive after functionality.

## Decision

Develop Crewhelm through one green, observable objective per commit. Define acceptance and abuse
cases before editing, design evidence before implementation, and validate sequentially.

Use one writer and self-review every commit. Require one independent combined review for R3 work.
Add a separate security reviewer only when a change directly alters a trust boundary, authority,
secrets, external mutations, sandboxing, destructive behavior, migrations, or deployment and
release authority. Use additional agents for bounded research and read-only review when their value
justifies the coordination. Keep routine evidence in commit receipts and CI rather than adding a
process document for every change.

## Consequences

- Each commit remains reviewable, bisectable, and revertible.
- Security controls land with the capability they protect.
- Some objectives take longer before producing a commit because validation and review are part of
  the objective.
- Hard-to-reverse decisions require a separate decision record.
