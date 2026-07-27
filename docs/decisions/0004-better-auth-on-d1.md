# 0004: Better Auth OAuth provider on D1

Status: accepted

## Context

Crewhelm's remote MCP surface needs standard OAuth 2.1 discovery, dynamic public-client
registration, S256 PKCE, GitHub login, consent, JWT/JWKS handling, and revocation. The first
implementation composed custom GitHub authorization with Cloudflare's KV-backed OAuth provider.
KV's eventual consistency complicated single-use authorization codes and immediate revocation,
while Crewhelm still owned a large amount of protocol glue.

The auth seam is consequential: it crosses an untrusted public client, GitHub, persistent protocol
state, and the owner-scoped control plane. Its callers should need to know only the standard OAuth
endpoints and the resulting verified owner/client authority.

## Decision

- Use Better Auth's OAuth 2.1 Provider and a scope-free GitHub generic OAuth integration behind
  Crewhelm's Hono routes.
- Persist OAuth protocol state through Better Auth's Drizzle adapter in a dedicated D1 database.
- Keep Crewhelm's policy outside the library: one exact MCP audience, explicit attenuated scopes,
  S256 PKCE, HTTPS or exact-loopback redirects, a 24-hour public-client lease, and the configured
  GitHub numeric owner ID.
- Request no GitHub scope and force upstream access, refresh, and ID token fields to null in
  database hooks before persistence.
- Issue non-refreshable 15-minute JWT access tokens and use a D1 denylist of SHA-256 token hashes
  for immediate explicit revocation.
- Keep login sessions non-refreshing and limited to 10 minutes. Purge expired protocol state
  hourly.
- Seed the one MCP resource in `insertOnly` mode. A future resource scope or lifetime change must
  ship an explicit data migration rather than relying on configuration to overwrite stored rows.
- Pin Better Auth and its OAuth provider to `1.7.0-beta.10`: the current stable line is affected by
  GHSA-p2fr-6hmx-4528, while this beta contains the required fix. Re-review and upgrade together
  once a suitable stable release exists. `1.7.0-rc.2` was evaluated but its Drizzle adapter
  generated an invalid account lookup against Drizzle 0.45.2 during the GitHub callback.

## Alternatives considered

Continuing the KV-backed provider kept fewer dependencies but preserved eventual-consistency and
protocol-composition costs. A fully custom OAuth server offered maximum control but substantially
expanded security-critical code. Better Auth with D1 gives the smallest reviewed interface while
Crewhelm retains deterministic authorization and stricter client policy.

## Consequences

The auth D1 database is authoritative only for OAuth protocol state; Durable Objects remain
authoritative for control-plane and agent domain state. Rotating to a fresh migrated auth database
is the global-revocation and recovery boundary. Better Auth, its OAuth provider plugin, and Drizzle
are security-sensitive runtime dependencies and require compatibility, migration, and supply-chain
review on every upgrade.

Better Auth and Drizzle publish optional declarations for Node, Bun, and other database runtimes
that TypeScript 7 cannot check in the Worker-only type environment. The Worker TypeScript project
therefore skips dependency declaration checking while still checking all Crewhelm source. Exact
dependency pins, the generated D1 schema, and the full runtime OAuth integration test bound this
temporary compatibility exception. A no-skip TypeScript 7 run reports diagnostics only in
third-party declaration files from Better Auth, its OAuth Provider, Better Fetch, and Drizzle, with
none in Crewhelm source. At the accepted pins, its 125 diagnostics are missing optional
Node/Bun/database runtime declarations and incompatible exact-optional or generic declarations.
Production audit and license review pass, and the full OAuth integration test exercises the
affected import seams. On any upgrade to Better Auth, the OAuth Provider, Better Fetch, Drizzle, or
TypeScript, rerun the Worker typecheck without the exception and remove it as soon as those
declarations are clean in the Workers environment.

Revisit this decision before adding write scopes, refresh tokens, another identity provider,
multi-owner hosting, or a login session longer than the current authorization ceremony.
