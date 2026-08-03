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
the site without deployment credentials, including for forks. Cloudflare Workers Builds owns
deployment from the connected repository and supplies its own build identity; GitHub holds no
Cloudflare deployment secret.

The Registry and site remain separate Workers. A Registry deploy applies forward-compatible D1
migrations before uploading that Worker. Site and Registry builds can finish independently, so
their service contract and each migration remain compatible with the prior deployed version.
Registry OAuth credentials remain runtime Worker secrets and are not build inputs.

Workers Builds runs from `apps/registry` for the Registry Worker and `apps/site` for the site
Worker. Registry deployment calls `pnpm deploy:production`; the site builds with `pnpm run build`
and deploys with `pnpm exec wrangler deploy --env production`. Both projects track `main`, while
non-production branch builds remain disabled.

Restore a previous Worker version when code or routing must roll back. D1 migrations remain
forward-only, so recovery repairs schema state forward.
