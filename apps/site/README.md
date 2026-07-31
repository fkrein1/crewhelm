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
`crewhelm.app` Custom Domain. Delivery has two deliberately separate lanes:

- The secretless GitHub Actions workflow verifies the site on every pull-request commit, including
  forks. It never receives Cloudflare credentials.
- Cloudflare Workers Builds owns uploads. Its GitHub App posts or updates the pull-request comment
  with the versioned `workers.dev` preview URL and retains earlier build history in that comment.

Keep the `crewhelm-site` Workers Build configured with:

| Setting                       | Value                                |
| ----------------------------- | ------------------------------------ |
| Root directory                | `/apps/site`                         |
| Production branch             | `main`                               |
| Build command                 | `pnpm run build`                     |
| Production deploy command     | `pnpm exec wrangler deploy`          |
| Non-production deploy command | `pnpm exec wrangler versions upload` |
| Non-production branch builds  | Enabled                              |
| Build watch include paths     | `*`; every branch commit builds      |

The Cloudflare Git integration owns its narrowly scoped build token; no Cloudflare secret is stored
in GitHub Actions. GitHub App repository access is limited to `fkrein1/crewhelm`.

Do not add D1 until a server-rendered recipe slice defines its schema, ranking semantics, abuse
bounds, migration/recovery path, and SEO contracts. When that slice exists, add the binding to the
same Worker rather than splitting the public site into a second deployment.
