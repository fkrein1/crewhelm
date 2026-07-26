# Security review

Read this reference for R2 and R3 work.

## Non-negotiable rule

The model may propose an action. Deterministic policy decides whether it may execute.

## Review questions

- Which trust boundary, asset, data class, permission, side effect, or dependency changes?
- Can model-controlled or external data influence a URL, identity, tool, destination, scope,
  resource identifier, code path, or cost?
- Is authorization enforced again at execution rather than only during discovery?
- Are inputs, outputs, retries, loops, concurrency, network access, and cost bounded?
- Can secrets appear in results, errors, telemetry, audit records, URLs, or backups?
- Is each side effect idempotent, auditable, recoverable, and safe under partial failure?
- Does revocation or deletion cover the new data and capability?
- Does failure leave the system denied, bounded, and resumable?
- Does the change require a threat-model, decision-record, or runbook update?

## Required negative cases when relevant

- Missing, invalid, expired, revoked, wrong-owner, wrong-client, and wrong-audience credentials.
- Insufficient scope and cross-agent capability access.
- Prompt injection and hostile tool output.
- Private, reserved, encoded, redirected, or malformed URL access.
- Duplicate requests, concurrent execution, retry after timeout, and provider partial failure.
- Exhausted budget, unknown cost, excessive output, and runaway loops.
- Secret-like values through success, failure, logging, tracing, and audit paths.
- Delete and restore without silently reactivating credentials, schedules, or execution.

## R3 completion gate

Require an independent security review and rollback or recovery evidence. Update the threat model
when an update trigger applies. Add an accepted decision record only for a durable,
hard-to-reverse choice. Require explicit user approval before deployment or publication.
