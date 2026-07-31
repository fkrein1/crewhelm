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
  readonly shadowPanel: string;
  readonly surface: string;
  readonly surfaceRaised: string;
  readonly surfaceSubtle: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textSecondary: string;
  readonly warning: string;
  readonly warningSoft: string;
}

export const crewhelmColorThemes = {
  dark: {
    accent: "#5ea5f5",
    accentContrast: "#07111f",
    accentSoft: "rgb(94 165 245 / 12%)",
    accentStrong: "#78b7ff",
    border: "#3a404b",
    borderStrong: "#aeb7c3",
    canvas: "#10151e",
    canvasRaised: "#10151e",
    negative: "#ec6a76",
    negativeSoft: "rgb(251 113 133 / 10%)",
    positive: "#6bd88f",
    positiveSoft: "rgb(74 222 128 / 10%)",
    shadowPanel: "10px 10px 0 rgb(94 165 245 / 34%)",
    surface: "#161c26",
    surfaceRaised: "#1c2430",
    surfaceSubtle: "#111720",
    text: "#f2f0e9",
    textMuted: "#929aa6",
    textSecondary: "#bcc2ca",
    warning: "#e9b44c",
    warningSoft: "rgb(251 191 36 / 10%)",
  },
  light: {
    accent: "#0768d7",
    accentContrast: "#ffffff",
    accentSoft: "rgb(7 104 215 / 9%)",
    accentStrong: "#064a9b",
    border: "#cdd0cc",
    borderStrong: "#10151e",
    canvas: "#f2f0e9",
    canvasRaised: "#f2f0e9",
    negative: "#a53a36",
    negativeSoft: "#f2dedb",
    positive: "#18764c",
    positiveSoft: "#dceee6",
    shadowPanel: "10px 10px 0 rgb(7 104 215 / 22%)",
    surface: "#fffef9",
    surfaceRaised: "#f7f5ee",
    surfaceSubtle: "#f0eee6",
    text: "#10151e",
    textMuted: "#626874",
    textSecondary: "#414852",
    warning: "#a76100",
    warningSoft: "#f5e8cc",
  },
} as const satisfies Record<"dark" | "light", CrewhelmColorTheme>;

export const crewhelmFoundationTokens = {
  font: {
    mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
