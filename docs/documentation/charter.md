# Documentation charter

Crewhelm documentation helps an owner complete an outcome while keeping authority, custody,
verification, and recovery legible. It documents shipped behavior as fact and never presents a
plan, prompt, schema, tool listing, or model recommendation as authority.

This charter governs public documentation. Repository design, security, architecture, and
maintainer documents remain the canonical engineering record and are published only when a clear
owner need justifies a public page.

## Principles

1. **Task before feature.** Start from what the reader needs to accomplish or understand. Do not
   mirror the codebase or market a list of capabilities.
2. **One source per fact.** Give each fact one canonical home and link to it elsewhere. Generate
   exhaustive reference from the owning code or contract when practical.
3. **Shipped before indexed.** Indexed pages describe behavior an owner can use. Future work
   belongs in an explicit roadmap or unpublished draft, never in instructions, search results, or
   generated agent-discovery surfaces.
4. **Exact language.** Use the Crewhelm terms in [`CONTEXT.md`](../../CONTEXT.md) and the calm,
   direct, exact voice in the [brand guide](../product/brand.md).
5. **Boundaries are part of the task.** State authority, external effects, credential custody,
   verification, failure behavior, and recovery wherever they affect the outcome.
6. **Evidence over ceremony.** Record the code, contract, test, or generated artifact that supports
   a page. Do not use a review date as a substitute for proof.
7. **Documentation ships with behavior.** A public behavior change updates affected pages in the
   same pull request or explains why no public documentation changes.

## Sources of truth

Use the narrowest source that owns the claim:

- `CONTEXT.md` owns Crewhelm domain language.
- `docs/product/philosophy.md` owns product boundaries and bets.
- `docs/product/brand.md` owns voice and the public surface test.
- `docs/security/invariants.md` owns security guarantees. Public prose may explain but never
  redefine or weaken them.
- `docs/architecture/` owns system responsibility, custody, and trust boundaries.
- executable code, schemas, tests, and generated artifacts own shipped commands, fields, limits,
  errors, and behavior.

When sources disagree, stop and resolve the product or engineering contradiction. Do not make the
public page choose a convenient interpretation.

## Page contract

Every page declares a concise title and description, one content type, its intended audience, the
domain that owns its facts, and source evidence. Source evidence is maintainer metadata and need
not be rendered to readers.

Each page must:

- lead with the outcome or question it answers;
- stay within one content type from the
  [information architecture](information-architecture.md);
- distinguish a Crewhelm guarantee from provider behavior or operator responsibility;
- use links instead of copying facts whose canonical home is another page;
- avoid vague availability words such as "new", "soon", or "currently";
- use stable, descriptive internal links and heading text; and
- provide a bounded next action rather than a generic list of related pages.

An operational page also answers the brand surface test:

1. What can the owner do?
2. What authority is used?
3. Where does custody sit?
4. What happens next?

If the task can create an external effect or durable state, the page states how to verify the
result and what is safe to retry, revoke, delete, or recover.

## Availability and discovery

Published, indexed documentation describes shipped behavior. Preview behavior may be published
only when a reader can actually use it and the page names the exact prerequisite and stability
boundary.

Planned behavior must remain an unpublished draft or an explicitly planned roadmap statement. It
must not appear as a procedure, ordinary reference entry, navigation destination, site-search
result, sitemap URL, or `llms.txt` recommendation.

Before merging, validate the rendered route, canonical URL, navigation, local links and anchors,
sitemap membership, search membership, and agent-discovery text together. Discovery surfaces are
part of the documentation contract, not follow-up SEO work.

## Lifecycle

The domain that owns a behavior owns the accuracy of its public documentation. The site owns the
rendering system and shared navigation, not the underlying product facts.

When behavior changes, update its canonical page and generated reference in the same pull request.
When a route changes, add a permanent redirect and update internal links. When a page no longer
serves a reader need, redirect it to the closest true replacement or retire it from navigation,
search, sitemap, and agent discovery. Never leave an indexed page knowingly stale.

Use the [Crewhelm documentation skill](../../.agents/skills/crewhelm-docs/SKILL.md) for authoring,
review, and multi-agent path ownership.
