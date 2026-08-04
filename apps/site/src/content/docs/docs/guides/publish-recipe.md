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

Use `crewhelm_publish_recipe` to publish one exact Agent revision as a new immutable Recipe
version. Publishing is an external public action. It never includes credentials, grants, Briefs,
owner-local IDs, history, or runtime telemetry.

## Before you begin

- Full control access to the Crewhelm installation.
- The exact Agent object returned by Crewhelm.
- A declared license.
- The current Schedule and Event Trigger objects to include.

## Prepare and review the candidate

1. Call `crewhelm_publish_recipe` with `operation.kind: "prepare"`, the returned Agent, license, and
   selected Schedule and Event Trigger objects. Keep the returned draft reference unchanged.
2. Inspect only the candidate sections you need with `operation.kind: "inspect_section"`. Crewhelm
   copies the Agent instructions, limits, portable capabilities, configured primary and fallback
   models, and local Skill coordinates; converts selected recurring operations and attached
   Connections into portable declarations; and replaces exact recurring Brief references with named
   public inputs.
3. Replace one editable section at a time with `operation.kind: "set_section"`. Use
   `set_skill_decision` separately for each local Skill. Every edit returns a new draft revision;
   use that returned reference for the next edit. Keep the copied Agent executable definition
   exact.

Preparation is owner-local and has no public effect. Exact Brief and Connection IDs remain local.

## Authorize this publication

1. Call `crewhelm_publish_recipe` with `operation.kind: "authorize"` and a recognizable
   installation label. Crewhelm derives retry identity for ordinary calls.
2. Keep the returned authorization object unchanged, then open its URL. Sign in with GitHub if
   needed, verify the publisher namespace, and choose **Authorize publishing**.
3. Return to the MCP client. Crewhelm does not receive the GitHub token or Registry session cookie.

## Make every Skill decision

Inspect the `skills` section, then use `operation.kind: "set_skill_decision"` for every exact local
Skill ID and version attached to the Agent:

- `publish`: publish the same bounded text files as a new public Skill version and declare its
  license and whether it is required or optional.
- `reference`: pin an existing Registry Skill coordinate and digest. Preview succeeds only when its
  public package matches the local Skill exactly.
- `remove`: exclude it from the public candidate.

Public Skills cannot contain `scripts/`, suspected secrets, or suspected private identifiers.
Skill Markdown stays inert public package content and grants no authority.

## Preview and publish

1. Call `crewhelm_publish_recipe` with `operation.kind: "preview_or_publish"`, the returned
   authorization, and latest draft. Omit `expectedConfirmationDigest` to preview.
2. Confirm `ready: true`. Review the publisher namespace, exact next Recipe and Skill versions,
   public digests, file paths, Skill provenance and warning counts, requested authority, operations,
   limits, and the complete exclusions list.
3. Preserve `confirmationDigest`, then repeat the same operation with the authorization and draft
   unchanged plus `expectedConfirmationDigest` to publish.
4. After a confirmed publication, or when abandoning the candidate, call
   `operation.kind: "discard_publish_draft"` with the latest draft reference.

The Registry independently revalidates the package, sensitive-content checks, namespace, exact
next versions, daily quotas, and immutable object writes. A concurrent publication can make a
preview stale; request a new preview and confirm its new digest.

Retry an uncertain response with the same authorization object and unchanged draft. The
authorization carries the publication attempt identity; callers do not construct or copy a
separate retry key.

## Verify the result

The result returns the immutable Recipe projection and every published artifact coordinate and
digest. Inspect the public Recipe through `crewhelm_inspect_recipes`, then search for its intended
outcome to verify discovery. The published package remains unreviewed and untrusted even when its
publisher identity is known.
