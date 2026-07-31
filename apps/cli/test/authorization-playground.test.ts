import { request as httpRequest } from "node:http";

import { describe, expect, it } from "vitest";

import {
  authorizationPlaygroundUrl,
  renderAuthorizationPlaygroundIndex,
  startAuthorizationPlayground,
} from "../src/authorization-playground.js";
import {
  CLI_AUTHORIZATION_PLAYGROUND_PAGES,
  CLI_AUTHORIZATION_PLAYGROUND_STYLES,
} from "../src/authorization-playground-pages.js";

function requestWithHost(url: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host },
        hostname: url.hostname,
        path: url.pathname,
        port: url.port,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    request.once("error", reject);
    request.end();
  });
}

describe("authorization UI playground", () => {
  it("uses the canonical Host value for default and non-default ports", () => {
    expect(authorizationPlaygroundUrl(80).host).toBe("127.0.0.1");
    expect(authorizationPlaygroundUrl(4_173).host).toBe("127.0.0.1:4173");
  });

  it("indexes every fixture-only production authorization view", () => {
    const index = renderAuthorizationPlaygroundIndex(CLI_AUTHORIZATION_PLAYGROUND_PAGES);

    expect(CLI_AUTHORIZATION_PLAYGROUND_PAGES).toHaveLength(4);
    expect(new Set(CLI_AUTHORIZATION_PLAYGROUND_PAGES.map((page) => page.path)).size).toBe(
      CLI_AUTHORIZATION_PLAYGROUND_PAGES.length,
    );
    expect(index).toContain("4 fixture-only production views");

    for (const page of CLI_AUTHORIZATION_PLAYGROUND_PAGES) {
      expect(index).toContain(`src="${page.path}"`);
      expect(page.html).toContain("<!doctype html>");
      expect(page.html).toContain('class="ch-brand__mark"');
      expect(page.html).not.toContain("signed-secret");
    }
  });

  it("serves raw pages and inert actions from one exact loopback host", async () => {
    const playground = await startAuthorizationPlayground({
      actionsScript: "",
      pages: CLI_AUTHORIZATION_PLAYGROUND_PAGES,
      port: 0,
      styles: CLI_AUTHORIZATION_PLAYGROUND_STYLES,
    });

    try {
      const index = await fetch(playground.url);
      const stylesheet = await fetch(new URL("/oauth/styles.css", playground.url));
      const action = await fetch(new URL("/playground/noop", playground.url), { method: "POST" });

      expect(index.status).toBe(200);
      expect(index.headers.get("content-security-policy")).toContain("form-action 'self'");
      expect(await index.text()).toContain("Authorization UI playground");
      expect(stylesheet.status).toBe(200);
      expect(await stylesheet.text()).toContain(".ch-brand__mark");
      expect(action.status).toBe(204);

      for (const page of CLI_AUTHORIZATION_PLAYGROUND_PAGES) {
        const response = await fetch(new URL(page.path, playground.url));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await response.text()).toBe(page.html);
      }

      expect(await requestWithHost(playground.url, "localhost")).toBe(404);
    } finally {
      await playground.close();
    }
  });
});
