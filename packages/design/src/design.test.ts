import { describe, expect, it } from "vitest";

import { CREWHELM_BRAND_PROMISE, CREWHELM_LOGO_TEXT } from "./brand.js";
import { CREWHELM_CLI_BANNER, crewhelmTerminalTheme } from "./terminal.js";
import { CREWHELM_COMPACT_BRAND_HTML, CREWHELM_WEB_STYLES } from "./web.js";

describe("Crewhelm design foundation", () => {
  it("defines one accessible compact brand for browser and terminal surfaces", () => {
    expect(CREWHELM_LOGO_TEXT).toBe(">_ CREWHELM");
    expect(CREWHELM_BRAND_PROMISE).toBe("Give Agents a mandate. Not a master key.");
    expect(CREWHELM_CLI_BANNER).toBe(">_ CREWHELM\n");
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain('role="img" aria-label="Crewhelm"');
    expect(CREWHELM_COMPACT_BRAND_HTML).toContain("&gt;_");
    expect(crewhelmTerminalTheme.logoPrompt).toEqual([48, 126, 224]);
    expect(crewhelmTerminalTheme.logoWordmark).toEqual([94, 165, 245]);
  });

  it("provides bounded, responsive, theme-aware web foundations", () => {
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-canvas: #f2f0e9");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-accent-contrast: #ffffff");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-text-muted: #929aa6");
    expect(CREWHELM_WEB_STYLES).toContain("--ch-color-text-muted: #626874");
    expect(CREWHELM_WEB_STYLES).toContain(':root[data-theme="light"]');
    expect(CREWHELM_WEB_STYLES).toContain("@media (prefers-color-scheme: dark)");
    expect(CREWHELM_WEB_STYLES).toContain("@media (prefers-reduced-motion: reduce)");
    expect(CREWHELM_WEB_STYLES).toContain('.ch-button[aria-disabled="true"]');
    expect(CREWHELM_WEB_STYLES.length).toBeLessThan(16_000);
  });
});
