# Crewhelm brand

**Give Agents a mandate, not a master key.**

Crewhelm makes autonomy useful, authority legible, and control recoverable.

## Principles

- **Owner control.** Run in the owner’s infrastructure. Never become another principal.
- **Bounded autonomy.** Routine work moves. Authority crossings stop with context.
- **Legible authority.** Show the exact revision, grant, budget, decision, and custody.
- **Recoverable operations.** Deny, revoke, retry, and resume without ambiguity.

## Voice

Calm. Direct. Exact.

Lead with the outcome. Name the boundary. Give the next action. Prefer concrete verbs: create,
grant, approve, deny, run, stop, inspect, retry, revoke.

No hype. No magic. No vague success or failure. Never expose secrets to sound specific.

## Visual system

An editorial operations manual: warm paper, near-black ink, signal blue, hard rules, square
geometry, bold sans headings, mono operational detail, restrained serif emphasis.

Color carries meaning. Blue is control. Green is allowed. Amber is approval. Red is denied.

Use `@crewhelm/design/theme.css`. Extend tokens before inventing local values.

### Logo

The Crewhelm mark places a signal square inside four boundary corners. The signal is ready to act;
the separated frame makes its limits legible. Preserve the supplied square geometry and never add a
shield, lock, rounded app tile, gradient, stroke, shadow, or glow.

Use the explicit light-background and dark-background assets from `@crewhelm/design/assets/*`. The
light variant uses `ink-950` with a `signal-600` center; the dark variant uses `paper-100` with a
`signal-400` center. Keep both transparent 1024px PNG and SVG masters unchanged. Use their derived
SVG or PNG sizes for favicons, navigation, authorization, and other compact UI.

The wordmark remains `CREWHELM`. Browser marks and favicons follow the user’s color scheme. The CLI
uses the terminal’s adaptive foreground for the four corners and signal blue for the center.

## Surface test

Every surface must answer:

1. What can the owner do?
2. What authority is used?
3. Where does custody sit?
4. What happens next?
