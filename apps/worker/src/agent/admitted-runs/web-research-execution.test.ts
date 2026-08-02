import type { WebFetchRuntimeTool, WebSearchRuntimeTool } from "@crewhelm/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  WebResearchExecutionError,
  issueWebSourceToken,
  normalizePublicHttpsUrl,
  runBraveWebSearch,
  runControlledWebFetch,
  verifyWebSourceToken,
} from "./web-research-execution.js";

const searchTool: WebSearchRuntimeTool = {
  effect: "public-read",
  id: "web.search",
  kind: "web-search",
  limits: {
    maxDurationMs: 1_000,
    maxOutputBytes: 4_096,
    maxQueryCharacters: 100,
    maxResults: 3,
  },
  moduleId: "tools.web-search",
  network: "provider-only",
  provider: "brave",
  safeSearch: "strict",
  schemaVersion: 1,
};

const fetchTool: WebFetchRuntimeTool = {
  allowedContentTypes: ["application/json", "text/html", "text/plain"],
  effect: "public-read",
  id: "web.fetch",
  kind: "web-fetch",
  limits: {
    maxDurationMs: 1_000,
    maxOutputBytes: 2_048,
    maxRedirects: 2,
    maxResponseBytes: 4_096,
  },
  moduleId: "tools.web-fetch",
  network: "public-https",
  schemaVersion: 1,
};

describe("web source authority", () => {
  it.each([
    "http://example.com/",
    "https://localhost/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://10.1.2.3/",
    "https://[::1]/",
    "https://metadata.google.internal/",
    "https://localhost./",
    "https://foo.local./",
    "https://metadata.google.internal./",
    "https://user:secret@example.com/",
    "https://example.com:8443/",
    "https://[2606:4700:4700::1111]/",
    "https://[2001::1]/",
    "https://[2001:2::1]/",
    "https://[2001:10::1]/",
    "https://[2001:20::1]/",
    "https://[2002:7f00:1::]/",
  ])("denies non-public target %s", (url) => {
    expect(() => normalizePublicHttpsUrl(url)).toThrow(WebResearchExecutionError);
  });

  it("binds source tokens to the exact URL and Run", async () => {
    const source = await issueWebSourceToken("owner-secret", "run_1", "https://example.com/a#x");
    await expect(
      verifyWebSourceToken("owner-secret", "run_1", source.url, source.token),
    ).resolves.toBe("https://example.com/a");
    await expect(
      verifyWebSourceToken("owner-secret", "run_2", source.url, source.token),
    ).rejects.toMatchObject({ code: "invalid_source" });
    await expect(
      verifyWebSourceToken("owner-secret", "run_1", "https://example.com/b", source.token),
    ).rejects.toMatchObject({ code: "invalid_source" });
  });

  it("accepts and canonicalizes a public HTTPS domain", () => {
    expect(normalizePublicHttpsUrl("https://example.com:443/a#fragment")).toBe(
      "https://example.com/a",
    );
    expect(normalizePublicHttpsUrl("https://example.com./a")).toBe("https://example.com/a");
  });
});

