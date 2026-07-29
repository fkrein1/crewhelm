import { Chalk } from "chalk";

export const CLI_BANNER = `  ________  _____      ____ ________   __  ___
 / ___/ _ \\/ __/ | /| / / // / __/ /  /  |/  /
/ /__/ , _/ _/ | |/ |/ / _  / _// /__/ /|_/ /
\\___/_/|_/___/ |__/|__/_//_/___/____/_/  /_/
`;

const BANNER_GRADIENT = [
  [34, 211, 238],
  [45, 174, 240],
  [79, 128, 242],
  [99, 102, 241],
] as const;

function gradientBanner(color: boolean): string {
  if (!color) {
    return CLI_BANNER;
  }

  const style = new Chalk({ level: 3 });
  return CLI_BANNER.split("\n")
    .map((line, index) => {
      const [red, green, blue] = BANNER_GRADIENT[index] ?? BANNER_GRADIENT.at(-1)!;
      return style.rgb(red, green, blue)(line);
    })
    .join("\n");
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
  const style = new Chalk({ level: options.color ? 1 : 0 });

  return {
    accent: style.cyan,
    banner: () => {
      if (options.interactive) {
        options.writeOutput(`${gradientBanner(options.color)}\n`);
      }
    },
    muted: style.dim,
    progress: (message) => {
      if (options.interactive) {
        options.writeError(`${style.cyan("==>")} ${message}\n`);
      }
    },
    status: (status) =>
      status === "pass"
        ? style.green.bold("PASS")
        : status === "fail"
          ? style.red.bold("FAIL")
          : style.yellow.bold("SKIP"),
  };
}
