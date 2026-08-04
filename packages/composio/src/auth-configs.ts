import {
  connectionAuthConfigIdSchema,
  inspectProviderAuthInputSchema,
  inspectProviderAuthResultSchema,
  integrationSlugSchema,
  providerAuthSchemeSchema,
  type InspectProviderAuthInput,
  type InspectProviderAuthResult,
  type ProviderAuthConfigReference,
  type ProviderAuthScheme,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { isUnknownRecord } from "./safe-values.js";

const COMPOSIO_AUTH_CONFIGS_URL = "https://backend.composio.dev/api/v3.1/auth_configs";
const COMPOSIO_TOOLKITS_URL = "https://backend.composio.dev/api/v3.1/toolkits";
const AUTH_CONFIG_TIMEOUT_MS = 5_000;
const MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES = 256 * 1_024;
const MAXIMUM_TOOLKIT_RESPONSE_BYTES = 256 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioAuthConfigFieldsSchema = z.looseObject({
  auth_scheme: z.string().min(1).max(64),
  id: connectionAuthConfigIdSchema,
  is_composio_managed: z.boolean(),
});
const composioAuthConfigSchema = composioAuthConfigFieldsSchema.extend({
  name: z.string().min(1).max(160),
  status: z.literal("ENABLED"),
  toolkit: z.looseObject({
    slug: integrationSlugSchema,
  }),
});
const composioAuthConfigListSchema = z.looseObject({
  items: z.array(composioAuthConfigSchema).max(50),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const managedAuthConfigCreateSchema = z.looseObject({
  auth_config: composioAuthConfigFieldsSchema.extend({
    is_composio_managed: z.literal(true),
  }),
  toolkit: z.looseObject({
    slug: integrationSlugSchema,
  }),
});
const composioToolkitSchema = z.looseObject({
  auth_config_details: z
    .array(
      z.looseObject({
        mode: z.string().min(1).max(64),
      }),
    )
    .max(16),
  composio_managed_auth_schemes: z.array(z.string().min(1).max(64)).max(16),
  enabled: z.literal(true).optional(),
  name: z.string().min(1).max(160),
  no_auth: z.boolean().optional(),
  slug: integrationSlugSchema,
});

export type CreateManagedIntegrationAuthConfigResult =
  | {
      authConfig: ProviderAuthConfigReference;
      created: boolean;
      ok: true;
    }
  | {
      error: {
        code: "integration_enablement_outcome_unknown";
        message: "Integration enablement request denied.";
      };
      ok: false;
    };

export interface ComposioAuthConfigs {
  createManaged(input: {
    integrationSlug: string;
    name: string;
  }): Promise<CreateManagedIntegrationAuthConfigResult>;
  inspect(input: InspectProviderAuthInput): Promise<InspectProviderAuthResult>;
  isAvailable(): boolean;
}

export interface ComposioAuthConfigsOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  onResponse?: (event: ComposioAuthConfigResponseEvent) => void;
  signal?: AbortSignal;
}

export interface ComposioAuthConfigResponseEvent {
  durationMs: number;
  integrationSlug: string;
  operation: "create" | "inspect_toolkit" | "list" | "recovery";
  status: number;
}

function outcomeUnknown(): CreateManagedIntegrationAuthConfigResult {
  return {
    error: {
      code: "integration_enablement_outcome_unknown",
      message: "Integration enablement request denied.",
    },
    ok: false,
  };
}

function unavailableInspection(): InspectProviderAuthResult {
  return {
    error: {
      code: "provider_auth_unavailable",
      message: "Provider authentication request denied.",
    },
    ok: false,
  };
}

function normalizeScheme(value: string): ProviderAuthScheme | null {
  const parsed = providerAuthSchemeSchema.safeParse(value.toUpperCase());
  return parsed.success ? parsed.data : null;
}

function uniqueSchemes(values: readonly string[]): ProviderAuthScheme[] {
  const schemes: ProviderAuthScheme[] = [];

  for (const value of values) {
    const scheme = normalizeScheme(value);
    if (scheme !== null && !schemes.includes(scheme)) schemes.push(scheme);
  }

  return schemes;
}

function normalizeAuthConfig(
  authConfig: z.infer<typeof composioAuthConfigSchema>,
): ProviderAuthConfigReference | null {
  const authScheme = normalizeScheme(authConfig.auth_scheme);

  return authScheme === null
    ? null
    : {
        authConfigId: authConfig.id,
        authScheme,
        integrationSlug: authConfig.toolkit.slug,
        name: authConfig.name,
        source: authConfig.is_composio_managed ? "composio_managed" : "crewhelm_custom",
      };
}

function normalizeCreatedManagedAuthConfig(
  authConfig: z.infer<typeof managedAuthConfigCreateSchema>["auth_config"],
  integrationSlug: string,
  name: string,
): ProviderAuthConfigReference | null {
  const authScheme = normalizeScheme(authConfig.auth_scheme);

  return authScheme === null
    ? null
    : {
        authConfigId: authConfig.id,
        authScheme,
        integrationSlug,
        name,
        source: "composio_managed",
      };
}

function containsSecret(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === "string" && current.includes(secret)) return true;

    if (Array.isArray(current)) {
      for (const item of current as unknown[]) pending.push(item);
      continue;
    }

    if (isUnknownRecord(current)) {
      for (const [key, item] of Object.entries(current)) {
        if (key.includes(secret)) return true;
        pending.push(item);
      }
    }
  }

  return false;
}

