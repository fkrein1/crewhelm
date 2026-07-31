import { CREWHELM_COMPACT_BRAND_HTML } from "./brand.js";
import {
  crewhelmColorThemes,
  crewhelmFoundationTokens,
  type CrewhelmColorTheme,
} from "./tokens.js";

export type CrewhelmPageTone = "accent" | "negative" | "positive" | "warning";

function themeVariables(theme: CrewhelmColorTheme, indentation = "  "): string {
  return [
    `--ch-color-accent: ${theme.accent};`,
    `--ch-color-accent-contrast: ${theme.accentContrast};`,
    `--ch-color-accent-soft: ${theme.accentSoft};`,
    `--ch-color-accent-strong: ${theme.accentStrong};`,
    `--ch-color-border: ${theme.border};`,
    `--ch-color-border-strong: ${theme.borderStrong};`,
    `--ch-color-canvas: ${theme.canvas};`,
    `--ch-color-canvas-raised: ${theme.canvasRaised};`,
    `--ch-color-negative: ${theme.negative};`,
    `--ch-color-negative-soft: ${theme.negativeSoft};`,
    `--ch-color-positive: ${theme.positive};`,
    `--ch-color-positive-soft: ${theme.positiveSoft};`,
    `--ch-color-surface: ${theme.surface};`,
    `--ch-color-surface-raised: ${theme.surfaceRaised};`,
    `--ch-color-surface-subtle: ${theme.surfaceSubtle};`,
    `--ch-color-text: ${theme.text};`,
    `--ch-color-text-muted: ${theme.textMuted};`,
    `--ch-color-text-secondary: ${theme.textSecondary};`,
    `--ch-color-warning: ${theme.warning};`,
    `--ch-color-warning-soft: ${theme.warningSoft};`,
  ]
    .map((declaration) => `${indentation}${declaration}`)
    .join("\n");
}

const lightThemeVariables = themeVariables(crewhelmColorThemes.light);
const nestedDarkThemeVariables = themeVariables(crewhelmColorThemes.dark, "    ");

