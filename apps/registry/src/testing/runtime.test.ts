import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { testingRegistry } from "../testing.js";

function environment(): Parameters<NonNullable<typeof testingRegistry.fetch>>[1] {
  return {
    ...env,
    PUBLIC_ORIGIN: "https://crewhelm-registry-dev.fkrein.workers.dev/",
    TESTING_SETUP_SECRET: "a".repeat(43),
  };
}

describe("testing Registry", () => {
  it("keeps scheduled Registry maintenance enabled", () => {
    expect(testingRegistry.scheduled).toBeTypeOf("function");
  });

  it("serves the testing entrypoint on its exact configured Cloudflare origin", async () => {
    const response = await testingRegistry.fetch!(
      new Request("https://crewhelm-registry-dev.fkrein.workers.dev/health"),
      environment(),
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it.each(["https://example.com/health", "http://crewhelm-registry-dev.fkrein.workers.dev/health"])(
    "refuses the testing entrypoint at %s",
    async (url) => {
      const response = await testingRegistry.fetch!(
        new Request(url),
        environment(),
        createExecutionContext(),
      );

      expect(response.status).toBe(503);
    },
  );

  it("denies seed reconciliation without the setup credential", async () => {
    const response = await testingRegistry.fetch!(
      new Request("https://crewhelm-registry-dev.fkrein.workers.dev/development/seed", {
        method: "POST",
      }),
      environment(),
      createExecutionContext(),
    );

    expect(response.status).toBe(403);
  });

  it("does not expose publisher GitHub OAuth on the testing Registry", async () => {
    const response = await testingRegistry.fetch!(
      new Request(
        "https://crewhelm-registry-dev.fkrein.workers.dev/api/registry/auth/github/start",
      ),
      environment(),
      createExecutionContext(),
    );

    expect(response.status).toBe(404);
  });
});
