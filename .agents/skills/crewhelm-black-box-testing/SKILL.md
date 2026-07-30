---
name: crewhelm-black-box-testing
description: Run an optional live Crewhelm rehearsal through public OAuth and MCP when the user explicitly asks for black-box, remote E2E, smoke, or release-confidence testing. Do not use for routine implementation or deterministic CI.
---

# Crewhelm black-box testing

Prove a requested feature against a dedicated test installation using the same public surfaces a
client uses. This supplements deterministic tests; it never replaces them.

## Guardrails

- Treat the rehearsal as sensitive. State the target installation, exact scenario, mutations,
  cleanup, and acceptance evidence before running it.
- Use a dedicated test installation unless the user explicitly authorizes production.
- Build the exact branch. Deploy only with explicit authorization; otherwise require the target to
  report the expected stable packaged-build fingerprint.
- Load secrets only through the repository's ignored environment file. Never print values, OAuth
  codes, signed URLs, tokens, or provider payloads.
- Prefer the available embedded app browser. Automate OAuth only after the user approves the exact
  deployment, account, client, and scopes; ambient sign-in is not consent. Pause for authority
  changes. Use temporary owner access and require verified token revocation.
- Exercise public OAuth and MCP only. Do not substitute direct Durable Object, D1, R2, or provider
  writes for black-box behavior.
- Keep fixtures unique, bounded, and disposable. Record retained immutable evidence when the
  product intentionally has no delete operation.

## Rehearsal

1. Run the relevant deterministic checks and build.
2. Establish the stable fingerprint through an authorized deploy or the existing target.
3. Capture a read-only baseline, including affected capacity and unresolved recovery state.
4. Exercise the feature's happy path through MCP.
5. Exercise idempotent replay, one meaningful denial or boundary, and the documented recovery path.
6. Read the exact resulting resource and verify compact discovery does not leak detailed content.
7. Clean up through public product operations and compare the final state with the baseline.
8. Verify temporary access revocation.

If the rehearsal exposes a product defect, stop the scenario. Reproduce it, fix it with
`crewhelm-development`, verify and redeploy the exact branch, then restart the rehearsal.

## Evidence

Report the endpoint, fingerprint, checks performed, resource IDs, before/after counts, terminal
state, cleanup or retained evidence, and token revocation. Separate product failures from harness or
browser failures.

Document only durable behavior or operational decisions that are not quickly inferable from code.
Describe the current system concisely; omit change history. Each word should carry its weight.
