---
name: crewhelm-seo-aeo
description: Build or audit SEO and agent discovery for Crewhelm's Astro site. Use for changes to page metadata, canonical URLs, Open Graph, JSON-LD, robots directives, XML sitemaps, llms.txt, crawler policy, indexability, recipe discovery pages, or requests mentioning SEO, AEO, GEO, AI crawlers, search visibility, or answer-engine visibility in apps/site.
---

# Crewhelm SEO and AEO

Make Crewhelm easy to crawl, understand, cite, and use without optimizing for folklore.

## Ground the work

1. Read `references/standards.md` completely before changing discovery behavior.
2. Read `apps/site/astro.config.ts`, the affected pages and layouts, and
   `docs/product/brand.md`.
3. Browse the primary sources linked in the reference when crawler behavior, Astro integrations,
   or search guidance may have changed. Treat the checked-in reference as a decision guide, not a
   frozen copy of vendor documentation.
4. State which routes should be indexable and whether the work changes crawler access or model
   training policy. Do not silently make that policy choice.

## Work in this order

### 1. Establish the URL contract

- Give every indexable page one stable HTTPS URL and a self-referencing absolute canonical.
- Check the deployed HTTP origin and intended alternate hosts. They must permanently redirect to
  the canonical HTTPS host or remain deliberately unconfigured.
- Keep only canonical, indexable, successful URLs in the sitemap.
- Exclude error, private, duplicate, filtered, and internal-search pages unless the product has a
  deliberate landing-page strategy for them.
- Make redirects, canonicals, internal links, sitemap entries, and social URLs agree.

### 2. Render complete metadata in initial HTML

- Centralize defaults and URL construction; let pages override title, description, image, robots,
  and structured data through a small typed interface.
- Emit a unique, descriptive title and description based on visible page content. Use length as a
  preview check, never as a ranking formula.
- Emit canonical, robots, Open Graph, and relevant social metadata server-side or at build time.
- Give `404` and other non-content routes `noindex` and keep them out of the sitemap.
- Add social images only when a real, absolute, crawlable asset exists.

### 3. Describe only what is true

- Prefer JSON-LD and select the narrowest schema.org type that accurately represents visible
  content. Validate both syntax and factual consistency.
- Distinguish valid schema.org meaning from a search engine's stricter rich-result eligibility;
  report both without adding fake properties to qualify.
- Never invent reviews, ratings, prices, authors, dates, availability, or organization profiles.
- Crewhelm "recipes" are agent configurations, not food. Never use schema.org `Recipe` for them.
  Consider `SoftwareSourceCode`, `CreativeWork`, or an `ItemList` only when their properties match
  the rendered page.
- Treat structured data as machine-readable meaning, not a promise of a rich result or ranking.

### 4. Publish discovery files from owned sources

- Generate sitemaps with Astro's official sitemap integration once routes can grow. Do not maintain
  a parallel hand-written route inventory.
- Keep `robots.txt` at the origin root. Use standard `User-agent`, `Allow`, `Disallow`, and absolute
  `Sitemap` fields.
- Treat search discovery, user-triggered fetches, and model training as separate crawler purposes.
  Re-check vendor documentation before naming a bot.
- Add `/llms.txt` as a concise Markdown index when it gives agents useful context. It complements,
  and never replaces, semantic HTML, robots, or the sitemap.
- Do not add `ai.txt`, `llms-full.txt`, crawler-specific Markdown, or emerging content signals
  without a documented consumer and enough maintained content to justify them.

### 5. Write for people and extraction

- Put the direct, accurate answer near the start, then supply evidence and detail.
- Use semantic HTML, descriptive headings, real links and buttons, accessible names, and visible
  text for important claims.
- Keep claims concrete and sourceable. Do not add keyword quotas, synthetic FAQs, hidden text,
  duplicated AI-only copy, or speculative "citation boost" tactics.
- Preserve Crewhelm's concise, operational voice. Do not trade clarity for search phrases.

## Prepare recipe discovery without premature machinery

- Give each public recipe a stable slug, unique server-rendered content, canonical URL, and
  crawlable internal link.
- Keep sorting, ranking, and search parameter variants from multiplying indexable URLs.
- Make download counts and rankings factual, timestamped where useful, and independent of schema
  claims.
- Add pagination and recipe-specific structured data only with the actual recipe surface. Do not
  add D1, SSR, or speculative schemas while the site is still a landing page.

## Verify emitted behavior

Run the repository's required checks plus focused evidence:

```sh
pnpm --filter @crewhelm/site build
pnpm --filter @crewhelm/site preview
```

Inspect the built or served HTML, not only component source. Verify:

- indexable routes return `200` with one title, description, absolute canonical, and valid JSON-LD;
- non-indexable routes emit `noindex` and are absent from the sitemap;
- `robots.txt`, every referenced sitemap, and `llms.txt` return `200` with the intended content type;
- every sitemap and `llms.txt` URL is absolute, canonical, reachable, and appropriate to publish;
- metadata values reflect visible content and contain no placeholder host, stale route, or false
  claim.

Report separately what is implemented, what is an emerging convention, and what requires external
verification in Search Console or crawler dashboards. Never promise indexing, ranking, snippets,
or AI citations.
