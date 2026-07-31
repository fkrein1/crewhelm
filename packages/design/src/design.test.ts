import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { CREWHELM_BRAND_PROMISE, CREWHELM_LOGO_MARK_PATHS } from "./brand.js";
import { CREWHELM_CLI_BANNER, crewhelmTerminalTheme } from "./terminal.js";
import { crewhelmColorScales } from "./tokens.js";
import { CREWHELM_COMPACT_BRAND_HTML, CREWHELM_WEB_STYLES } from "./web.js";

function clampChannel(channel: number): number {
  return Math.max(0, Math.min(1, channel));
}

function oklchLuminance(color: string): number {
  const match = /^oklch\((\S+) (\S+) (\S+)\)$/.exec(color);
  if (!match) throw new Error(`Expected an OKLCH color, received ${color}.`);

  const lightness = Number(match[1]);
  const chroma = Number(match[2]);
  const hue = (Number(match[3]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const linearL = (lightness + 0.396_337_777_4 * a + 0.215_803_757_3 * b) ** 3;
  const linearM = (lightness - 0.105_561_345_8 * a - 0.063_854_172_8 * b) ** 3;
  const linearS = (lightness - 0.089_484_177_5 * a - 1.291_485_548 * b) ** 3;
  const red = 4.076_741_662_1 * linearL - 3.307_711_591_3 * linearM + 0.230_969_929_2 * linearS;
  const green = -1.268_438_004_6 * linearL + 2.609_757_401_1 * linearM - 0.341_319_396_5 * linearS;
  const blue = -0.004_196_086_3 * linearL - 0.703_418_614_7 * linearM + 1.707_614_701 * linearS;

  return 0.2126 * clampChannel(red) + 0.7152 * clampChannel(green) + 0.0722 * clampChannel(blue);
}

function contrastRatio(first: number, second: number): number {
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

describe("Crewhelm design foundation", () => {
  it("defines one accessible compact brand for browser and terminal surfaces", () => {
    expect(CREWHELM_BRAND_PROMISE).toBe("Give Agents a mandate. Not a master key.");
    expect(CREWHELM_CLI_BANNER).toBe("┌  ┐\n ■   CREWHELM\n└  ┘\n");
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain('role="img" aria-label="Crewhelm"');
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain('class="ch-brand__mark"');
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain('class="ch-brand__mark-frame"');
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain('class="ch-brand__mark-accent"');
    for (const path of Object.values(CREWHELM_LOGO_MARK_PATHS)) {
      expect(CREWHELM_COMPACT_BRAND_HTML).toContain(`d="${path}"`);
    }
    expect(crewhelmTerminalTheme.logoAccent).toEqual([48, 126, 224]);
  });

  it("ships synchronized vector and raster brand assets", async () => {
    const mark = await readFile(new URL("../assets/crewhelm-mark.svg", import.meta.url));
    const favicon = await readFile(new URL("../assets/crewhelm-favicon.svg", import.meta.url));
    const lightMaster = await readFile(
      new URL("../assets/crewhelm-logo-light.svg", import.meta.url),
    );
    const darkMaster = await readFile(new URL("../assets/crewhelm-logo-dark.svg", import.meta.url));
    const lightHighResolutionPng = await readFile(
      new URL("../assets/crewhelm-logo-light.png", import.meta.url),
    );
    const darkHighResolutionPng = await readFile(
      new URL("../assets/crewhelm-logo-dark.png", import.meta.url),
    );
    const siteFavicon = await readFile(
      new URL("../../../apps/site/public/favicon.svg", import.meta.url),
    );
    const siteMark = await readFile(
      new URL("../../../apps/site/public/crewhelm-mark.svg", import.meta.url),
    );

    for (const path of Object.values(CREWHELM_LOGO_MARK_PATHS)) {
      expect(mark.toString()).toContain(`d="${path}"`);
    }

    expect(siteFavicon).toEqual(favicon);
    expect(siteMark).toEqual(mark);
    expect(favicon).toEqual(mark);
    expect(createHash("sha256").update(lightMaster).digest("hex")).toBe(
      "1b3b315ab3edea768a1077152c12d6ddb24cae6431e21b95e4f707bcaf650f1f",
    );
    expect(createHash("sha256").update(darkMaster).digest("hex")).toBe(
      "5aa372c7fbbf79d59e439ade5df5edeadc04eeed0f49ce817141d6a7555f430f",
    );
    expect(createHash("sha256").update(lightHighResolutionPng).digest("hex")).toBe(
      "90ed2f38f6aa9dca41e05cfb2fb39c561136a9ec10bd5f9793e2afccb5c4c975",
    );
    expect(createHash("sha256").update(darkHighResolutionPng).digest("hex")).toBe(
      "7feb7725441f7396e307344b8dd035eb1d40cadc8e94fa14c28e007def18de0a",
    );

    for (const master of [lightMaster, darkMaster]) {
      expect(master.toString()).toContain('viewBox="0 0 1024 1024"');
    }

    for (const highResolutionPng of [lightHighResolutionPng, darkHighResolutionPng]) {
      expect(highResolutionPng.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(highResolutionPng.readUInt32BE(16)).toBe(1024);
      expect(highResolutionPng.readUInt32BE(20)).toBe(1024);
      expect(highResolutionPng[25]).toBe(6);
    }

    for (const variant of ["light", "dark"] as const) {
      const variantMark = await readFile(
        new URL(`../assets/crewhelm-mark-${variant}.svg`, import.meta.url),
      );
      const variantFavicon = await readFile(
        new URL(`../assets/crewhelm-favicon-${variant}.svg`, import.meta.url),
      );
      const siteVariantMark = await readFile(
        new URL(`../../../apps/site/public/crewhelm-mark-${variant}.svg`, import.meta.url),
      );
      const siteVariantFavicon = await readFile(
        new URL(`../../../apps/site/public/favicon-${variant}.svg`, import.meta.url),
      );

      expect(variantFavicon).toEqual(variantMark);
      expect(siteVariantMark).toEqual(variantMark);
      expect(siteVariantFavicon).toEqual(variantFavicon);

      for (const size of [32, 64, 128, 256, 512] as const) {
        const png = await readFile(
          new URL(`../assets/crewhelm-mark-${variant}-${size}.png`, import.meta.url),
        );
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.readUInt32BE(16)).toBe(size);
        expect(png.readUInt32BE(20)).toBe(size);
      }

      for (const size of [32, 180] as const) {
        const png = await readFile(
          new URL(`../assets/crewhelm-favicon-${variant}-${size}.png`, import.meta.url),
        );
        const sitePng = await readFile(
          new URL(
            size === 32
              ? `../../../apps/site/public/favicon-${variant}-32.png`
              : `../../../apps/site/public/apple-touch-icon-${variant}.png`,
            import.meta.url,
          ),
        );

        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.readUInt32BE(16)).toBe(size);
        expect(png.readUInt32BE(20)).toBe(size);
        expect(sitePng).toEqual(png);
      }
    }
  });

  it("keeps the Tailwind theme synchronized with renderer-neutral color scales", async () => {
    const theme = await readFile(new URL("./theme.css", import.meta.url), "utf8");

    for (const [name, scale] of Object.entries(crewhelmColorScales)) {
      for (const [step, value] of Object.entries(scale)) {
        expect(theme).toContain(`--color-${name}-${step}: ${value};`);
      }
    }

    expect(theme).toContain("@theme inline");
    expect(theme).toContain("--color-background: var(--background)");
    expect(theme).toContain("--color-primary: var(--primary)");
    expect(theme).toContain("@media (prefers-color-scheme: dark)");
    expect(theme).not.toContain("data-theme");
    expect(theme).toContain("--color-inverse: var(--inverse)");
  });

  it("keeps semantic text pairs above WCAG AA contrast", () => {
    const pairs = [
      [crewhelmColorScales.paper[100], crewhelmColorScales.ink[950]],
      [crewhelmColorScales.paper[200], crewhelmColorScales.ink[600]],
      [crewhelmColorScales.success[100], crewhelmColorScales.success[700]],
      [crewhelmColorScales.warning[100], crewhelmColorScales.warning[700]],
      [crewhelmColorScales.danger[100], crewhelmColorScales.danger[700]],
      [crewhelmColorScales.ink[950], crewhelmColorScales.paper[100]],
      [crewhelmColorScales.ink[800], crewhelmColorScales.ink[300]],
      [crewhelmColorScales.signal[400], crewhelmColorScales.ink[950]],
    ] as const;

    for (const [background, foreground] of pairs) {
      expect(
        contrastRatio(oklchLuminance(background), oklchLuminance(foreground)),
      ).toBeGreaterThanOrEqual(4.5);
    }

    expect(
      contrastRatio(1, oklchLuminance(crewhelmColorScales.signal[600])),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("provides bounded, responsive, theme-aware web foundations", () => {
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-canvas: oklch(0.96 0.009 95)");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-logo-frame: #0b121b");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-logo-frame: #f3f2eb");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-accent-contrast: #fff");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-text-muted: oklch(0.68 0.025 255)");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-text-muted: oklch(0.45 0.032 255)");
    expect(CREWHELM_WEB_STYLES).toContain("@media (prefers-color-scheme: dark)");
    expect(CREWHELM_WEB_STYLES).not.toContain("data-theme");
    expect(CREWHELM_WEB_STYLES).toContain("@media (prefers-reduced-motion: reduce)");
    expect(CREWHELM_WEB_STYLES).toContain('.ch-button[aria-disabled="true"]');
    expect(CREWHELM_WEB_STYLES).not.toContain("body.ch-page::before");
    expect(CREWHELM_WEB_STYLES).not.toContain("box-shadow: 10px 10px 0 var(--ch-page-accent)");
    expect(CREWHELM_WEB_STYLES.length).toBeLessThan(16_000);
  });
});
