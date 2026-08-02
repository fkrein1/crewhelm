import { request as httpRequest } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { openInCodexBrowser } from "../src/codex-browser.js";

interface HandoffResponse {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
}

function requestWithHost(url: URL, host: string, method = "GET"): Promise<HandoffResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        headers: { host },
        hostname: "127.0.0.1",
        method,
        path: `${url.pathname}${url.search}`,
        port: url.port,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );

    request.once("error", reject);
    request.end();
  });
}

function handoffFromOutput(output: readonly string[]): URL {
  const match = output.join("").match(/CODEX_BROWSER_HANDOFF (http:\/\/[^\s]+)/u);

  if (!match?.[1]) {
    throw new Error("Expected a Codex browser handoff URL.");
  }

  return new URL(match[1]);
}

describe("Codex browser handoff", () => {
  it("redirects one explicit loopback continuation without exposing the signed target", async () => {
    const output: string[] = [];
    const target = new URL(
      "https://crewhelm.example/api/auth/oauth2/authorize?state=signed-secret",
    );
    const opening = openInCodexBrowser(target, {
      handoffTimeoutMs: 1_000,
      writeError: (text) => output.push(text),
    });

    await vi.waitFor(() => {
      expect(output).toHaveLength(1);
    });
    const handoff = handoffFromOutput(output);
    const wrongHost = await requestWithHost(handoff, `localhost:${handoff.port}`);
    const wrongMethod = await requestWithHost(handoff, handoff.host, "POST");
    const page = await requestWithHost(handoff, handoff.host);
    const continueUrl = new URL(`${handoff.pathname}/continue`, handoff);
    const response = await requestWithHost(continueUrl, handoff.host, "POST");

    await expect(opening).resolves.toBeUndefined();
    expect(wrongHost.status).toBe(404);
    expect(wrongMethod.status).toBe(404);
    expect(page).toMatchObject({
      headers: {
        "cache-control": "no-store",
        "content-security-policy": expect.stringContaining("form-action 'self'"),
        "referrer-policy": "no-referrer",
      },
      status: 200,
    });
    expect(page.body).toContain("Continue in the Codex browser.");
    expect(page.body).toContain('action="/codex/browser/');
    expect(page.body).not.toContain(target.origin);
    expect(page.body).not.toContain(target.search);
    expect(response).toMatchObject({
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'",
        location: target.href,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
      status: 303,
    });
    expect(output.join("")).not.toContain(target.origin);
    expect(output.join("")).not.toContain(target.search);
    expect(handoff.hostname).toBe("127.0.0.1");
    expect(handoff.pathname).toMatch(/^\/codex\/browser\/[A-Za-z0-9_-]{43}$/u);
  });

  it("times out without reflecting the target URL", async () => {
    const output: string[] = [];
    const target = new URL("https://crewhelm.example/authorize?state=signed-secret");
    const opening = openInCodexBrowser(target, {
      handoffTimeoutMs: 50,
      writeError: (text) => output.push(text),
    });

    await expect(opening).rejects.toThrow("Codex browser handoff timed out.");
    expect(output.join("")).not.toContain(target.origin);
    expect(output.join("")).not.toContain(target.search);
  });

  it("rejects insecure, non-web, and credential-bearing targets before opening a listener", async () => {
    const output: string[] = [];

    await expect(
      openInCodexBrowser(new URL("http://crewhelm.example/authorize"), {
        writeError: (text) => output.push(text),
      }),
    ).rejects.toThrow("Codex browser target was invalid.");
    await expect(
      openInCodexBrowser(new URL("file:///tmp/authorization"), {
        writeError: (text) => output.push(text),
      }),
    ).rejects.toThrow("Codex browser target was invalid.");
    await expect(
      openInCodexBrowser(new URL("https://owner:secret@crewhelm.example/authorize"), {
        writeError: (text) => output.push(text),
      }),
    ).rejects.toThrow("Codex browser target was invalid.");
    expect(output).toEqual([]);
  });
});
