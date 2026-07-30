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
    `--ch-shadow-panel: ${theme.shadowPanel};`,
  ]
    .map((declaration) => `${indentation}${declaration}`)
    .join("\n");
}

const darkThemeVariables = themeVariables(crewhelmColorThemes.dark);
const lightThemeVariables = themeVariables(crewhelmColorThemes.light);
const nestedLightThemeVariables = themeVariables(crewhelmColorThemes.light, "    ");

export const CREWHELM_WEB_STYLES = `
:root {
  color-scheme: dark light;
${darkThemeVariables}
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

:root[data-theme="light"] {
  color-scheme: light;
${lightThemeVariables}
}

:root[data-theme="dark"] {
  color-scheme: dark;
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
${nestedLightThemeVariables}
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
  width: min(100%, 650px);
  overflow: hidden;
  padding: clamp(28px, 5vw, 48px);
  border: 1px solid var(--ch-color-border);
  border-radius: var(--ch-radius-md);
  color: var(--ch-color-text);
  background: var(--ch-color-surface);
  box-shadow: var(--ch-shadow-panel);
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
  margin: calc(var(--ch-space-2) * -1) 0 var(--ch-space-8);
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
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ch-page-accent);
  content: "";
}

.ch-brand {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  color: var(--ch-color-text-muted);
  font: 800 9px/1 var(--ch-font-mono);
  letter-spacing: 0.08em;
}

.ch-brand__prompt {
  color: var(--ch-color-accent);
  letter-spacing: -0.12em;
}

.ch-brand__wordmark {
  color: inherit;
}

.ch-panel h1 {
  max-width: 560px;
  margin: 0 0 var(--ch-space-4);
  color: var(--ch-color-text);
  font-size: clamp(28px, 6vw, 42px);
  font-weight: 650;
  line-height: 1.06;
  letter-spacing: -0.038em;
}

.ch-copy,
.ch-panel > p {
  margin: 0;
  color: var(--ch-color-text-secondary);
  font-size: 14px;
  line-height: 1.65;
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
  margin-top: var(--ch-space-8);
}

.ch-actions form {
  margin: 0;
}

.ch-button {
  display: inline-flex;
  min-height: 42px;
  align-items: center;
  justify-content: center;
  gap: var(--ch-space-2);
  padding: 0 var(--ch-space-4);
  border: 1px solid var(--ch-color-border-strong);
  border-radius: var(--ch-radius-sm);
  color: var(--ch-color-text);
  background: var(--ch-color-surface-raised);
  box-shadow: 0 7px 20px rgb(0 0 0 / 16%);
  font: 650 11px/1 var(--ch-font-mono);
  text-decoration: none;
  cursor: pointer;
  transition:
    border-color 140ms ease,
    transform 140ms ease,
    box-shadow 140ms ease;
}

.ch-button:hover {
  border-color: var(--ch-page-accent);
  transform: translateY(-1px);
  box-shadow: 0 10px 24px rgb(0 0 0 / 22%);
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
  box-shadow: 0 6px 16px rgb(0 0 0 / 18%);
}

.ch-button--quiet {
  color: var(--ch-color-text-secondary);
  background: transparent;
  box-shadow: none;
}

.ch-permissions {
  display: grid;
  gap: 1px;
  margin: var(--ch-space-6) 0 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--ch-color-border);
  border-radius: var(--ch-radius-sm);
  background: var(--ch-color-border);
  list-style: none;
}

.ch-permission {
  padding: var(--ch-space-4);
  color: var(--ch-color-text-secondary);
  background: var(--ch-color-surface-subtle);
  font-size: 12px;
  line-height: 1.55;
}

.ch-meta {
  display: grid;
  gap: var(--ch-space-2);
  margin-top: var(--ch-space-5);
  padding-top: var(--ch-space-5);
  border-top: 1px solid var(--ch-color-border);
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
    padding: 26px 22px 22px;
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
