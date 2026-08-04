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

Site pull requests upload an undeployed version of the connected `crewhelm-site` Worker. Its public
preview URL routes Registry reads through a private service binding to `crewhelm-registry-dev`; the
preview environment has no production route or production Registry binding. Keep the site Workers
Build configured with:

| Setting                              | Value                                               |
| ------------------------------------ | --------------------------------------------------- |
| Root directory                       | `/apps/site`                                        |
| Production branch                    | `main`                                              |
| Build command                        | `pnpm run build`                                    |
| Production deploy command            | `pnpm exec wrangler deploy --env production`        |
| Non-production branch deploy command | `pnpm exec wrangler versions upload --env preview`  |
| Non-production branch builds         | Enabled                                             |
| Build watch include paths            | `*`; every branch commit can produce a site preview |

Preview URLs are public and have no Workers logs. Do not put secrets or production bindings in the
preview environment. Disable non-production branch builds to stop new previews; existing uploaded
versions remain inert unless their preview URL is requested.

Restore only a Worker version verified as a production deployment from `main` with the production
Registry and KV bindings. Never deploy or roll back to a pull-request preview version. D1
migrations remain forward-only, so recovery repairs schema state forward.
