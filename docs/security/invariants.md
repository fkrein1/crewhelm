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

No prompt-level instruction is an acceptable substitute for one of these controls.
