# Crewhelm design

`@crewhelm/design` defines the shared visual language for Crewhelm browser and terminal surfaces.
It is dependency-free so Cloudflare Workers, the bootstrap CLI, and future MCP app resources can
consume the same foundations without importing a rendering framework.

Product meaning, voice, and application rules live in the [brand guide](../../docs/product/brand.md).

## Exports

- `@crewhelm/design` provides renderer-neutral brand and token values.
- `@crewhelm/design/theme.css` provides Tailwind 4 `@theme` color scales, typography, shadows, and
  shadcn-style semantic roles such as `background`, `foreground`, `primary`, and `border`.
- `@crewhelm/design/web` provides the compact brand fragment, semantic page tones, and the
  same-origin stylesheet served by each browser runtime.
- `@crewhelm/design/terminal` provides the canonical CLI banner and semantic RGB roles.
- `@crewhelm/design/assets/*` provides byte-preserved SVG and 1024px PNG masters for light and dark
  backgrounds, paired transparent PNG sizes, explicit favicon variants, and adaptive SVG aliases.

The package owns static assets and semantic roles. Each runtime continues to own document
rendering, escaping, response headers, content security policy, forms, and interaction behavior.

## Palette model

The palette uses perceptually uniform OKLCH ramps from `50` through `950`. Components consume
semantic roles; numbered values are for composition and new roles. Contrast tests cover every
text-bearing semantic pair.

This follows [Tailwind’s `@theme` color model](https://tailwindcss.com/docs/colors),
[shadcn’s semantic variables](https://ui.shadcn.com/docs/theming), and
[Radix’s scale composition](https://www.radix-ui.com/colors/docs/palette-composition/composing-a-palette).

Use numbered palette tokens for ramps and semantic tokens in components. Extend the shared theme
before adding a local value. Add
framework-specific exports only when a real application needs them; do not make the foundation
package depend on React, a browser DOM, Node.js, or a terminal library.
