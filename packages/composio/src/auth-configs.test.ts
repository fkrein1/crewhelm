import { describe, expect, it, vi } from "vitest";

import { createComposioAuthConfigs } from "./auth-configs.js";

const apiKey = "composio-project-secret";
const existingConfig = {
  auth_scheme: "OAUTH2",
  id: "ac_github_managed",
  is_composio_managed: true,
  name: "GitHub managed",
  status: "ENABLED",
  toolkit: { slug: "github" },
};

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function toolkit(
  slug: string,
  options: { managed?: string[]; modes?: string[]; name?: string; noAuth?: boolean } = {},
) {
  return {
    auth_config_details: (options.modes ?? ["oauth2"]).map((mode) => ({ mode })),
    composio_managed_auth_schemes: options.managed ?? [],
    name: options.name ?? slug,
    no_auth: options.noAuth ?? false,
    slug,
  };
}

describe("Composio auth configurations", () => {
  it("inspects one existing custom configuration as ready without writing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(toolkit("spotify", { name: "Spotify" })))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              ...existingConfig,
              id: "ac_spotify_custom",
              is_composio_managed: false,
              name: "Spotify app",
              toolkit: { slug: "spotify" },
            },
          ],
          next_cursor: null,
        }),
      );

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock }).inspect({
        integrationSlug: "spotify",
      }),
    ).resolves.toEqual({
      authentication: {
        selected: {
          authConfigId: "ac_spotify_custom",
          authScheme: "OAUTH2",
          integrationSlug: "spotify",
          name: "Spotify app",
          source: "crewhelm_custom",
        },
        state: "ready",
      },
      integration: { name: "Spotify", slug: "spotify" },
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [toolkitEndpoint] = fetchMock.mock.calls[0] ?? [];
    const [configsEndpoint, configsInit] = fetchMock.mock.calls[1] ?? [];

    expect(toolkitEndpoint).toBeInstanceOf(URL);
    if (!(toolkitEndpoint instanceof URL)) throw new TypeError("Expected toolkit URL.");
    expect(toolkitEndpoint.href).toContain("/api/v3.1/toolkits/spotify?version=latest");
    expect(configsEndpoint).toBeInstanceOf(URL);
    if (!(configsEndpoint instanceof URL)) throw new TypeError("Expected auth-config URL.");
    expect(configsEndpoint.searchParams.get("is_composio_managed")).toBeNull();
    expect(configsEndpoint.searchParams.get("toolkit_slug")).toBe("spotify");
    expect(configsInit?.method).toBe("GET");
  });

  it("returns exact sorted choices when several active configurations exist", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(toolkit("github", { managed: ["oauth2"], name: "GitHub" })),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { ...existingConfig, id: "ac_z_custom", is_composio_managed: false, name: "Custom" },
            existingConfig,
          ],
          next_cursor: null,
        }),
      );

    const result = await createComposioAuthConfigs({ apiKey, fetch: fetchMock }).inspect({
      integrationSlug: "github",
    });

    expect(result).toMatchObject({
      authentication: {
        choices: [
          { authConfigId: "ac_github_managed", source: "composio_managed" },
          { authConfigId: "ac_z_custom", source: "crewhelm_custom" },
        ],
        state: "selection_required",
      },
      ok: true,
    });
  });

  it("distinguishes managed creation from required custom setup", async () => {
    const managedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(toolkit("gmail", { managed: ["oauth2"], name: "Gmail" })))
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
    const customFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(toolkit("spotify", { name: "Spotify" })))
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: managedFetch }).inspect({
        integrationSlug: "gmail",
      }),
    ).resolves.toMatchObject({
      authentication: {
        availableSchemes: ["OAUTH2"],
        managedAuthAvailable: true,
        recommendedScheme: "OAUTH2",
        state: "setup_required",
      },
      ok: true,
    });
    await expect(
      createComposioAuthConfigs({ apiKey, fetch: customFetch }).inspect({
        integrationSlug: "spotify",
      }),
    ).resolves.toMatchObject({
      authentication: { managedAuthAvailable: false, state: "setup_required" },
      ok: true,
    });
  });

  it("reports an unavailable toolkit deterministically without listing configs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock }).inspect({
        integrationSlug: "missing",
      }),
    ).resolves.toEqual({
      authentication: { reason: "toolkit_unavailable", state: "unsupported" },
      integration: { name: "missing", slug: "missing" },
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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

    await expect(
      authConfigs.createManaged({ integrationSlug: "github", name: "GitHub" }),
    ).resolves.toMatchObject({
      authConfig: {
        authConfigId: existingConfig.id,
        authScheme: "OAUTH2",
        integrationSlug: "github",
        name: "GitHub",
        source: "composio_managed",
      },
      created: true,
      ok: true,
    });
    expect(onResponse).toHaveBeenNthCalledWith(1, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "recovery",
      status: 200,
    });
    expect(onResponse).toHaveBeenNthCalledWith(2, {
      durationMs: expect.any(Number),
      integrationSlug: "github",
      operation: "create",
      status: 201,
    });
    const [endpoint, init] = fetchMock.mock.calls[1] ?? [];

    expect(endpoint).toBe("https://backend.composio.dev/api/v3.1/auth_configs");
    expect(init?.method).toBe("POST");
    if (typeof init?.body !== "string") throw new TypeError("Expected serialized request.");
    expect(JSON.parse(init.body)).toEqual({
      auth_config: {
        credentials: {},
        restrict_to_following_tools: [],
        type: "use_composio_managed_auth",
      },
      toolkit: { slug: "github" },
    });
  });

  it("freezes bounded custom credential fields without exposing provider defaults", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        auth_config_details: [
          {
            auth_hint_url: "https://docs.example.com/github-app",
            fields: {
              auth_config_creation: {
                optional: [
                  {
                    displayName: "Client label",
                    is_secret: false,
                    name: "client_label",
                    required: false,
                    type: "string",
                  },
                ],
                required: [
                  {
                    displayName: "Client secret",
                    is_secret: true,
                    name: "client_secret",
                    required: true,
                    type: "string",
                  },
                  {
                    displayName: "Redirect URI",
                    is_secret: false,
                    name: "oauth_redirect_uri",
                    required: true,
                    type: "string",
                  },
                ],
              },
            },
            mode: "oauth2",
          },
        ],
        composio_managed_auth_schemes: [],
        name: "GitHub",
        slug: "github",
      }),
    );

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: fetchMock }).prepareCustom({
        authScheme: "OAUTH2",
        integrationSlug: "github",
      }),
    ).resolves.toEqual({
      callbackUrl: "https://backend.composio.dev/api/v3.1/toolkits/auth/callback",
      documentationUrl: "https://docs.example.com/github-app",
      fields: [
        {
          key: "client_secret",
          label: "Client secret",
          maximumLength: 8192,
          required: true,
          secret: true,
          type: "string",
        },
        {
          key: "client_label",
          label: "Client label",
          maximumLength: 2048,
          required: false,
          secret: false,
          type: "string",
        },
      ],
      integrationName: "GitHub",
      ok: true,
    });
  });

  it("relays custom credentials once and returns only safe auth-config metadata", async () => {
    const clientSecret = "custom-client-secret-value";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse(
        {
          auth_config: {
            auth_scheme: "OAUTH2",
            id: "ac_github_custom",
            is_composio_managed: false,
          },
          toolkit: { slug: "github" },
        },
        201,
      ),
    );

    const result = await createComposioAuthConfigs({ apiKey, fetch: fetchMock }).createCustom({
      authScheme: "OAUTH2",
      credentials: { client_secret: clientSecret },
      integrationSlug: "github",
      name: "Crewhelm github deadbeef",
    });

    expect(result).toEqual({
      authConfig: {
        authConfigId: "ac_github_custom",
        authScheme: "OAUTH2",
        integrationSlug: "github",
        name: "Crewhelm github deadbeef",
        source: "crewhelm_custom",
      },
      ok: true,
    });
    expect(JSON.stringify(result)).not.toContain(clientSecret);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    if (typeof init?.body !== "string") throw new TypeError("Expected serialized request.");
    expect(JSON.parse(init.body)).toEqual({
      auth_config: {
        authScheme: "OAUTH2",
        credentials: { client_secret: clientSecret },
        name: "Crewhelm github deadbeef",
        type: "use_custom_auth",
      },
      toolkit: { slug: "github" },
    });
  });

  it("distinguishes rejected custom credentials from an ambiguous provider outcome", async () => {
    const rejectedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: "invalid credentials" }, { status: 400 }));
    await expect(
      createComposioAuthConfigs({ apiKey, fetch: rejectedFetch }).createCustom({
        authScheme: "API_KEY",
        credentials: { api_key: "rejected-secret" },
        integrationSlug: "linear",
        name: "Crewhelm linear rejected",
      }),
    ).resolves.toEqual({ error: "credentials_rejected", ok: false });

    const unknownFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
    await expect(
      createComposioAuthConfigs({ apiKey, fetch: unknownFetch }).createCustom({
        authScheme: "API_KEY",
        credentials: { api_key: "unknown-secret" },
        integrationSlug: "linear",
        name: "Crewhelm linear unknown",
      }),
    ).resolves.toEqual({ error: "outcome_unknown", ok: false });
  });

  it("recovers an ambiguous managed create and fails closed for unbounded reads", async () => {
    const recoveryFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ items: [existingConfig], next_cursor: null }));

    await expect(
      createComposioAuthConfigs({ apiKey, fetch: recoveryFetch }).createManaged({
        integrationSlug: "github",
        name: "GitHub",
      }),
    ).resolves.toMatchObject({
      authConfig: { authConfigId: existingConfig.id },
      created: false,
      ok: true,
    });

    const unboundedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(toolkit("github")))
      .mockResolvedValueOnce(
        jsonResponse({ items: Array.from({ length: 50 }, () => existingConfig), next_cursor: "2" }),
      );
    await expect(
      createComposioAuthConfigs({ apiKey, fetch: unboundedFetch }).inspect({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it("fails closed for invalid configuration and substituted toolkit responses", async () => {
    const unavailableFetch = vi.fn<typeof fetch>();

    await expect(
      createComposioAuthConfigs({ apiKey: undefined, fetch: unavailableFetch }).inspect({
        integrationSlug: "github",
      }),
    ).resolves.toMatchObject({ ok: false });
    expect(unavailableFetch).not.toHaveBeenCalled();

    const substitutedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(toolkit("slack")));
    const result = await createComposioAuthConfigs({ apiKey, fetch: substitutedFetch }).inspect({
      integrationSlug: "github",
    });

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});
