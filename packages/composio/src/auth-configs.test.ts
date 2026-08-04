import { describe, expect, it, vi } from "vitest";

import { createComposioAuthConfigs } from "./auth-configs.js";

const apiKey = "composio-project-secret";
const existingConfig = {
  auth_scheme: "OAUTH2",
  id: "ac_github_managed",
  is_composio_managed: true,
  status: "ENABLED",
  toolkit: { slug: "github" },
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

describe("Composio managed auth configurations", () => {
  it("reuses the deterministic enabled managed configuration without a write", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: [{ ...existingConfig, id: "ac_z_github" }, existingConfig],
        next_cursor: null,
      }),
    );
    const authConfigs = createComposioAuthConfigs({ apiKey, fetch: fetchMock });

    await expect(authConfigs.ensureManaged({ integrationSlug: "github" })).resolves.toEqual({
      authConfig: {
        authConfigId: "ac_github_managed",
        authScheme: "oauth2",
        integrationSlug: "github",
        managed: true,
      },
      created: false,
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    const [endpoint, init] = fetchMock.mock.calls[0] ?? [];

    if (!(endpoint instanceof URL)) {
      throw new TypeError("Expected a Composio auth-config URL.");
    }

    const url = endpoint;

    expect(url.origin + url.pathname).toBe("https://backend.composio.dev/api/v3.1/auth_configs");
    expect(url.searchParams.get("is_composio_managed")).toBe("true");
    expect(url.searchParams.get("show_disabled")).toBe("false");
    expect(url.searchParams.get("toolkit_slug")).toBe("github");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
  });

  it("creates a managed configuration through one fixed bounded write", async () => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            auth_config: {
              auth_scheme: existingConfig.auth_scheme,
              id: existingConfig.id,
              is_composio_managed: existingConfig.is_composio_managed,
            },
            toolkit: { slug: "github" },
          },
          201,
        ),
      );
    const authConfigs = createComposioAuthConfigs({ apiKey, fetch: fetchMock, onResponse });

    await expect(authConfigs.ensureManaged({ integrationSlug: "github" })).resolves.toMatchObject({
      authConfig: { authConfigId: existingConfig.id, integrationSlug: "github", managed: true },
      created: true,
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onResponse).toHaveBeenNthCalledWith(1, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "lookup",
      outcome: "accepted",
      status: 200,
    });
    expect(onResponse).toHaveBeenNthCalledWith(2, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "create",
      outcome: "accepted",
      status: 201,
    });

    const [endpoint, init] = fetchMock.mock.calls[1] ?? [];

    expect(endpoint).toBe("https://backend.composio.dev/api/v3.1/auth_configs");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected a serialized Composio auth-config request.");
    }

    expect(JSON.parse(init.body)).toEqual({
      auth_config: {
        credentials: {},
        restrict_to_following_tools: [],
        type: "use_composio_managed_auth",
      },
      toolkit: { slug: "github" },
    });
  });

  it("recovers a provider success after an ambiguous create response", async () => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ items: [existingConfig], next_cursor: null }));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock, onResponse }).ensureManaged({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({
      authConfig: { authConfigId: existingConfig.id },
      created: false,
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onResponse).toHaveBeenNthCalledWith(1, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "lookup",
      outcome: "accepted",
      status: 200,
    });
    expect(onResponse).toHaveBeenNthCalledWith(2, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "create",
      outcome: "invalid_response",
      status: 503,
    });
    expect(onResponse).toHaveBeenNthCalledWith(3, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "recovery",
      outcome: "accepted",
      status: 200,
    });
  });

  it("reports a conclusive provider rejection without claiming an unknown effect", async () => {
    const onResponse = vi.fn<(event: unknown) => void>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(jsonResponse({ message: "unsupported" }, 400))
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock, onResponse }).ensureManaged({
        integrationSlug: "spotify",
      }),
    ).resolves.toEqual({
      error: {
        code: "integration_enablement_rejected",
        message: "Integration enablement request denied.",
      },
      externalEffect: "none",
      ok: false,
    });
    expect(onResponse).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      integrationSlug: "spotify",
      operation: "create",
      outcome: "provider_rejected",
      status: 400,
    });
  });

  it("reconciles a malformed successful create body instead of abandoning recovery", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(
        new Response("not json", { headers: { "content-type": "application/json" }, status: 201 }),
      )
      .mockResolvedValueOnce(jsonResponse({ items: [existingConfig], next_cursor: null }));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock }).ensureManaged({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({
      authConfig: { authConfigId: existingConfig.id },
      created: false,
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed for invalid configuration, substituted toolkits, and unbounded responses", async () => {
    const unavailableFetch = vi.fn<typeof fetch>();

    await expect(
      createComposioAuthConfigs({ apiKey: undefined, fetch: unavailableFetch }).ensureManaged({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(unavailableFetch).not.toHaveBeenCalled();

    const substitutedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ items: [{ ...existingConfig, toolkit: { slug: "slack" } }] }),
      );
    const result = await createComposioAuthConfigs({
      apiKey,
      fetch: substitutedFetch,
    }).ensureManaged({ integrationSlug: "github" });

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);

    const unboundedFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        items: Array.from({ length: 51 }, () => existingConfig),
        next_cursor: null,
      }),
    );

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: unboundedFetch }).ensureManaged({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
