---
title: Publish an Agent as a Recipe
description: Turn one exact Agent revision into a confirmed immutable public Recipe and optional Skill versions.
type: how-to
audience: owner
area: recipes
availability: available
sources:
  - docs/product/recipes.md
  - docs/architecture/system.md
  - docs/security/invariants.md
  - docs/reference/mcp-tools.md
  - packages/contracts/src/recipe-publications.ts
---

Use `crewhelm_recipe_publications` to publish one exact Agent revision as a new immutable Recipe
version. Publishing is an external public action. It never includes credentials, grants, Briefs,
owner-local IDs, history, or runtime telemetry.

The tool accepts one `request` JSON string. Encode the selected `action` and that action's fields
inside it; the owner control plane decodes and validates the full typed request before doing work.

## Before you begin

- Full control access to the Crewhelm installation.
- The exact Agent ID and revision to publish.
- Public discovery copy, responsibility boundaries, inputs, operations, license, provenance, tags,
  and a sample deliverable for the Recipe draft.
- One explicit decision for every local Skill attached to that Agent revision.

## Authorize this publication

1. Generate one UUID idempotency key and keep it unchanged through authorization, preview, and
   publish.
2. Call `authorize_publish` with that key and a recognizable installation label.
3. Open the returned URL. Sign in with GitHub if needed, verify the publisher namespace, and choose
   **Authorize publishing**.
4. Return to the MCP client. The short-lived authorization is scoped to that one idempotency key;
   Crewhelm does not receive the GitHub token or Registry session cookie.

## Make every Skill decision

For every exact local Skill ID and version attached to the Agent, choose one action in the
publication candidate:

- `publish`: publish the same bounded text files as a new public Skill version and declare its
  license and whether it is required or optional.
- `reference`: pin an existing Registry Skill coordinate and digest. Preview succeeds only when its
  public package matches the local Skill exactly.
- `remove`: exclude it from the public candidate. This remains blocked until Crewhelm can verify a
  rehearsal of the changed candidate; the flow does not claim equivalent behavior from omission
  alone.

Public Skills cannot contain `scripts/`, suspected secrets, or suspected private identifiers.
Skill Markdown stays inert public package content and grants no authority.

## Preview and publish

1. Build the candidate with the source `{id, revision}`, a complete public Recipe draft without a
   `skills` field, and the explicit Skill decisions. The server validates the decoded structure
   against the full Recipe contract.
2. Call `preview_publish`. Its `request` JSON contains the action, authorization ID, candidate, and
   original idempotency key.
3. Confirm `ready: true`. Review the publisher namespace, exact next Recipe and Skill versions,
   public digests, file paths, Skill provenance and warning counts, requested authority, operations,
   limits, and the complete exclusions list.
4. Preserve `confirmationDigest`, then call `publish` with the unchanged candidate, authorization,
   idempotency key, and expected confirmation digest.

The Registry independently revalidates the package, sensitive-content checks, namespace, exact
next versions, daily quotas, and immutable object writes. A concurrent publication can make a
preview stale; request a new preview and confirm its new digest.

Retry an uncertain response with the same idempotency key and unchanged candidate. Never generate
a new key merely because the response was interrupted.

## Verify the result

The result returns the immutable Recipe projection and every published artifact coordinate and
digest. Inspect the public Recipe through `crewhelm_recipes`, then search for its intended outcome
to verify discovery. The published package remains unreviewed and untrusted even when its publisher
identity is known.
