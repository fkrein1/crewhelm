import { CREWHELM_LOGO_PROMPT, CREWHELM_LOGO_TEXT, CREWHELM_LOGO_WORDMARK } from "./brand.js";

export type CrewhelmRgbColor = readonly [red: number, green: number, blue: number];

export const crewhelmTerminalTheme = {
  accent: [100, 168, 255],
  logoPrompt: [100, 168, 255],
  logoWordmark: [10, 132, 255],
  negative: [236, 106, 118],
  positive: [107, 216, 143],
  warning: [233, 180, 76],
} as const satisfies Record<string, CrewhelmRgbColor>;

export const CREWHELM_CLI_BANNER = `${CREWHELM_LOGO_TEXT}\n`;

export { CREWHELM_LOGO_PROMPT, CREWHELM_LOGO_WORDMARK };
