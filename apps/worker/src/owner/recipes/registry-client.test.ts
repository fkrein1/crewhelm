import { describe, expect, it, vi } from "vitest";

import {
  configuredRecipeRegistryOrigin,
  RecipeRegistryClient,
  RecipeRegistryClientError,
} from "./registry-client.js";

describe("RecipeRegistryClient", () => {
  it("pins testing installations to the testing Registry", () => {
    expect(
      configuredRecipeRegistryOrigin({
        CREWHELM_TESTING_INSTALLATION: "true",
        RECIPE_REGISTRY_ORIGIN: "https://crewhelm-registry-dev.fkrein.workers.dev/",
      }),
    ).toBe("https://crewhelm-registry-dev.fkrein.workers.dev/");
    expect(() =>
      configuredRecipeRegistryOrigin({
        CREWHELM_TESTING_INSTALLATION: "true",
        RECIPE_REGISTRY_ORIGIN: "https://crewhelm.app/",
      }),
    ).toThrow("Testing installation Recipe Registry is not configured safely.");
  });
  it("uses only the configured canonical origin and refuses redirects", async () => {
    const fetcher = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (_input, _init) => Response.redirect("https://attacker.example/package", 302),
    );
    const client = new RecipeRegistryClient("https://crewhelm.app/", fetcher);

    await expect(client.search("research helper", 10)).rejects.toEqual(
      new RecipeRegistryClientError("registry_unavailable"),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBeInstanceOf(URL);
    if (!(url instanceof URL)) throw new Error("Expected the Registry client to construct a URL.");
    expect(url.toString()).toBe(
      "https://crewhelm.app/api/registry/v1/recipes/search?q=research+helper&limit=10",
    );
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("rejects oversized and non-JSON responses without parsing them", async () => {
    const client = new RecipeRegistryClient(
      "https://crewhelm.app/",
      vi.fn<() => Promise<Response>>(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(1024 * 1024), "content-type": "text/html" },
          }),
      ),
    );
    await expect(client.search("research helper", 10)).rejects.toEqual(
      new RecipeRegistryClientError("registry_unavailable"),
    );
  });
});