export const CREWHELM_WEB_STYLES = `
:root {
  color-scheme: light dark;
${lightThemeVariables}
  --ch-logo-accent: #0067db;
  --ch-logo-frame: #0b121b;
  --ch-font-mono: ${crewhelmFoundationTokens.font.mono};
  --ch-font-sans: ${crewhelmFoundationTokens.font.sans};
  --ch-radius-lg: ${crewhelmFoundationTokens.radius.large};
  --ch-radius-md: ${crewhelmFoundationTokens.radius.medium};
  --ch-radius-sm: ${crewhelmFoundationTokens.radius.small};
  --ch-space-1: ${crewhelmFoundationTokens.space[1]};
  --ch-space-2: ${crewhelmFoundationTokens.space[2]};
  --ch-space-3: ${crewhelmFoundationTokens.space[3]};
  --ch-space-4: ${crewhelmFoundationTokens.space[4]};
  --ch-space-5: ${crewhelmFoundationTokens.space[5]};
  --ch-space-6: ${crewhelmFoundationTokens.space[6]};
  --ch-space-8: ${crewhelmFoundationTokens.space[8]};
  --ch-space-10: ${crewhelmFoundationTokens.space[10]};
  font-family: var(--ch-font-sans);
  color: var(--ch-color-text);
  background: var(--ch-color-canvas);
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
${nestedDarkThemeVariables}
    --ch-logo-accent: #3e98ff;
    --ch-logo-frame: #f3f2eb;
  }
}

* {
  box-sizing: border-box;
}

[hidden] {
  display: none !important;
}

body.ch-page {
  display: grid;
  min-width: 320px;
  min-height: 100vh;
  margin: 0;
  place-items: center;
  padding: clamp(16px, 5vw, 72px);
  background: var(--ch-color-canvas-raised);
}

.ch-panel {
  --ch-page-accent: var(--ch-color-accent);
  width: min(100%, 720px);
  padding: clamp(30px, 6vw, 58px);
  border-radius: var(--ch-radius-md);
  color: var(--ch-color-text);
  background: var(--ch-color-surface);
}

.ch-panel[data-tone="positive"] {
  --ch-page-accent: var(--ch-color-positive);
}

.ch-panel[data-tone="warning"] {
  --ch-page-accent: var(--ch-color-warning);
}

.ch-panel[data-tone="negative"] {
  --ch-page-accent: var(--ch-color-negative);
}

.ch-panel__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ch-space-4);
  margin: 0 0 clamp(42px, 8vw, 72px);
  color: var(--ch-color-text-muted);
  font: 700 9px/1 var(--ch-font-mono);
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.ch-panel__context {
  display: inline-flex;
  align-items: center;
  gap: var(--ch-space-2);
}

.ch-panel__context::before {
  width: 18px;
  height: 1px;
  flex: 0 0 auto;
  background: var(--ch-page-accent);
  content: "";
}

.ch-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  color: var(--ch-color-text);
  font: 800 9px/1 var(--ch-font-mono);
  letter-spacing: 0.08em;
}

.ch-brand__mark {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.ch-brand__mark-frame {
  fill: var(--ch-logo-frame);
}

.ch-brand__mark-accent {
  fill: var(--ch-logo-accent);
}

.ch-brand__wordmark {
  color: inherit;
}

.ch-panel h1 {
  max-width: 610px;
  margin: 0 0 var(--ch-space-6);
  color: var(--ch-color-text);
  font-size: clamp(38px, 8vw, 64px);
  font-weight: 800;
  line-height: .92;
  letter-spacing: -.06em;
}

.ch-copy,
.ch-panel > p {
  margin: 0;
  color: var(--ch-color-text-secondary);
  font-size: 15px;
  line-height: 1.6;
}

.ch-copy + .ch-copy {
  margin-top: var(--ch-space-3);
}

.ch-panel strong {
  color: var(--ch-color-text);
  font-weight: 650;
}

.ch-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ch-space-3);
  margin-top: clamp(30px, 6vw, 48px);
}

.ch-actions form {
  margin: 0;
}

.ch-button {
  display: inline-flex;
  min-height: 50px;
  align-items: center;
  justify-content: center;
  gap: var(--ch-space-2);
  padding: 0 var(--ch-space-5);
  border: 1px solid var(--ch-color-border-strong);
  border-radius: var(--ch-radius-sm);
  color: var(--ch-color-text);
  background: var(--ch-color-surface-raised);
  box-shadow: none;
  font: 800 11px/1 var(--ch-font-mono);
  letter-spacing: .02em;
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 140ms ease,
    transform 140ms ease,
    background 140ms ease;
}

.ch-button:hover {
  border-color: var(--ch-page-accent);
  transform: translateY(-1px);
}

.ch-button:focus-visible {
  outline: 2px solid var(--ch-page-accent);
  outline-offset: 3px;
}

.ch-button:disabled,
.ch-button[aria-disabled="true"] {
  cursor: wait;
  opacity: 0.62;
  transform: none;
  box-shadow: none;
}

.ch-button--primary {
  border-color: var(--ch-color-accent);
  color: var(--ch-color-accent-contrast);
  background: var(--ch-color-accent);
  box-shadow: 5px 5px 0 var(--ch-color-border-strong);
}

.ch-button--quiet {
  color: var(--ch-color-text-secondary);
  background: transparent;
  border-color: transparent;
  text-decoration: underline;
  text-underline-offset: 5px;
}

.ch-permissions {
  display: grid;
  gap: 0;
  margin: var(--ch-space-6) 0 0;
  padding: 0;
  border: 1px solid var(--ch-color-border-strong);
  border-radius: var(--ch-radius-sm);
  background: transparent;
  list-style: none;
}

.ch-permission {
  padding: var(--ch-space-4);
  color: var(--ch-color-text-secondary);
  border-bottom: 1px solid var(--ch-color-border);
  background: var(--ch-color-surface-subtle);
  font-size: 12px;
  line-height: 1.55;
}

.ch-permission:last-child {
  border-bottom: 0;
}

.ch-meta {
  display: grid;
  gap: var(--ch-space-2);
  margin-top: var(--ch-space-5);
  padding-top: var(--ch-space-5);
  border-top: 1px solid var(--ch-color-border-strong);
}

.ch-meta p {
  margin: 0;
  color: var(--ch-color-text-muted);
  font: 10px/1.5 var(--ch-font-mono);
}

.ch-meta code {
  overflow-wrap: anywhere;
  color: var(--ch-color-text-secondary);
  font: inherit;
}

@media (max-width: 560px) {
  body.ch-page {
    padding: var(--ch-space-4);
  }

  .ch-panel {
    padding: 28px 22px 26px;
  }

  .ch-panel__bar {
    align-items: flex-start;
  }

  .ch-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .ch-actions form,
  .ch-button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ch-button {
    transition: none;
  }
}
`.trim();

export { CREWHELM_COMPACT_BRAND_HTML };
