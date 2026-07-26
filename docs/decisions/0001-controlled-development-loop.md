# 0001: Controlled development loop

Status: accepted

## Context

Crewhelm will administer long-lived agents, credentials, tools, schedules, and external side
effects. Large generated changes would be difficult to audit and would encourage security controls
to arrive after functionality.

## Decision

Develop Crewhelm through one green, observable objective per commit. Define acceptance and abuse
cases before editing, design evidence before implementation, and validate sequentially.

Use one writer. Self-review every commit; require independent two-axis review for R2 and R3 work
and a separate security review for R3. Use additional agents for bounded research and read-only
review. Keep routine evidence in commit receipts and CI rather than adding a process document for
every change.

## Consequences

- Each commit remains reviewable, bisectable, and revertible.
- Security controls land with the capability they protect.
- Some objectives take longer before producing a commit because validation and review are part of
  the objective.
- Hard-to-reverse decisions require a separate decision record.
