import { request as httpRequest } from "node:http";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import { createGitHubApp } from "../src/github-app.js";

const manifestSchema = z.looseObject({
  redirect_url: z.url(),
});

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function requestWithHost(url: URL, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host },
        hostname: "127.0.0.1",
        path: `${url.pathname}${url.search}`,
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

describe("GitHub App setup", () => {
  it("creates a private zero-permission owner app through a verified loopback callback", async () => {
    const output: string[] = [];
    let manifest: z.infer<typeof manifestSchema> | undefined;
    const fetchConversion = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        client_id: "github-app-client-id",
        client_secret: "github-app-client-secret",
        owner: { id: 123_456, type: "User" },
        pem: "private-key-that-must-be-discarded",
        webhook_secret: "webhook-secret-that-must-be-discarded",
      }),
    );

    const credentials = await createGitHubApp(
      {
        origin: new URL("https://crewhelm.example"),
        workerName: "crewhelm",
      },
      {
        fetch: fetchConversion,
        openUrl: async (setupUrl) => {
          expect(setupUrl.pathname).toMatch(/^\/setup\/[A-Za-z0-9_-]{43}$/);
          const rootResponse = await globalThis.fetch(new URL("/", setupUrl));
          const wrongHostStatus = await requestWithHost(setupUrl, `localhost:${setupUrl.port}`);

          expect(rootResponse.status).toBe(404);
          expect(wrongHostStatus).toBe(404);
          const setupResponse = await globalThis.fetch(setupUrl);
          const body = await setupResponse.text();
          const stylesheet = await globalThis.fetch(new URL("/assets/crewhelm.css", setupUrl));
          const manifestAttribute = body.match(/name="manifest" value="([^"]+)"/)?.[1];
          const action = body.match(/action="([^"]+)"/)?.[1];

          expect(setupResponse.headers.get("content-security-policy")).toContain(
            "style-src 'self'",
          );
          expect(setupResponse.headers.get("content-security-policy")).not.toContain(
            "unsafe-inline",
          );
          expect(body).toContain('href="/assets/crewhelm.css"');
          expect(body).not.toContain("<body style=");
          expect(body).toContain('class="ch-brand" role="img" aria-label="Crewhelm"');
          expect(body).toContain('data-tone="accent"');
          expect(stylesheet.headers.get("cache-control")).toBe("private, max-age=600");
          expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
          expect(await stylesheet.text()).toContain("place-items: center");

          if (!manifestAttribute || !action) {
            throw new Error("Expected GitHub App setup form.");
          }

          manifest = manifestSchema.parse(JSON.parse(decodeAttribute(manifestAttribute)));
          const state = new URL(decodeAttribute(action)).searchParams.get("state");
          const redirectUrl = new URL(manifest.redirect_url);
          const invalidCallbackUrl = new URL(redirectUrl);

          invalidCallbackUrl.searchParams.set("code", "manifest-code");
          invalidCallbackUrl.searchParams.set("state", "wrong-state");
          const invalidCallback = await globalThis.fetch(invalidCallbackUrl);
          const invalidCallbackBody = await invalidCallback.text();

          expect(invalidCallback.status).toBe(400);
          expect(invalidCallbackBody).toContain("GitHub App setup could not be verified");
          expect(invalidCallbackBody).toContain('data-tone="negative"');

          redirectUrl.searchParams.set("code", "manifest-code");
          redirectUrl.searchParams.set("state", state ?? "");
          const callback = await globalThis.fetch(redirectUrl);
          const callbackBody = await callback.text();

          expect(callback.status).toBe(200);
          expect(callback.headers.get("content-type")).toBe("text/html; charset=utf-8");
          expect(callbackBody).toContain("GitHub App connected");
          expect(callbackBody).toContain('data-tone="positive"');
        },
        writeOutput: (text) => output.push(text),
      },
    );

    expect(credentials).toEqual({
      clientId: "github-app-client-id",
      clientSecret: "github-app-client-secret",
      ownerUserId: "123456",
    });
    expect(manifest).toMatchObject({
      callback_urls: ["https://crewhelm.example/api/auth/callback/github"],
      default_events: [],
      default_permissions: {},
      public: false,
      url: "https://crewhelm.example",
    });
    expect(fetchConversion).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/manifest-code/conversions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(output.join("")).not.toContain("github-app-client-secret");
    expect(output.join("")).not.toContain("private-key-that-must-be-discarded");
  });

  it("closes the loopback setup listener when the selected browser is unavailable", async () => {
    let setupUrl: URL | undefined;

    await expect(
      createGitHubApp(
        {
          origin: new URL("https://crewhelm.example"),
          workerName: "crewhelm",
        },
        {
          fetch: vi.fn<typeof globalThis.fetch>(),
          openUrl: async (url) => {
            setupUrl = url;
            throw new Error("browser-provider-secret");
          },
          writeOutput: () => {},
        },
      ),
    ).rejects.toThrow("browser-provider-secret");

    if (!setupUrl) {
      throw new Error("Expected the GitHub App setup URL.");
    }

    await expect(globalThis.fetch(setupUrl)).rejects.toThrow("fetch failed");
  });
});
