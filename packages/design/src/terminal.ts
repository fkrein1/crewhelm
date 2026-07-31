import { CREWHELM_LOGO_WORDMARK } from "./brand.js";

export type CrewhelmRgbColor = readonly [red: number, green: number, blue: number];

export const crewhelmTerminalTheme = {
  accent: [48, 126, 224],
  logoAccent: [48, 126, 224],
  negative: [236, 106, 118],
  positive: [107, 216, 143],
  warning: [233, 180, 76],
} as const satisfies Record<string, CrewhelmRgbColor>;

export const CREWHELM_CLI_MARK_ACCENT = "■";
export const CREWHELM_CLI_BANNER = `  ${CREWHELM_CLI_MARK_ACCENT} ${CREWHELM_LOGO_WORDMARK}\n`;

export { CREWHELM_LOGO_WORDMARK };
