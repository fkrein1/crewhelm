# Crewhelm site

The public site is a static Astro application deployed through Cloudflare Workers Assets. Keeping
the landing page prerendered gives the launch site the smallest runtime and strongest cacheability.
Future server-rendered recipe discovery can add Astro's Cloudflare adapter and D1 to the same
`crewhelm-site` Worker without moving the public domain.

## Local development

```sh
pnpm --filter @crewhelm/site dev
pnpm --filter @crewhelm/site build
pnpm --filter @crewhelm/site preview
```

Astro uses Vite, Tailwind 4 is configured through its Vite plugin, and design tokens are declared
in `src/styles/global.css` through Tailwind's CSS-first `@theme` interface.

## Delivery

`wrangler.jsonc` is the source of truth for the `crewhelm-site` Worker, preview URLs, and the
`crewhelm.app` Custom Domain. The secretless GitHub site workflow verifies the build only when
`apps/site`, its shared design package, or their build inputs change.

- Cloudflare Workers Builds watches the same paths in the monorepo.
- Non-production branches run `pnpm --filter @crewhelm/site preview:upload` and receive an isolated
  `workers.dev` preview URL without exposing credentials to pull-request workflows.
- Changes merged to `main` run `pnpm --filter @crewhelm/site run deploy:production` and update
  `crewhelm.app`.

The Cloudflare Git integration owns its narrowly scoped build token; no Cloudflare secret is stored
in GitHub Actions. Keep the production branch set to `main`, enable non-production branch builds,
and include only the site and its direct build inputs in Build watch paths.

Do not add D1 until a server-rendered recipe slice defines its schema, ranking semantics, abuse
bounds, migration/recovery path, and SEO contracts. When that slice exists, add the binding to the
same Worker rather than splitting the public site into a second deployment.
