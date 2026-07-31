# Crewhelm logo assets

Both variants preserve the supplied geometry and have transparent backgrounds. The SVG and
1024×1024 PNG files named `crewhelm-logo-{light,dark}.*` are byte-for-byte source masters.

| Variant | Intended background | Logo foreground                      | Center accent                         |
| ------- | ------------------- | ------------------------------------ | ------------------------------------- |
| Light   | Light               | `ink-950` — `oklch(0.18 0.022 255)`  | `signal-600` — `oklch(0.53 0.2 255)`  |
| Dark    | Dark                | `paper-100` — `oklch(0.96 0.009 95)` | `signal-400` — `oklch(0.68 0.18 255)` |

Use explicit variants when the surface controls its color scheme. `crewhelm-mark.svg` and
`crewhelm-favicon.svg` are adaptive aliases for consumers that support `prefers-color-scheme`.
Raster exports are always named for their color-scheme variant because PNGs cannot adapt by
themselves.
