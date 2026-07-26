import { describe, expect, it, vi } from "vitest";

import { checkWorkerHealth, parseDeploymentOrigin } from "../src/doctor.js";

function healthyResponse(): Response {
  return new Response(`${JSON.stringify({ service: "crewhelm", status: "ok" })}\n`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}

describe("Worker health diagnosis", () => {
  it("normalizes an HTTPS origin and validates the health contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(healthyResponse());
    const report = await checkWorkerHealth(
      {
        origin: parseDeploymentOrigin("https://Example.com:443"),
        timeoutMs: 1_000,
      },
      { fetch },
    );

    expect(report).toEqual({
      schemaVersion: 1,
      ok: true,
      checks: [
        {
          code: "healthy",
          endpoint: "https://example.com/health",
          message: "Worker health contract is valid.",
          name: "worker-health",
          status: "pass",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://example.com/health"),
      expect.objectContaining({
        headers: {
          accept: "application/json",
        },
        method: "GET",
        redirect: "error",
      }),
    );
  });

  it.each([
    {
      endpoint: "http://example.com",
      message: "Use HTTPS, or HTTP only for an exact loopback host.",
    },
    {
      endpoint: "https://user:secret@example.com",
      message: "The endpoint must not include credentials.",
    },
    {
      endpoint: "https://example.com/deployment",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "https://example.com?token=secret",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "https://example.com#fragment",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
    {
      endpoint: "file:///tmp/crewhelm",
      message: "The endpoint must be an origin without a path, query, or fragment.",
    },
  ])("rejects unsafe deployment origin $endpoint", ({ endpoint, message }) => {
    expect(() => parseDeploymentOrigin(endpoint)).toThrow(message);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "allows exact loopback development origin %s",
    (endpoint) => {
      expect(parseDeploymentOrigin(endpoint).origin).toBe(endpoint);
    },
  );

  it("bounds the response body before parsing it", async () => {
    const report = await checkWorkerHealth(
      {
        origin: parseDeploymentOrigin("https://crewhelm.example"),
        timeoutMs: 1_000,
      },
      {
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response("x".repeat(4_097), {
            headers: {
              "content-type": "application/json",
            },
          }),
        ),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0].code).toBe("response_too_large");
  });

  it("rejects malformed or widened health payloads", async () => {
    const malformed = await checkWorkerHealth(
      {
        origin: parseDeploymentOrigin("https://crewhelm.example"),
        timeoutMs: 1_000,
      },
      {
        fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          new Response('{"service":"crewhelm","status":"ok","secret":"no"}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      },
    );

    expect(malformed.ok).toBe(false);
    expect(malformed.checks[0].code).toBe("invalid_payload");
  });

  it("does not reflect a network exception", async () => {
    const report = await checkWorkerHealth(
      {
        origin: parseDeploymentOrigin("https://crewhelm.example"),
        timeoutMs: 1_000,
      },
      {
        fetch: vi
          .fn<typeof globalThis.fetch>()
          .mockRejectedValue(new Error("secret-provider-diagnostic")),
      },
    );

    expect(report.ok).toBe(false);
    expect(report.checks[0].code).toBe("request_failed");
    expect(JSON.stringify(report)).not.toContain("secret-provider-diagnostic");
  });
});
