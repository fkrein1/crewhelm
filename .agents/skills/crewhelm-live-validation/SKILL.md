---
name: crewhelm-live-validation
description: Validate Crewhelm behavior live through public CLI and MCP on the dedicated test installation. Use when the user asks for live validation, smoke testing or rehearsal testing, remote E2E, release confidence, or explicitly authorizes test deployment for live evidence required by crewhelm-delivery. Do not use for deterministic CI or production testing.
---

# Crewhelm live validation

Prove a requested feature against a dedicated test installation using the same public surfaces a
client uses. This supplements deterministic tests; it never replaces them.

## Standard target

Repository rehearsals use `crewhelm.testing.installation.json`. An explicit request to run this
skill authorizes `crewhelm up` against that dedicated installation so the deployed Worker matches
the packaged build. It also authorizes the repository rehearsal client to use saved, rotating Full
control owner access for bounded public MCP journeys on `crewhelm-testing`. No additional consent
pause is required for that exact installation, client type, and scenario. It does not authorize
production, another account, another installation, or broader scope.

Before any MCP or mutating call:

1. Run the relevant deterministic checks, `pnpm build`, and `pnpm release:check` in sequence. The
   rehearsal wrapper reads `apps/cli/dist/release.json`; do not start it from a build-only tree.
2. Run:

   ```sh
   node apps/cli/dist/crewhelm.js up \
     --installation crewhelm.testing.installation.json \
     --json
   ```

3. Verify the report names `crewhelm-testing`, reports
   `https://crewhelm-testing.fkrein.workers.dev`, passes public diagnosis, and is aligned to the
   packaged fingerprint. Build logs are not target evidence.
4. Pass `--installation crewhelm.testing.installation.json` to every installation-backed command.
   Do not retype the endpoint. A supplied endpoint must be rejected on any mismatch before network
   access.
5. Never use an ambient MCP connector unless its visible exact origin equals the installation
   metadata. A generic name, cached schema, or familiar account is not origin proof.

## Access lanes

Routine feature rehearsals use the saved credential through
`scripts/crewhelm-live-rehearsal.ts`; they do not repeat browser authorization. The credential is
origin-bound, ignored by Git, mode 0600, and rotated before every session. Tokens never appear in
output, and each 15-minute access token is revoked and verified before exit.

Run the durable Workflow journey without a browser:

```sh
pnpm exec tsx scripts/crewhelm-live-rehearsal.ts workflow \
  --installation crewhelm.testing.installation.json \
  --credential .crewhelm-rehearsal-credential.json
```

Run the owner-private MCP conversation journey to prove first message, follow-up, replay, stale
revision denial, lost-handle recovery, bounded discovery, Session cleanup, and Agent-capacity
restoration:

```sh
pnpm exec tsx scripts/crewhelm-live-rehearsal.ts conversation \
  --installation crewhelm.testing.installation.json \
  --credential .crewhelm-rehearsal-credential.json
```

The journey polls no faster than the public MCP rate-limit budget allows. If a prior attempt exits
with retained exact fixture IDs, resume cleanup rather than creating another fixture:

```sh
pnpm exec tsx scripts/crewhelm-live-rehearsal.ts recover \
  --installation crewhelm.testing.installation.json \
  --credential .crewhelm-rehearsal-credential.json \
  --agent-id '<exact agentId>' \
  --workflow-id '<exact workflowId>'
```

Recovery is exact, idempotent, browser-free, and reports bounded state and failure details without
tokens. Do not use discovery heuristics when the exact IDs are available.

Create or recover the credential only as an occasional combined authentication check:

```sh
pnpm exec tsx scripts/crewhelm-live-rehearsal.ts authorize \
  --installation crewhelm.testing.installation.json \
  --credential .crewhelm-rehearsal-credential.json \
  --browser codex
```

Prefer the Codex browser. If its URL policy blocks the signed OAuth handoff, `--browser system` is
explicitly allowed for this combined check on the exact standard target. It opens the system
browser without printing the signed URL. Do not use it for another target without new consent.

Run combined auth when authentication changed, the credential is absent or invalid, refresh became
ambiguous, or release confidence explicitly includes auth. A saved refresh credential is durable
testing authority: keep it only on the trusted local machine and never copy, print, inspect, or
commit it. The user's rehearsal request is consent; ambient sign-in or the credential file alone is
not.

## Guardrails

- State the exact target, scenario, mutations, cleanup, and acceptance evidence before live work.
- Use the dedicated test installation unless the user explicitly authorizes another target.
- Load infrastructure secrets only through the ignored repository environment file. Never print
  secret values, OAuth codes, signed URLs, tokens, or provider payloads.
- On authorization pages, inspect only scoped visible text and controls. Do not capture a full DOM
  snapshot containing signed links.
- Exercise public OAuth and MCP only. Do not substitute direct Durable Object, D1, R2, or provider
  writes for public live behavior.
- Keep fixtures unique, bounded, disposable, and within existing budgets. Record retained immutable
  evidence only when the product intentionally has no delete operation.
- Run one live session per installation. Preserve request, time, fleet-capacity, and access-token
  headroom for cleanup and revocation.

## Rehearsal

1. Complete target preflight and capture the stable fingerprint.
2. Capture a read-only baseline, including affected capacity and unresolved recovery state.
3. Exercise the feature happy path through public CLI and MCP using saved owner access.
4. Exercise idempotent replay, one meaningful denial or boundary, and documented recovery.
5. Read the exact result and verify compact discovery does not leak detailed content.
6. Clean up through public product operations and compare final state with the baseline.
7. Verify short-lived access-token revocation. Retain the rotating refresh credential for later
   rehearsals unless the user asks to retire autonomous testing access.

If the rehearsal exposes a product defect, stop the scenario. Reproduce it, fix it with
`crewhelm-delivery`, verify and redeploy the exact branch, then restart the rehearsal.

For a light rehearsal, stop after preflight, public diagnosis, and one bounded journey. Create no
provider effect unless required. Target five minutes while preserving origin, cleanup, and
short-lived access revocation.

### Repeated journeys

When the user explicitly requests repetition or flake evidence, complete preflight and deployment
once for the stable fingerprint, then run each journey sequentially. Repeat preflight after any
code, package, or deployment change.

Gate every next journey on a terminal report, exact fixture cleanup, capacity restored to the
baseline, and verified access-token revocation. Stop at the first anomaly and recover its exact IDs
before continuing. A failure before network access creates no live evidence and does not count as a
repetition. Record each run's duration, checks, resource IDs, and final state. Report progress only
at safe run boundaries; the wrapper emits phase evidence at completion, so do not infer whether
silence is execution, polling, or cleanup.

## Evidence

Report the endpoint, fingerprint, checks, resource IDs, before/after counts, terminal state, cleanup
or retained evidence, access-token revocation, and whether combined auth was run or reused. Never
report credential contents. Separate product failures from harness, browser, and provider failures.

Document only durable behavior or operational decisions not quickly inferable from code. Keep the
current system concise; omit change history.
