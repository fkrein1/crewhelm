---
name: crewhelm-docs
description: Author and review Crewhelm public documentation with durable content types, source evidence, exact product language, availability boundaries, discovery validation, and conflict-free agent path ownership.
---

# Crewhelm documentation

Create public documentation that is accurate, task-led, boundary-aware, and maintainable across
agents.

## Read

Read these sources before authoring or reviewing:

1. `docs/documentation/charter.md` and
   `docs/documentation/information-architecture.md` in full.
2. `CONTEXT.md` for exact Crewhelm terms.
3. `docs/product/brand.md` for voice and the public surface test.
4. The narrowest source that owns each claim:
   - `docs/product/philosophy.md` for product boundaries;
   - `docs/security/invariants.md` for authority, secrets, untrusted input, effects, bounds, and
     recovery;
   - `docs/architecture/system.md` for responsibility, custody, state, and trust boundaries;
   - executable code, schemas, tests, or generators for shipped behavior and reference.

Do not infer public behavior from plans or use public prose to settle a contradiction between
canonical sources.

## Frame

Before editing, state:

```text
Reader outcome:
Page type and route:
Audience:
Shipped source evidence:
Authority, custody, effects, and recovery affected:
Discovery surfaces affected:
Owned paths:
```

Use one tutorial, how-to, explanation, or reference template from
`docs/documentation/templates/`. Prefer one complete reader outcome over broad coverage.

## Coordinate agents

Assign every author an exclusive directory or explicit file list. The lead alone owns shared
content schemas, layouts, navigation, redirects, search configuration, sitemap behavior,
`llms.txt`, and package or lock files. Authors must not extend their path reservation without lead
approval.

Give each author the page contract, audience, canonical sources, availability, non-goals, and
expected validation. An author returns the routes changed, claims introduced, source evidence,
commands and links added, checks run, and unresolved questions. The lead integrates terminology,
cross-links, duplicated claims, and discovery behavior before independent review.

## Author

- Lead with the outcome. Name the boundary. Give the next action.
- Use exact capitalization and definitions from `CONTEXT.md`.
- Describe only shipped behavior in indexed pages. Keep plans out of procedures, reference,
  navigation, search, sitemap, and agent discovery.
- Link to one canonical fact instead of copying it across pages.
- Generate exhaustive CLI, MCP, schema, limit, and error reference when the owning contract allows
  it. Never hand-edit a generated page.
- For operational tasks, state prerequisites, authority, external effects, custody, verification,
  safe retry behavior, and recovery.
- Explain security invariants without weakening, broadening, or replacing them with prompt-level
  guidance.
- Avoid hype, vague success, stale availability language, hidden paid requirements, and examples
  that expose credentials or normalize unsafe authority.
- Change public behavior and its affected documentation in the same pull request. When no page
  changes, record the reason in the pull request.
- Preserve public routes. Add a permanent redirect before moving a route; retire a page from every
  discovery surface in the same change.

## Validate

Run the focused repository-provided documentation checks, then at minimum:

```sh
pnpm format:check
pnpm --filter @crewhelm/site build
git diff --check
```

Run the owning generator's check when generated reference is affected. Inspect the complete diff.
Preview every changed page and verify:

- outcome, page type, terms, commands, links, and source evidence;
- authority, custody, effects, verification, failure, and recovery claims;
- heading order, keyboard access, narrow and wide layouts, and light and dark presentation;
- canonical URL, redirect behavior, navigation, local links and anchors;
- intended inclusion or exclusion in search, sitemap, and `llms.txt`; and
- no indexed instructions or reference for unshipped behavior.

Follow `.agents/skills/crewhelm-delivery/SKILL.md` for final diff review and independent review.
