import { CREWHELM_LOGO_PROMPT, CREWHELM_LOGO_WORDMARK } from "./brand.js";

export type CrewhelmRgbColor = readonly [red: number, green: number, blue: number];

export const crewhelmTerminalTheme = {
  accent: [48, 126, 224],
  logoPrompt: [48, 126, 224],
  logoWordmark: [94, 165, 245],
  negative: [236, 106, 118],
  positive: [107, 216, 143],
  warning: [233, 180, 76],
} as const satisfies Record<string, CrewhelmRgbColor>;

export const CREWHELM_CLI_MARK_TOP = "┌────┐";
export const CREWHELM_CLI_MARK_MIDDLE = `│ ${CREWHELM_LOGO_PROMPT}`;
export const CREWHELM_CLI_MARK_BOTTOM = "└────┘";
export const CREWHELM_CLI_BANNER = `${CREWHELM_CLI_MARK_TOP}\n${CREWHELM_CLI_MARK_MIDDLE} ${CREWHELM_LOGO_WORDMARK}\n${CREWHELM_CLI_MARK_BOTTOM}\n`;

export { CREWHELM_LOGO_PROMPT, CREWHELM_LOGO_WORDMARK };
