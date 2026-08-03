# Crewhelm site

The public site is a static Astro application deployed through Cloudflare Workers Assets. Keeping
the landing page prerendered gives the launch site the smallest runtime and strongest cacheability.

## Registry gateway

The site Worker handles only `/api/registry` before static assets, removes that public prefix, and
forwards the request to the private Recipe Registry Worker through a service binding. Similar-looking
paths remain website traffic, and Registry failures return a compact, non-cacheable response.

The gateway gives browser publishing one origin without moving Registry persistence, search,
scheduled work, or secrets into the site Worker.

## Local development

```sh
pnpm --filter @crewhelm/site dev
pnpm --filter @crewhelm/site build
pnpm --filter @crewhelm/site preview
```

Astro uses Vite, Tailwind 4 is configured through its Vite plugin, and design tokens are declared
in `src/styles/global.css` through Tailwind's CSS-first `@theme` interface. Starlight renders the
static documentation under `/docs`, with Pagefind creating its search index after the Astro build.
Documentation source lives under `src/content/docs/docs`; `src/content.config.ts` enforces the
shared frontmatter contract, `src/lib/docs-manifest.ts` owns navigation and public routes, and
`src/styles/docs.css` adapts Starlight to the Crewhelm design system.

## Delivery

`wrangler.jsonc` is the source of truth for site bindings and public domains. Pull requests verify
the site without deployment credentials, including for forks. Cloudflare Workers Builds does not
independently deploy this Worker.

After a protected-main merge, the Registry delivery workflow verifies the exact revision, applies
forward-compatible Registry migrations, deploys the Registry before its site gateway, and
smoke-tests development. Production approval promotes the same revision in the same order. The
environment-scoped Cloudflare token is available only to the credential check, migration, and
deploy steps; dependency installation and smoke tests never receive it. Registry OAuth credentials
remain Worker secrets and are not deployment inputs.

A failed promotion stops before the next environment. Restore the previous verified Worker
versions when code or routing must roll back; D1 migrations remain forward-only, so recovery repairs
schema state forward and every migration must remain compatible with the prior Worker. Running
promotions are never cancelled after effects begin.
