import { describe, expect, it, vi } from "vitest";

import { routeSiteRequest, type SiteEnv } from "./worker.js";

type FetchRequest = (request: Request) => Promise<Response>;

function service(fetch: FetchRequest): SiteEnv["ASSETS"] {
  return { fetch };
}

describe("site Registry gateway", () => {
  it("forwards the fixed public prefix to the private Registry service", async () => {
    const registryFetch = vi.fn<FetchRequest>(async (request) =>
      Response.json({ body: await request.text(), path: new URL(request.url).pathname }),
    );
    const assetsFetch = vi.fn<FetchRequest>(async () => new Response("asset"));
    const env = {
      ASSETS: service(assetsFetch),
      REGISTRY: service(registryFetch),
    } satisfies SiteEnv;
    const request = new Request("https://dev.crewhelm.app/api/registry/v1/publish?draft=1", {
      body: "payload",
      headers: {
        cookie: "crewhelm_registry_session=session",
        origin: "https://dev.crewhelm.app",
      },
      method: "POST",
    });

    const response = await routeSiteRequest(request, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ body: "payload", path: "/v1/publish" });
    expect(registryFetch).toHaveBeenCalledOnce();
    expect(assetsFetch).not.toHaveBeenCalled();
    const forwarded = registryFetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("origin")).toBe("https://dev.crewhelm.app");
    expect(forwarded?.headers.get("cookie")).toBe("crewhelm_registry_session=session");
    expect(forwarded?.method).toBe("POST");
    expect(new URL(forwarded?.url ?? "https://invalid.test").search).toBe("?draft=1");
  });

  it("keeps website and lookalike paths on the static asset binding", async () => {
    const registryFetch = vi.fn<FetchRequest>(async () => new Response("registry"));
    const assetsFetch = vi.fn<FetchRequest>(async () => new Response("asset"));
    const env = {
      ASSETS: service(assetsFetch),
      REGISTRY: service(registryFetch),
    } satisfies SiteEnv;

    const response = await routeSiteRequest(
      new Request("https://crewhelm.app/api/registry-malicious/v1/recipes"),
      env,
    );

    await expect(response.text()).resolves.toBe("asset");
    expect(assetsFetch).toHaveBeenCalledOnce();
    expect(registryFetch).not.toHaveBeenCalled();
  });

  it("returns a compact non-cacheable response when the Registry binding fails", async () => {
    const env = {
      ASSETS: service(async () => new Response("asset")),
      REGISTRY: service(async () => {
        throw new Error("internal service details");
      }),
    } satisfies SiteEnv;

    const response = await routeSiteRequest(
      new Request("https://crewhelm.app/api/registry/v1/recipes/search?q=research"),
      env,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
  });
});