describe("Brave web search", () => {
  it("normalizes, deduplicates, and filters provider evidence", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ignored: "not exposed",
          web: {
            results: [
              {
                age: "2 hours ago",
                description: "  Useful   result ",
                title: " Example ",
                url: "https://example.com/a#fragment",
              },
              { title: "Duplicate", url: "https://example.com/a" },
              { title: "Private", url: "https://127.0.0.1/admin" },
              { description: "Second", title: "Other", url: "https://other.example/b" },
            ],
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      runBraveWebSearch({
        apiKey: "secret-api-key",
        fetchImplementation: request,
        freshness: "week",
        query: "  cloudflare   agents ",
        signal: new AbortController().signal,
        tool: searchTool,
      }),
    ).resolves.toEqual({
      query: "cloudflare agents",
      results: [
        {
          age: "2 hours ago",
          snippet: "Useful result",
          title: "Example",
          url: "https://example.com/a",
        },
        {
          snippet: "Second",
          title: "Other",
          url: "https://other.example/b",
        },
      ],
    });
    const [url, options] = request.mock.calls[0] ?? [];
    const requestedUrl =
      typeof url === "string" ? url : url instanceof URL ? url.toString() : (url?.url ?? "");
    expect(requestedUrl).toContain("freshness=pw");
    expect(options?.headers).toEqual({
      Accept: "application/json",
      "X-Subscription-Token": "secret-api-key",
    });
    expect(options?.redirect).toBe("manual");
  });

  it("denies provider redirects without forwarding the credential", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { location: "https://other.example" }, status: 302 }),
      );
    const execution = runBraveWebSearch({
      apiKey: "secret-api-key",
      fetchImplementation: request,
      query: "query",
      signal: new AbortController().signal,
      tool: searchTool,
    });

    await expect(execution).rejects.toMatchObject({ code: "provider_failed", status: 302 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not expose provider errors or the credential", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret-api-key leaked", { status: 401 }));
    const execution = runBraveWebSearch({
      apiKey: "secret-api-key",
      fetchImplementation: request,
      query: "query",
      signal: new AbortController().signal,
      tool: searchTool,
    });
    await expect(execution).rejects.toMatchObject({
      code: "provider_failed",
      message: expect.not.stringContaining("secret-api-key"),
      status: 401,
    });
  });

  it("classifies malformed provider content and bounded timeouts", async () => {
    await expect(
      runBraveWebSearch({
        apiKey: "secret-api-key",
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("{", { headers: { "content-type": "application/json" } }),
          ),
        query: "query",
        signal: new AbortController().signal,
        tool: searchTool,
      }),
    ).rejects.toMatchObject({ code: "invalid_provider_response", status: null });

    const timedOut = vi.fn<typeof fetch>().mockImplementation((_url, options) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await expect(
      runBraveWebSearch({
        apiKey: "secret-api-key",
        fetchImplementation: timedOut,
        query: "query",
        signal: new AbortController().signal,
        tool: { ...searchTool, limits: { ...searchTool.limits, maxDurationMs: 1 } },
      }),
    ).rejects.toMatchObject({ code: "timed_out", status: null });
  });

  it("preserves the caller abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("Search cancelled by caller.");
    controller.abort(reason);

    await expect(
      runBraveWebSearch({
        apiKey: "secret-api-key",
        fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(reason),
        query: "query",
        signal: controller.signal,
        tool: searchTool,
      }),
    ).rejects.toBe(reason);
  });
});

describe("controlled web fetch", () => {
  it("validates redirects and returns normalized evidence", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { location: "/final" }, status: 302 }))
      .mockResolvedValueOnce(
        new Response(
          "<html><head><title> Page &amp; title </title><style>hidden</style></head><body>Hello <b>world</b><script>bad()</script></body></html>",
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      );
    const result = await runControlledWebFetch({
      fetchImplementation: request,
      signal: new AbortController().signal,
      tool: fetchTool,
      url: "https://example.com/start",
    });
    expect(result).toMatchObject({
      contentType: "text/html",
      finalUrl: "https://example.com/final",
      redirects: 1,
      text: "Page & title Hello world",
      title: "Page & title",
      truncated: false,
    });
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("denies a redirect to private infrastructure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(null, { headers: { location: "https://127.0.0.1/" }, status: 302 }),
      );
    await expect(
      runControlledWebFetch({
        fetchImplementation: request,
        signal: new AbortController().signal,
        tool: fetchTool,
        url: "https://example.com/start",
      }),
    ).rejects.toMatchObject({ code: "redirect_denied" });
  });

  it("rejects unsupported and oversized responses", async () => {
    await expect(
      runControlledWebFetch({
        fetchImplementation: vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("x", { headers: { "content-type": "image/png" } })),
        signal: new AbortController().signal,
        tool: fetchTool,
        url: "https://example.com/image",
      }),
    ).rejects.toMatchObject({ code: "unsupported_content_type" });
    await expect(
      runControlledWebFetch({
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("x", {
            headers: { "content-length": "5000", "content-type": "text/plain" },
          }),
        ),
        signal: new AbortController().signal,
        tool: fetchTool,
        url: "https://example.com/large",
      }),
    ).rejects.toMatchObject({ code: "content_too_large" });
  });

  it("preserves malformed numeric entities as untrusted text", async () => {
    await expect(
      runControlledWebFetch({
        fetchImplementation: vi.fn<typeof fetch>().mockResolvedValue(
          new Response("<p>Evidence &#999999999; remains visible.</p>", {
            headers: { "content-type": "text/html" },
          }),
        ),
        signal: new AbortController().signal,
        tool: fetchTool,
        url: "https://example.com/entities",
      }),
    ).resolves.toMatchObject({ text: "Evidence &#999999999; remains visible." });
  });

  it("preserves the caller abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("Fetch cancelled by caller.");
    controller.abort(reason);

    await expect(
      runControlledWebFetch({
        fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(reason),
        signal: controller.signal,
        tool: fetchTool,
        url: "https://example.com/cancelled",
      }),
    ).rejects.toBe(reason);
  });
});