export function createComposioAuthConfigs(
  options: ComposioAuthConfigsOptions,
): ComposioAuthConfigs {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  function recordResponse(
    operation: ComposioAuthConfigResponseEvent["operation"],
    status: number,
    integrationSlug: string,
    startedAt: number,
  ) {
    try {
      options.onResponse?.({
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        integrationSlug,
        operation,
        status,
      });
    } catch {
      // Diagnostic telemetry must not alter provider behavior.
    }
  }

  function signal(): AbortSignal {
    return options.signal === undefined
      ? AbortSignal.timeout(AUTH_CONFIG_TIMEOUT_MS)
      : AbortSignal.any([options.signal, AbortSignal.timeout(AUTH_CONFIG_TIMEOUT_MS)]);
  }

  async function listActive(
    integrationSlug: string,
    operation: Extract<ComposioAuthConfigResponseEvent["operation"], "list" | "recovery">,
    managedOnly = false,
  ): Promise<ProviderAuthConfigReference[] | undefined> {
    const endpoint = new URL(COMPOSIO_AUTH_CONFIGS_URL);
    if (managedOnly) endpoint.searchParams.set("is_composio_managed", "true");
    endpoint.searchParams.set("limit", "50");
    endpoint.searchParams.set("show_disabled", "false");
    endpoint.searchParams.set("toolkit_slug", integrationSlug);
    const startedAt = performance.now();
    const response = await fetchImplementation(endpoint, {
      headers: {
        accept: "application/json",
        "x-api-key": apiKey.success ? apiKey.data : "",
      },
      method: "GET",
      redirect: "manual",
      signal: signal(),
    });
    recordResponse(operation, response.status, integrationSlug, startedAt);

    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return undefined;
    }

    const body = await readBoundedJson(response, MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES);
    if (!body.ok) return undefined;
    const result = composioAuthConfigListSchema.safeParse(body.value);
    if (!result.success || result.data.next_cursor != null) return undefined;

    const normalized = result.data.items.map(normalizeAuthConfig);
    if (
      normalized.some(
        (item, index) =>
          item === null ||
          item.integrationSlug !== integrationSlug ||
          (managedOnly && result.data.items[index]?.is_composio_managed !== true),
      )
    ) {
      return undefined;
    }

    return normalized
      .filter((item): item is ProviderAuthConfigReference => item !== null)
      .toSorted((left, right) => left.authConfigId.localeCompare(right.authConfigId));
  }

  return {
    async createManaged(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);
      const name = z.string().min(1).max(160).safeParse(input.name);

      if (!apiKey.success || !integrationSlug.success || !name.success) return outcomeUnknown();

      try {
        const existing = await listActive(integrationSlug.data, "recovery", true);
        if (existing === undefined) return outcomeUnknown();
        if (existing[0] !== undefined) {
          return containsSecret(existing[0], apiKey.data)
            ? outcomeUnknown()
            : { authConfig: existing[0], created: false, ok: true };
        }

        const startedAt = performance.now();
        const response = await fetchImplementation(COMPOSIO_AUTH_CONFIGS_URL, {
          body: JSON.stringify({
            auth_config: {
              credentials: {},
              restrict_to_following_tools: [],
              type: "use_composio_managed_auth",
            },
            toolkit: { slug: integrationSlug.data },
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": apiKey.data,
          },
          method: "POST",
          redirect: "manual",
          signal: signal(),
        });
        recordResponse("create", response.status, integrationSlug.data, startedAt);

        if (
          response.status === 201 &&
          response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          const body = await readBoundedJson(response, MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES);
          const created = body.ok
            ? managedAuthConfigCreateSchema.safeParse(body.value)
            : { success: false as const };

          if (created.success && created.data.toolkit.slug === integrationSlug.data) {
            const authConfig = normalizeCreatedManagedAuthConfig(
              created.data.auth_config,
              integrationSlug.data,
              name.data,
            );

            if (authConfig !== null && !containsSecret(authConfig, apiKey.data)) {
              return { authConfig, created: true, ok: true };
            }
          }
        }

        const recovered = await listActive(integrationSlug.data, "recovery", true);
        return recovered?.[0] === undefined || containsSecret(recovered[0], apiKey.data)
          ? outcomeUnknown()
          : { authConfig: recovered[0], created: false, ok: true };
      } catch {
        return outcomeUnknown();
      }
    },
    async inspect(input) {
      const request = inspectProviderAuthInputSchema.safeParse(input);
      if (!apiKey.success || !request.success) return unavailableInspection();

      try {
        const endpoint = new URL(
          `${COMPOSIO_TOOLKITS_URL}/${encodeURIComponent(request.data.integrationSlug)}`,
        );
        endpoint.searchParams.set("version", "latest");
        const startedAt = performance.now();
        const response = await fetchImplementation(endpoint, {
          headers: { accept: "application/json", "x-api-key": apiKey.data },
          method: "GET",
          redirect: "manual",
          signal: signal(),
        });
        recordResponse("inspect_toolkit", response.status, request.data.integrationSlug, startedAt);

        if (response.status === 404) {
          return inspectProviderAuthResultSchema.parse({
            authentication: { reason: "toolkit_unavailable", state: "unsupported" },
            integration: { name: request.data.integrationSlug, slug: request.data.integrationSlug },
            ok: true,
          });
        }

        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return unavailableInspection();
        }

        const body = await readBoundedJson(response, MAXIMUM_TOOLKIT_RESPONSE_BYTES);
        const toolkit = body.ok
          ? composioToolkitSchema.safeParse(body.value)
          : { success: false as const };
        if (!toolkit.success || toolkit.data.slug !== request.data.integrationSlug) {
          return unavailableInspection();
        }

        const integration = { name: toolkit.data.name, slug: toolkit.data.slug };
        const availableSchemes = uniqueSchemes(
          toolkit.data.auth_config_details.map((detail) => detail.mode),
        );
        if (toolkit.data.no_auth === true || availableSchemes.length === 0) {
          return inspectProviderAuthResultSchema.parse({
            authentication: { reason: "auth_scheme_unsupported", state: "unsupported" },
            integration,
            ok: true,
          });
        }

        const authConfigs = await listActive(request.data.integrationSlug, "list");
        if (
          authConfigs === undefined ||
          authConfigs.some((config) => !availableSchemes.includes(config.authScheme))
        ) {
          return unavailableInspection();
        }

        const authentication =
          authConfigs.length === 1
            ? { selected: authConfigs[0], state: "ready" as const }
            : authConfigs.length > 1
              ? { choices: authConfigs, state: "selection_required" as const }
              : (() => {
                  const managedSchemes = uniqueSchemes(
                    toolkit.data.composio_managed_auth_schemes,
                  ).filter((scheme) => availableSchemes.includes(scheme));

                  return {
                    availableSchemes,
                    managedAuthAvailable: managedSchemes.length > 0,
                    recommendedScheme: managedSchemes[0] ?? availableSchemes[0],
                    state: "setup_required" as const,
                  };
                })();
        const result = inspectProviderAuthResultSchema.parse({
          authentication,
          integration,
          ok: true,
        });

        return containsSecret(result, apiKey.data) ? unavailableInspection() : result;
      } catch {
        return unavailableInspection();
      }
    },
    isAvailable() {
      return apiKey.success;
    },
  };
}
