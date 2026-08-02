import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WorkerEnv } from "../env.js";
import { VIEW_ACCESS_SCOPE } from "./access-levels.js";
import { registerOAuthUiRoutes } from "./ui.js";

const origin = "https://crewhelm.test";

function oauthUiWithUpstreamResponse(response: Response) {
  const worker = new Hono<{ Bindings: WorkerEnv }>();
  const auth = {
    handler: async () => response,
  };

  registerOAuthUiRoutes(worker, () => auth);
  return worker;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth UI navigation boundary", () => {
  it.each([
    {
      accept: "text/html",
      body: new URLSearchParams({ oauth_query: "client_id=test-client" }),
      path: "/oauth/login",
      stage: "login",
      target: "http://[",
    },
    {
      accept: "application/json",
      body: new URLSearchParams({
        decision: "approve",
        oauth_query: new URLSearchParams({ scope: VIEW_ACCESS_SCOPE }).toString(),
      }),
      path: "/oauth/consent",
      stage: "consent",
      target: "javascript:alert(1)",
    },
  ])("fails closed for an invalid upstream navigation target during $stage", async (input) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = oauthUiWithUpstreamResponse(
      new Response(null, { headers: { location: input.target }, status: 302 }),
    );
    const response = await worker.request(
      new Request(`${origin}${input.path}`, {
        body: input.body,
        headers: {
          accept: input.accept,
          "content-type": "application/x-www-form-urlencoded",
          origin,
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe("Authorization is temporarily unavailable.\n");
    expect(consoleError).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("crewhelm.authorization_unavailable", {
      stage: input.stage,
    });
  });
});
