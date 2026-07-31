import { describe, expect, it } from "vitest";

import {
  WORKER_AUTHORIZATION_PLAYGROUND_ACTIONS_SCRIPT,
  WORKER_AUTHORIZATION_PLAYGROUND_PAGES,
  WORKER_AUTHORIZATION_PLAYGROUND_STYLES,
} from "./authorization-playground-pages.js";

describe("Worker authorization playground pages", () => {
  it("provides every OAuth and connection-return fixture through production renderers", () => {
    expect(WORKER_AUTHORIZATION_PLAYGROUND_PAGES).toHaveLength(9);
    expect(new Set(WORKER_AUTHORIZATION_PLAYGROUND_PAGES.map((page) => page.path)).size).toBe(
      WORKER_AUTHORIZATION_PLAYGROUND_PAGES.length,
    );
    expect(WORKER_AUTHORIZATION_PLAYGROUND_STYLES).toContain(".ch-brand__mark");
    expect(WORKER_AUTHORIZATION_PLAYGROUND_ACTIONS_SCRIPT).toContain("data-consent-form");

    for (const page of WORKER_AUTHORIZATION_PLAYGROUND_PAGES) {
      expect(page.html).toContain("<!doctype html>");
      expect(page.html).toContain('class="ch-brand__mark"');
      expect(page.html).not.toContain("signed-secret");
    }
  });
});
