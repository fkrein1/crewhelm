import {
  CREWHELM_CLI_BANNER,
  CREWHELM_LOGO_PROMPT,
  CREWHELM_LOGO_WORDMARK,
  crewhelmTerminalTheme,
} from "@crewhelm/design/terminal";
import { Chalk } from "chalk";

export const CLI_BANNER = CREWHELM_CLI_BANNER;

type CliTextFormatter = (text: string) => string;

export interface CliTextStyle {
  accent: CliTextFormatter;
  accentStrong: CliTextFormatter;
  logoPrompt: CliTextFormatter;
  logoWordmark: CliTextFormatter;
  muted: CliTextFormatter;
  negativeStrong: CliTextFormatter;
  positiveStrong: CliTextFormatter;
  strong: CliTextFormatter;
  warning: CliTextFormatter;
  warningStrong: CliTextFormatter;
}

export function createCliTextStyle(color: boolean): CliTextStyle {
  const style = new Chalk({ level: color ? 3 : 0 });
  const accent = style.rgb(...crewhelmTerminalTheme.accent);
  const warning = style.rgb(...crewhelmTerminalTheme.warning);

  return {
    accent,
    accentStrong: accent.bold,
    logoPrompt: style.rgb(...crewhelmTerminalTheme.logoPrompt),
    logoWordmark: style.rgb(...crewhelmTerminalTheme.logoWordmark),
    muted: style.dim,
    negativeStrong: style.rgb(...crewhelmTerminalTheme.negative).bold,
    positiveStrong: style.rgb(...crewhelmTerminalTheme.positive).bold,
    strong: style.bold,
    warning,
    warningStrong: warning.bold,
  };
}

function styledBanner(style: CliTextStyle): string {
  return `${style.logoPrompt(CREWHELM_LOGO_PROMPT)} ${style.logoWordmark(CREWHELM_LOGO_WORDMARK)}\n`;
}

export interface CliPresentationOptions {
  color: boolean;
  interactive: boolean;
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

export interface CliPresentation {
  accent: (text: string) => string;
  banner: () => void;
  muted: (text: string) => string;
  progress: (message: string) => void;
  status: (status: "pass" | "fail" | "skip") => string;
}

export function createCliPresentation(options: CliPresentationOptions): CliPresentation {
  const style = createCliTextStyle(options.color);

  return {
    accent: style.accent,
    banner: () => {
      if (options.interactive) {
        options.writeOutput(`${styledBanner(style)}\n`);
      }
    },
    muted: style.muted,
    progress: (message) => {
      if (options.interactive) {
        options.writeError(`${style.accent("==>")} ${message}\n`);
      }
    },
    status: (status) =>
      status === "pass"
        ? style.positiveStrong("PASS")
        : status === "fail"
          ? style.negativeStrong("FAIL")
          : style.warningStrong("SKIP"),
  };
}
