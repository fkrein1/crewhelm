import {
  CREWHELM_CLI_BANNER,
  CREWHELM_CLI_MARK_BOTTOM,
  CREWHELM_CLI_MARK_MIDDLE,
  CREWHELM_CLI_MARK_TOP,
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
  return `${style.logoPrompt(CREWHELM_CLI_MARK_TOP)}\n${style.logoPrompt(CREWHELM_CLI_MARK_MIDDLE)} ${style.logoWordmark(CREWHELM_LOGO_WORDMARK)}\n${style.logoPrompt(CREWHELM_CLI_MARK_BOTTOM)}\n`;
}

export interface CliPresentationOptions {
  color: boolean;
  interactive: boolean;
  liveProgress?: boolean;
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

export interface CliPresentation {
  accent: (text: string) => string;
  banner: () => void;
  heading: (text: string) => string;
  muted: (text: string) => string;
  progress: (activity: { label: string; message: string }) => void;
  result: (status: "pass" | "fail" | "skip", message: string) => void;
  status: (status: "pass" | "fail" | "skip") => string;
  stopProgress: () => void;
  strong: (text: string) => string;
  waiting: (heading: string, message: string) => void;
  warning: (text: string) => string;
}

export function createCliPresentation(options: CliPresentationOptions): CliPresentation {
  const style = createCliTextStyle(options.color);
  const liveProgress = options.liveProgress ?? options.interactive;
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  const clearLine = "\r\u001B[2K";
  let active: { frame: number; label: string; message: string; startedAt: number } | undefined;
  let spinner: ReturnType<typeof setInterval> | undefined;

  const renderProgress = () => {
    if (!active) {
      return;
    }

    const elapsedSeconds = Math.floor((Date.now() - active.startedAt) / 1_000);
    const elapsed = elapsedSeconds > 0 ? style.muted(`  ${elapsedSeconds}s`) : "";
    const frame = spinnerFrames[active.frame % spinnerFrames.length] ?? spinnerFrames[0];

    options.writeError(
      `${clearLine}${style.accent(frame)} ${style.strong(active.label)} ${style.muted("·")} ${active.message}${elapsed}`,
    );
    active.frame += 1;
  };

  const stopProgress = () => {
    if (spinner) {
      clearInterval(spinner);
      spinner = undefined;
    }

    if (active) {
      active = undefined;
      options.writeError(clearLine);
    }
  };

  const status = (value: "pass" | "fail" | "skip") =>
    value === "pass"
      ? style.positiveStrong("PASS")
      : value === "fail"
        ? style.negativeStrong("FAIL")
        : style.warningStrong("SKIP");

  return {
    accent: style.accent,
    banner: () => {
      if (options.interactive) {
        options.writeOutput(`${styledBanner(style)}\n`);
      }
    },
    heading: style.accentStrong,
    muted: style.muted,
    progress: ({ label, message }) => {
      if (!liveProgress) {
        return;
      }

      const changed = active?.label !== label || active.message !== message;
      active = {
        frame: changed ? 0 : (active?.frame ?? 0),
        label,
        message,
        startedAt: changed ? Date.now() : (active?.startedAt ?? Date.now()),
      };
      renderProgress();

      if (!spinner) {
        spinner = setInterval(renderProgress, 80);
        spinner.unref?.();
      }
    },
    result: (value, message) => {
      stopProgress();
      options.writeOutput(`${status(value)} ${message}\n`);
    },
    status,
    stopProgress,
    strong: style.strong,
    waiting: (heading, message) => {
      stopProgress();
      options.writeOutput(
        `${style.warningStrong("WAITING")} ${style.strong(heading)}\n${message}\n\n`,
      );
    },
    warning: style.warning,
  };
}
