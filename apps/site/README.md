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
and deploys with `pnpm exec wrangler deploy --env production`. Both projects track `main`.

Site pull requests upload an isolated version of the connected `crewhelm-site` Worker. The preview
version routes Registry reads through a private service binding to `crewhelm-registry-dev`; it is
not promoted to the production route. Version preview URLs must remain enabled on the connected
Worker because Workers Builds preserves that Worker identity even when Wrangler selects the
`preview` environment. Keep the site Workers Build configured with:

| Setting                              | Value                                               |
| ------------------------------------ | --------------------------------------------------- |
| Root directory                       | `/apps/site`                                        |
| Production branch                    | `main`                                              |
| Build command                        | `pnpm run build`                                    |
| Production deploy command            | `pnpm exec wrangler deploy --env production`        |
| Non-production branch deploy command | `pnpm exec wrangler versions upload --env preview`  |
| Non-production branch builds         | Enabled                                             |
| Build watch include paths            | `*`; every branch commit can produce a site preview |

Preview URLs are separate public `workers.dev` surfaces with no Workers logs and may not inherit
the production custom domain's zone controls. This includes version URLs for production builds.
Use Cloudflare Access before previews carry non-public content or bindings. Do not put secrets in
either environment or add production-only bindings to the preview environment. Disable
non-production branch builds to stop new previews; existing uploaded versions remain inert unless
their preview URL is requested.

Astro's Cloudflare adapter enables KV-backed sessions by default. The site does not use application
sessions, so its Astro config selects an in-memory session driver instead. Keep that override unless
the site gains a deliberate, environment-isolated session store; implicit KV provisioning races
with the existing production namespace and makes branch uploads fail.

Preview-host requests also require Cloudflare's `global_fetch_strictly_public` compatibility flag
so Astro can reach its Worker and asset surfaces without Cloudflare rejecting the same-zone fetch.

Restore a previous Worker version when code or routing must roll back. D1 migrations remain
forward-only, so recovery repairs schema state forward.
