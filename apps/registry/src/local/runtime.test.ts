import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { localRegistry } from "../local.js";

function environment(): Parameters<NonNullable<typeof localRegistry.fetch>>[1] {
  return {
    ...env,
    PUBLIC_ORIGIN: "http://127.0.0.1:8788/",
  };
}

describe("local Registry", () => {
  it("serves health only at the exact loopback origin", async () => {
    const context = createExecutionContext();
    const accepted = await localRegistry.fetch!(
      new Request("http://127.0.0.1:8788/health"),
      environment(),
      context,
    );
    const denied = await localRegistry.fetch!(
      new Request("http://localhost:8788/health"),
      environment(),
      context,
    );

    expect(accepted.status).toBe(200);
    expect(denied.status).toBe(503);
  });
});
