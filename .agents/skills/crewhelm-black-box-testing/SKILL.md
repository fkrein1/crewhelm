---
name: crewhelm-black-box-testing
description: Run an optional live Crewhelm rehearsal through public OAuth and MCP when the user explicitly asks for black-box, remote E2E, smoke, or release-confidence testing. Do not use for routine implementation or deterministic CI.
---

# Crewhelm black-box testing

Prove a requested feature against a dedicated test installation using the same public surfaces a
client uses. This supplements deterministic tests; it never replaces them.

## Standard target

Repository rehearsals use `crewhelm.testing.installation.json`. The explicit request to run this
skill authorizes `crewhelm up` against that dedicated installation so the deployed Worker matches
the current packaged build. It does not authorize production.

Before any OAuth, MCP, or mutating call:

1. Run the relevant deterministic checks and `pnpm build`.
2. Run:

   ```sh
   node apps/cli/dist/crewhelm.js up \
     --installation crewhelm.testing.installation.json \
     --json
   ```

3. Verify the report names `crewhelm-testing`, reports
   `https://crewhelm-testing.fkrein.workers.dev`, passes public diagnosis, and is aligned to the
   packaged fingerprint. Build logs are not target evidence.
4. Pass `--installation crewhelm.testing.installation.json` to every installation-backed CLI
   command. Do not retype the endpoint. If a command also receives `--endpoint`, the CLI must reject
   any mismatch before network access.
5. Never use an ambient MCP connector unless its exact origin is visible and equals the installation
   metadata. A generic connector name, cached schema, or familiar account is not origin proof.

## Guardrails

- Treat the rehearsal as sensitive. State the target installation, exact scenario, mutations,
  cleanup, and acceptance evidence before running it.
- Use the standard dedicated test installation unless the user explicitly authorizes another
  target. Production requires separate explicit authorization.
- Load secrets only through the repository's ignored environment file. Never print values, OAuth
  codes, signed URLs, tokens, or provider payloads.
- Use `--browser codex` for installation-backed CLI authorization. Custom harnesses write the
  short-lived HTTPS authorization target to a unique mode-0600 temporary file, open it in a new
  in-app tab, and delete the file immediately. Never print the target or use the system browser.
- On authorization pages, inspect only scoped visible text and controls. Do not capture a full DOM
  snapshot containing signed links.
- Automate OAuth only after the user approves the exact deployment, account, client, and scopes;
  ambient sign-in is not consent. Pause for authority changes. Use temporary owner access and
  require verified token revocation.
- Exercise public OAuth and MCP only. Do not substitute direct Durable Object, D1, R2, or provider
  writes for black-box behavior.
- Keep fixtures unique, bounded, and disposable. Record retained immutable evidence when the
  product intentionally has no delete operation.
- Run one live session per installation. Do not start a rescue or parallel session while another
  session is polling. Keep request, time, fleet-capacity, and token-lifetime headroom reserved for
  cleanup and revocation.

## Rehearsal

1. Complete the standard-target preflight and capture the stable fingerprint.
2. Capture a read-only baseline, including affected capacity and unresolved recovery state.
3. Exercise the feature's happy path through public CLI, OAuth, and MCP.
4. Exercise idempotent replay, one meaningful denial or boundary, and the documented recovery path.
5. Read the exact resulting resource and verify compact discovery does not leak detailed content.
6. Clean up through public product operations and compare the final state with the baseline.
7. Verify temporary access revocation.

If the rehearsal exposes a product defect, stop the scenario. Reproduce it, fix it with
`crewhelm-development`, verify and redeploy the exact branch, then restart the rehearsal.

For a light rehearsal, stop after preflight, public diagnosis, and at most one bounded journey.
Create no provider effect unless the requested scenario requires it. Target five minutes while
preserving the same origin, cleanup, and revocation requirements.

## Evidence

Report the endpoint, fingerprint, checks performed, resource IDs, before/after counts, terminal
state, cleanup or retained evidence, and token revocation. Separate product failures from harness or
browser failures.

Document only durable behavior or operational decisions that are not quickly inferable from code.
Describe the current system concisely; omit change history. Each word should carry its weight.
