import { describe, expect, it, vi } from "vitest";

import worker, { createWorker, healthReportSchema } from "../src/index.js";

const origin = "https://crewhelm.test";

function request(path: string, init?: RequestInit): Promise<Response> | Response {
  return worker.fetch(new Request(`${origin}${path}`, init));
}

describe("Crewhelm Worker", () => {
  it("reports fixed liveness metadata without caching", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const payload: unknown = await response.json();

    expect(healthReportSchema.parse(payload)).toEqual({
      service: "crewhelm",
      status: "ok",
    });
  });

  it("supports health probes without returning a HEAD body", async () => {
    const getResponse = await request("/health");
    const headResponse = await request("/health", { method: "HEAD" });

    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(
      getResponse.headers.get("content-length"),
    );
    await expect(headResponse.text()).resolves.toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])(
    "rejects unsupported %s health requests without reflecting request data",
    async (method) => {
      const response = await request("/health", {
        body: "do-not-reflect-this",
        method,
      });
      const body = await response.text();

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(JSON.parse(body)).toEqual({
        error: {
          code: "method_not_allowed",
          message: "Method not allowed.",
        },
      });
      expect(body).not.toContain("do-not-reflect-this");
    },
  );

  it("fails closed for every other route without reflecting the URL", async () => {
    const response = await request("/private?token=do-not-reflect-this");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "not_found",
        message: "Not found.",
      },
    });
    expect(body).not.toContain("private");
    expect(body).not.toContain("do-not-reflect-this");
  });

  it.each(["/%68ealth", "/he%61lth", "/health/", "/HEALTH"])(
    "does not treat %s as the canonical health route",
    async (path) => {
      const response = await request(path);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "not_found",
          message: "Not found.",
        },
      });
    },
  );

  it("preserves HEAD semantics for unknown routes", async () => {
    const getResponse = await request("/private");
    const headResponse = await request("/private", { method: "HEAD" });

    expect(headResponse.status).toBe(404);
    expect(headResponse.headers.get("content-length")).toBe(
      getResponse.headers.get("content-length"),
    );
    await expect(headResponse.text()).resolves.toBe("");
  });

  it("returns a fixed internal error without logging or reflecting the exception", async () => {
    const failingWorker = createWorker();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failingWorker.get("/failure", () => {
      throw new Error("do-not-reflect-this");
    });

    const response = await failingWorker.fetch(new Request(`${origin}/failure`));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    expect(body).not.toContain("do-not-reflect-this");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
