import { describe, expect, it, vi } from "vitest";

import { registryReadHeaders, routeSiteRequest, type SiteEnv } from "./site-registry-gateway.js";

type FetchRequest = (request: Request) => Promise<Response>;

function service(fetch: FetchRequest): SiteEnv["ASSETS"] {
  return { fetch };
}

describe("site Registry gateway", () => {
  it("preserves distinct Cloudflare client identities for SSR Registry reads", () => {
    const first = registryReadHeaders(
      new Request("https://crewhelm.app/recipes/", {
        headers: { "cf-connecting-ip": "192.0.2.10" },
      }),
    );
    const second = registryReadHeaders(
      new Request("https://crewhelm.app/recipes/", {
        headers: { "cf-connecting-ip": "192.0.2.11" },
      }),
    );

    expect(first.get("cf-connecting-ip")).toBe("192.0.2.10");
    expect(second.get("cf-connecting-ip")).toBe("192.0.2.11");
    expect(first.get("accept")).toBe("application/json");
  });
  it("forwards the fixed public prefix to the private Registry service", async () => {
    const registryFetch = vi.fn<FetchRequest>(async (request) =>
      Response.json({ body: await request.text(), path: new URL(request.url).pathname }),
    );
    const assetsFetch = vi.fn<FetchRequest>(async () => new Response("asset"));
    const env = {
      ASSETS: service(assetsFetch),
      REGISTRY: service(registryFetch),
    } satisfies SiteEnv;
    const request = new Request("https://crewhelm.app/api/registry/v1/publish?draft=1", {
      body: "payload",
      headers: {
        cookie: "crewhelm_registry_session=session",
        origin: "https://crewhelm.app",
      },
      method: "POST",
    });

    const response = await routeSiteRequest(request, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ body: "payload", path: "/v1/publish" });
    expect(registryFetch).toHaveBeenCalledOnce();
    expect(assetsFetch).not.toHaveBeenCalled();
    const forwarded = registryFetch.mock.calls[0]?.[0];
    expect(forwarded?.headers.get("origin")).toBe("https://crewhelm.app");
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

  it("uses the configured dev Registry origin for preview service requests", async () => {
    const registryFetch = vi.fn<FetchRequest>(async () => new Response("registry"));
    const env = {
      ASSETS: service(async () => new Response("asset")),
      REGISTRY: service(registryFetch),
      REGISTRY_ORIGIN: "https://crewhelm-registry-dev.fkrein.workers.dev",
    } satisfies SiteEnv;

    const response = await routeSiteRequest(
      new Request(
        "https://branch-crewhelm-site.fkrein.workers.dev/api/registry/v1/recipes/search?q=research",
      ),
      env,
    );

    await expect(response.text()).resolves.toBe("registry");
    const forwarded = registryFetch.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(
      "https://crewhelm-registry-dev.fkrein.workers.dev/v1/recipes/search?q=research",
    );
  });

  it("fails closed when the configured Registry origin is not an exact HTTPS origin", async () => {
    const registryFetch = vi.fn<FetchRequest>(async () => new Response("registry"));
    const env = {
      ASSETS: service(async () => new Response("asset")),
      REGISTRY: service(registryFetch),
      REGISTRY_ORIGIN: "https://crewhelm-registry-dev.fkrein.workers.dev/unexpected",
    } satisfies SiteEnv;

    const response = await routeSiteRequest(
      new Request("https://preview.example/api/registry/v1/recipes/search?q=research"),
      env,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "unavailable" });
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
