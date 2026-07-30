# Crewhelm design

`@crewhelm/design` defines the shared visual language for Crewhelm browser and terminal surfaces.
It is dependency-free so Cloudflare Workers, the bootstrap CLI, and future MCP app resources can
consume the same foundations without importing a rendering framework.

## Exports

- `@crewhelm/design` provides renderer-neutral brand and token values.
- `@crewhelm/design/web` provides the compact brand fragment, semantic page tones, and the
  same-origin stylesheet served by each browser runtime.
- `@crewhelm/design/terminal` provides the canonical CLI banner and semantic RGB roles.

The package owns static assets and semantic roles. Each runtime continues to own document
rendering, escaping, response headers, content security policy, forms, and interaction behavior.

Extend existing semantic tokens and component classes before adding a new primitive. Add
framework-specific exports only when a real application needs them; do not make the foundation
package depend on React, a browser DOM, Node.js, or a terminal library.
