# Develop and validate the Recipe Registry

Crewhelm provides a fast Registry-only loop and a complete pre-merge installation rehearsal.

## Develop the Registry locally

Run:

```sh
pnpm registry:dev
```

The command applies local D1 migrations, starts the Registry on `127.0.0.1:8788`, and reconciles ten
representative Recipe and Skill packages. Local search uses deterministic lexical fallback. State
is isolated to the worktree under `.wrangler/`; no MCP, OAuth flow, tunnel, or Cloudflare resource
is involved.

The exact-loopback Registry auto-authorizes its seeded `crewhelm-labs` publisher only when the
owner publishing client resolves a one-time authorization. This permits local Agent-to-Recipe
preview and publication without GitHub OAuth. The bypass exists only in `src/local.ts`; production
always requires the browser GitHub authorization, and the dedicated testing Registry keeps
publisher authorization disabled.

Seed artifacts are immutable and their versions are contiguous. When a seed package changes,
append a complete definition snapshot and its frozen package digests. Reconciliation verifies the
historical bytes, then publishes every Recipe-and-Skill version in order before the latest set.

## Reconcile the testing installation

Run:

```sh
pnpm testing:up
```

This is the authoritative setup step before live validation. It builds the current branch, checks
the release package, applies pending testing Registry migrations, deploys and fingerprints the
testing Registry, reconciles the ten seed Recipes, applies pending MCP/Auth migrations, deploys
`crewhelm-testing`, and runs public diagnosis. The MCP deployment is marked as testing and fails
closed unless its Recipe Registry origin is the dedicated testing Registry.

In a new worktree, the command copies only `crewhelm.testing.installation.json` from the main
worktree when needed and loads the main worktree's ignored `.env.test.local`. It never copies the
saved OAuth credential.

Use the `crewhelm-live-validation` skill after reconciliation. It reuses rotating owner access or
opens the normal MCP OAuth flow in the Codex browser, then runs the requested public MCP journey.
The Recipe journey covers search, inspect, preview, Skill import, installation, and disabled-Agent
verification.

The testing Registry intentionally omits interactive publisher GitHub OAuth. Public reads remain
anonymous, while seed reconciliation uses a stable, ignored testing-only setup credential shared
from the main worktree. Publisher OAuth remains a separate targeted rehearsal when that
authentication path changes.
