# Discovery standards

Use this reference to make decisions, then re-open the linked primary documentation before relying
on crawler names, integration versions, or emerging conventions.

## Confidence tiers

### Stable foundation

- Render useful, accessible, semantic content in initial HTML.
- Use stable canonical URLs and consistent internal links.
- Publish accurate titles, descriptions, robots metadata, and social metadata.
- Publish an XML sitemap containing canonical, indexable URLs.
- Use a root `robots.txt` for crawl access, not for removing indexed URLs.
- Use JSON-LD that matches visible content.

Google says its AI search features use the same foundation as Search and require no AI-specific
file or markup. Do not describe an AEO technique as a Google requirement or confirmed ranking
factor without current primary evidence.

### Emerging, optional layer

- `/llms.txt` is a proposed Markdown index for agents. It requires an H1; a short blockquote and H2
  link lists are useful. Keep it curated and concise.
- `/llms-full.txt`, Markdown content negotiation, Cloudflare Content Signals, and similar mechanisms
  need an identified consumer, maintenance owner, and explicit policy decision.
- There is no broadly adopted `ai.txt` convention comparable to robots or sitemaps. Omit it unless a
  documented consumer makes it necessary.

## Crawler policy is product policy

Do not infer a training preference from a request for search visibility.

| Purpose                           | Current control                              | Important distinction                                        |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| Google Search and its AI features | `Googlebot` plus page preview controls       | Google says no special AI file or schema is required.        |
| ChatGPT search discovery          | `OAI-SearchBot`                              | Independent from OpenAI model-training access.               |
| OpenAI model training             | `GPTBot`                                     | May be disallowed while search remains allowed.              |
| User-triggered ChatGPT fetch      | `ChatGPT-User`                               | Not an automatic search crawler; robots rules may not apply. |
| Other vendors                     | Their current official crawler documentation | Names and purposes change; verify before editing policy.     |

A generic `User-agent: *` policy already applies to bots without a more specific group. Add named
groups only to express an intentional difference. Remember that a crawler-specific group replaces,
rather than combines with, the generic group for Google-style robots parsing.

## Astro implementation

- Set the production origin with Astro's `site` option.
- Prefer `@astrojs/sitemap`, Astro's official build integration, when the route set can grow. It
  discovers prerendered routes; confirm current behavior for SSR and dynamic routes before relying
  on it.
- Build canonical URLs from `Astro.site` and the normalized route path, not request hosts or string
  concatenation.
- Keep metadata defaults, URL normalization, JSON-LD serialization, robots text, and llms text in
  owned modules with small interfaces. Route files should render or return those owned values.
- Ensure JSON embedded in HTML cannot terminate its script element when any value can contain
  untrusted text.
- Test generated output after `astro build`; source-level assertions cannot prove what crawlers see.

## Sitemap and robots invariants

- `robots.txt` is UTF-8 text at `/robots.txt`.
- Use standard `User-agent`, `Allow`, `Disallow`, and `Sitemap` fields. The sitemap value is an
  absolute URL.
- Blocking crawl does not reliably remove a known URL from search. Use `noindex` on a crawlable page
  when removal from an index is the goal.
- Sitemap URLs are absolute, canonical, indexable, and normally successful `200` pages.
- Use `<lastmod>` only when it reflects a significant content change and can stay accurate.
- Do not spend effort on `<priority>` or `<changefreq>` for Google; Google ignores them.

## Structured-data invariants

- Prefer JSON-LD, but use it only when a type truthfully represents visible content.
- Keep markup on the page it describes and keep referenced assets crawlable.
- Validate with schema.org tooling for vocabulary and the relevant search engine tool for feature
  eligibility. Passing validation does not guarantee a rich result.
- Treat semantic validity and rich-result eligibility as separate outcomes. A truthful type can be
  useful machine-readable context even when no search feature supports it.
- Do not add `SearchAction` unless a real crawlable site-search experience matches it.
- Do not add ratings or aggregate counts before Crewhelm owns the underlying, abuse-resistant data.

## Primary sources

- [Astro sitemap integration](https://docs.astro.build/en/guides/integrations-guide/sitemap/)
- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google robots.txt specification](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec)
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google structured-data guidelines](https://developers.google.com/search/docs/appearance/structured-data/sd-policies)
- [OpenAI crawler roles](https://developers.openai.com/api/docs/bots)
- [Cloudflare AI Crawl Control directives](https://developers.cloudflare.com/ai-crawl-control/features/track-robots-txt/)
- [llms.txt proposal](https://llmstxt.org/)
- [Resend's llms.txt implementation](https://resend.com/docs/llms.txt)
