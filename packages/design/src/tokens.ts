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
    accent: "#64a8ff",
    accentContrast: "#07111f",
    accentSoft: "rgb(100 168 255 / 10%)",
    accentStrong: "#0a84ff",
    border: "#2c2e35",
    borderStrong: "#3b3e47",
    canvas: "#0e0f12",
    canvasRaised: "#121318",
    negative: "#ec6a76",
    negativeSoft: "rgb(251 113 133 / 10%)",
    positive: "#6bd88f",
    positiveSoft: "rgb(74 222 128 / 10%)",
    shadowPanel: "0 18px 42px rgb(0 0 0 / 24%)",
    surface: "#191a20",
    surfaceRaised: "#202127",
    surfaceSubtle: "#15161b",
    text: "#f2f2f4",
    textMuted: "#82858f",
    textSecondary: "#a4a6ad",
    warning: "#e9b44c",
    warningSoft: "rgb(251 191 36 / 10%)",
  },
  light: {
    accent: "#0a72d8",
    accentContrast: "#ffffff",
    accentSoft: "rgb(10 114 216 / 9%)",
    accentStrong: "#075fb5",
    border: "#d6dde7",
    borderStrong: "#bbc5d3",
    canvas: "#e9edf2",
    canvasRaised: "#f5f7fa",
    negative: "#be123c",
    negativeSoft: "rgb(190 18 60 / 8%)",
    positive: "#15803d",
    positiveSoft: "rgb(21 128 61 / 9%)",
    shadowPanel: "0 24px 65px rgb(42 52 70 / 16%)",
    surface: "#ffffff",
    surfaceRaised: "#f7f9fc",
    surfaceSubtle: "#eef2f6",
    text: "#111723",
    textMuted: "#657489",
    textSecondary: "#4e5d70",
    warning: "#a16207",
    warningSoft: "rgb(161 98 7 / 9%)",
  },
} as const satisfies Record<"dark" | "light", CrewhelmColorTheme>;

export const crewhelmFoundationTokens = {
  font: {
    mono: '"SFMono-Regular", "Cascadia Code", "Roboto Mono", Consolas, monospace',
    sans: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  radius: {
    large: "16px",
    medium: "10px",
    small: "6px",
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
