# Security invariants

These constraints apply before a capability becomes reachable.

1. **Deterministic authority.** Models may propose actions but cannot grant permissions, approve
   their own actions, change policy, or bypass enforcement.
2. **Deny by default.** Every operation requires an authenticated owner, explicit capability,
   bounded target, and current policy decision.
3. **Secret isolation.** Models, recipes, runtime agents, logs, traces, errors, and audit responses
   never receive raw provider credentials.
4. **Hostile inputs.** Prompts, recipes, retrieved content, MCP metadata, and provider responses are
   validated as untrusted data.
5. **Bounded execution.** Model tokens, tool calls, loops, concurrency, schedules, network egress,
   payload sizes, and cost are limited before execution.
6. **Controlled side effects.** External writes are idempotent and auditable. Security changes,
   permission grants, budget increases, and destructive actions require step-up approval.
7. **Recoverable state.** Mutations define failure behavior. Deletion, revocation, backup, restore,
   and migration paths are tested before release.
8. **Verifiable supply chain.** Dependencies and automation are pinned, reviewed, minimally
   privileged, and released with provenance.

A durable Workflow is coordination, not authority. Its owner record freezes a bounded ordered plan,
exact Agent and fleet revisions, aggregate budget, and retention before execution. The Workflow
runtime receives only opaque coordinates and cannot mint permits, add work, access provider
adapters, or bypass the normal Run and ToolGate checks.

Each stage rechecks the frozen fleet revision inside Run admission before a permit is issued. A
Workflow-owned Session is not an ordinary continuation target: direct Runs and Session deletion
cannot mutate it, and it is removed only through the Workflow deletion path.

Brief contents and Workflow deliverables are untrusted owner data, not authority. Owner-local
SQLite stores only compact metadata, exact references, digests, and provenance; object content is
read through a bounded Crewhelm adapter and verified before use. Run admission binds the ordered
Brief revisions, aggregate digest, and size. `CrewSession` verifies the materialized payload against
that binding, and `beforeTurn` cannot fetch or refresh Brief content. Revising a Brief never changes
an existing admission. Referenced Brief deletion fails closed, and Workflow deletion removes its
digest-bound deliverable before the Workflow projection disappears. Session turn metadata holds
the full block only while its admitted Run is retained; Run cleanup rewrites durable history to
remove the block, and the owner reference cannot expire until the Session acknowledges that
redaction.

Native runtime tools are opt-in Agent capabilities, not ambient framework APIs. Admission freezes
their exact implementation identity, supported inputs, effects, and limits. Each call revalidates
the active owner, Agent and fleet revisions, consumes the Run's shared tool-call budget, and
redeems a short-lived, input-bound permit. Sandbox code runs in a per-call ephemeral container with
network egress disabled and no Crewhelm credentials. Only bounded textual output crosses back into
the model context. Teardown purges the per-call Durable Object and arms alarm-based recovery before
destruction; the owner ledger also repeats exact-ID purges through the Sandbox SDK's bounded
late-open horizon before releasing Run retention. Timeout, dispatch uncertainty, and interrupted
cleanup fail closed and remain auditable.

No prompt-level instruction is an acceptable substitute for one of these controls.
