# Crewhelm Recipe Registry

The Registry is Crewhelm's public package and discovery service. It is a private Cloudflare Worker
reached through the site's same-origin `/api/registry` gateway, not an owner control plane or an
Agent runtime dependency.

## Boundary

The Registry holds only public package and publisher state. Owner credentials, Connections, Briefs,
grants, installation receipts, private search context, and runtime telemetry never cross this
boundary.

Public reads are cacheable and rate limited. Publishing requires authenticated GitHub identity,
same-origin requests, bounded bodies and quotas, idempotency, exact next versions, immutable
dependency digests, and content checks. GitHub OAuth uses browser-bound, single-use PKCE state.
Access tokens are used only to resolve publisher identity during the callback and are never
retained; Registry sessions are opaque and stored only as hashes.

## Custody and discovery

- R2 stores canonical immutable Recipe and Skill packages under digest-addressed keys.
- D1 stores publisher identity, versions, public projections, dependency edges, lifecycle,
  idempotency, quotas, and lexical search state through a typed Drizzle schema. Deliberate SQL is
  limited to the Cloudflare migration and FTS5 boundary.
- Vectorize stores embeddings derived only from bounded public Recipe discovery and outcome text.
- Scheduled maintenance expires temporary state, quarantines abandoned upload intents before a
  second grace period and exact-object deletion, and retries pending search indexing. Interrupted
  attempts remain quota-charged.

Raw Skill files are never embedded for search. Search returns a bounded ranked shortlist rather
than a generated answer and falls back to lexical retrieval when semantic indexing is unavailable.
Exact coordinates remain the authoritative single-result path.

Publisher namespaces remain stable after their first authenticated claim. Recipe and Skill versions
are immutable, and secrets or private identifiers fail closed before package storage.
