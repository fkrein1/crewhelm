# 0002: Owner-scoped Durable Object control plane

Status: accepted

## Context

Individual administration needs isolation, serialized mutation, and read-after-write consistency.
A global coordinator is a shared bottleneck; D1 adds no value to that first owner-local workload.

## Decision

- One SQLite-backed `OwnerControlPlane` Durable Object per authenticated owner.
- One name-addressed `CrewAgent` Durable Object per logical agent.
- Typed RPC internally; no global control-plane object.
- Git is the public recipe source. D1 is projection-only and R2 is for large artifacts until
  evidence changes the storage shape.

Object names derive from verified owner identity and control-plane-generated IDs, never caller or
model input.

## Consequences

Administration is isolated; agents scale and fail independently. Cross-object operations need
stable IDs, idempotency, expected revisions, and recovery because transactions do not span
Durable Objects. Search needs a local index or rebuildable projection.

## Revisit when

Revisit for primary cross-owner queries, measured object limits, or a hosted marketplace index.
Preserve one authoritative owner per fact.
