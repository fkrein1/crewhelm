export interface CrewhelmColorTheme {
  readonly accent: string;
  readonly accentContrast: string;
  readonly accentSoft: string;
  readonly accentStrong: string;
  readonly border: string;
  readonly borderStrong: string;
  readonly canvas: string;
  readonly canvasRaised: string;
  readonly negative: string;
  readonly negativeSoft: string;
  readonly positive: string;
  readonly positiveSoft: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceSubtle: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textSecondary: string;
  readonly warning: string;
  readonly warningSoft: string;
}

export const crewhelmColorScales = {
  danger: {
    50: "oklch(0.97 0.02 25)",
    100: "oklch(0.93 0.04 25)",
    200: "oklch(0.86 0.075 25)",
    300: "oklch(0.77 0.12 25)",
    400: "oklch(0.67 0.16 25)",
    500: "oklch(0.58 0.17 25)",
    600: "oklch(0.5 0.15 25)",
    700: "oklch(0.43 0.125 25)",
    800: "oklch(0.36 0.1 25)",
    900: "oklch(0.31 0.075 25)",
    950: "oklch(0.21 0.05 25)",
  },
  ink: {
    50: "oklch(0.985 0.004 255)",
    100: "oklch(0.955 0.007 255)",
    200: "oklch(0.9 0.012 255)",
    300: "oklch(0.82 0.018 255)",
    400: "oklch(0.68 0.025 255)",
    500: "oklch(0.55 0.03 255)",
    600: "oklch(0.45 0.032 255)",
    700: "oklch(0.36 0.03 255)",
    800: "oklch(0.28 0.027 255)",
    900: "oklch(0.22 0.024 255)",
    950: "oklch(0.18 0.022 255)",
  },
  paper: {
    50: "oklch(0.992 0.004 95)",
    100: "oklch(0.96 0.009 95)",
    200: "oklch(0.925 0.011 95)",
    300: "oklch(0.865 0.014 95)",
    400: "oklch(0.72 0.017 95)",
    500: "oklch(0.57 0.018 95)",
    600: "oklch(0.45 0.017 95)",
    700: "oklch(0.35 0.015 95)",
    800: "oklch(0.26 0.012 95)",
    900: "oklch(0.2 0.009 95)",
    950: "oklch(0.145 0.006 95)",
  },
  signal: {
    50: "oklch(0.97 0.02 255)",
    100: "oklch(0.93 0.04 255)",
    200: "oklch(0.87 0.08 255)",
    300: "oklch(0.78 0.13 255)",
    400: "oklch(0.68 0.18 255)",
    500: "oklch(0.59 0.21 255)",
    600: "oklch(0.53 0.2 255)",
    700: "oklch(0.46 0.18 255)",
    800: "oklch(0.4 0.15 255)",
    900: "oklch(0.35 0.11 255)",
    950: "oklch(0.24 0.07 255)",
  },
  success: {
    50: "oklch(0.97 0.025 155)",
    100: "oklch(0.93 0.05 155)",
    200: "oklch(0.86 0.09 155)",
    300: "oklch(0.76 0.13 155)",
    400: "oklch(0.66 0.15 155)",
    500: "oklch(0.57 0.14 155)",
    600: "oklch(0.49 0.12 155)",
    700: "oklch(0.41 0.1 155)",
    800: "oklch(0.34 0.08 155)",
    900: "oklch(0.29 0.06 155)",
    950: "oklch(0.2 0.04 155)",
  },
  warning: {
    50: "oklch(0.98 0.025 80)",
    100: "oklch(0.94 0.06 80)",
    200: "oklch(0.88 0.11 80)",
    300: "oklch(0.8 0.15 75)",
    400: "oklch(0.71 0.16 70)",
    500: "oklch(0.62 0.15 65)",
    600: "oklch(0.53 0.135 60)",
    700: "oklch(0.45 0.115 55)",
    800: "oklch(0.38 0.09 50)",
    900: "oklch(0.32 0.07 48)",
    950: "oklch(0.22 0.045 45)",
  },
} as const;

export const crewhelmColorThemes = {
  dark: {
    accent: crewhelmColorScales.signal[400],
    accentContrast: crewhelmColorScales.ink[950],
    accentSoft: `color-mix(in oklch, ${crewhelmColorScales.signal[400]} 12%, transparent)`,
    accentStrong: crewhelmColorScales.signal[300],
    border: crewhelmColorScales.ink[700],
    borderStrong: crewhelmColorScales.ink[300],
    canvas: crewhelmColorScales.ink[950],
    canvasRaised: crewhelmColorScales.ink[950],
    negative: crewhelmColorScales.danger[400],
    negativeSoft: crewhelmColorScales.danger[950],
    positive: crewhelmColorScales.success[400],
    positiveSoft: crewhelmColorScales.success[950],
    surface: crewhelmColorScales.ink[900],
    surfaceRaised: crewhelmColorScales.ink[800],
    surfaceSubtle: crewhelmColorScales.ink[950],
    text: crewhelmColorScales.paper[100],
    textMuted: crewhelmColorScales.ink[400],
    textSecondary: crewhelmColorScales.ink[300],
    warning: crewhelmColorScales.warning[400],
    warningSoft: crewhelmColorScales.warning[950],
  },
  light: {
    accent: crewhelmColorScales.signal[600],
    accentContrast: "#fff",
    accentSoft: crewhelmColorScales.signal[50],
    accentStrong: crewhelmColorScales.signal[700],
    border: crewhelmColorScales.ink[300],
    borderStrong: crewhelmColorScales.ink[950],
    canvas: crewhelmColorScales.paper[100],
    canvasRaised: crewhelmColorScales.paper[100],
    negative: crewhelmColorScales.danger[700],
    negativeSoft: crewhelmColorScales.danger[100],
    positive: crewhelmColorScales.success[700],
    positiveSoft: crewhelmColorScales.success[100],
    surface: crewhelmColorScales.paper[50],
    surfaceRaised: crewhelmColorScales.paper[100],
    surfaceSubtle: crewhelmColorScales.paper[200],
    text: crewhelmColorScales.ink[950],
    textMuted: crewhelmColorScales.ink[600],
    textSecondary: crewhelmColorScales.ink[700],
    warning: crewhelmColorScales.warning[700],
    warningSoft: crewhelmColorScales.warning[100],
  },
} as const satisfies Record<"dark" | "light", CrewhelmColorTheme>;

export const crewhelmFoundationTokens = {
  font: {
    mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
  },
  radius: {
    large: "0",
    medium: "0",
    small: "0",
  },
  space: {
    1: "4px",
    2: "8px",
    3: "12px",
    4: "16px",
    5: "20px",
    6: "24px",
    8: "32px",
    10: "40px",
  },
} as const;
