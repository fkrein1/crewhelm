import {
  connectionAuthConfigIdSchema,
  inspectProviderAuthInputSchema,
  inspectProviderAuthResultSchema,
  integrationSlugSchema,
  providerCredentialFieldsSchema,
  providerAuthSchemeSchema,
  type InspectProviderAuthInput,
  type InspectProviderAuthResult,
  type ProviderAuthConfigReference,
  type ProviderAuthScheme,
  type ProviderCredentialField,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { isUnknownRecord } from "./safe-values.js";

const COMPOSIO_AUTH_CONFIGS_URL = "https://backend.composio.dev/api/v3.1/auth_configs";
const COMPOSIO_TOOLKITS_URL = "https://backend.composio.dev/api/v3.1/toolkits";
const COMPOSIO_CUSTOM_OAUTH_CALLBACK_URL =
  "https://backend.composio.dev/api/v3.1/toolkits/auth/callback";
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
const customAuthConfigCreateSchema = z.looseObject({
  auth_config: composioAuthConfigFieldsSchema.extend({
    is_composio_managed: z.literal(false),
  }),
  toolkit: z.looseObject({
    slug: integrationSlugSchema,
  }),
});
const composioAuthFieldSchema = z.looseObject({
  default: z.string().max(8_192).nullish(),
  displayName: z.string().min(1).max(120),
  is_secret: z.boolean().optional(),
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  required: z.boolean(),
  type: z.string().min(1).max(32),
});
const composioAuthConfigCreationFieldsSchema = z.looseObject({
  optional: z.array(composioAuthFieldSchema).max(16),
  required: z.array(composioAuthFieldSchema).max(16),
});
const composioToolkitSchema = z.looseObject({
  auth_config_details: z
    .array(
      z.looseObject({
        auth_hint_url: z.string().max(2_048).nullish(),
        fields: z
          .looseObject({
            auth_config_creation: composioAuthConfigCreationFieldsSchema,
          })
          .optional(),
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

export type CreateCustomIntegrationAuthConfigResult =
  | {
      authConfig: ProviderAuthConfigReference;
      ok: true;
    }
  | {
      error: "credentials_rejected" | "outcome_unknown";
      ok: false;
    };

export type PrepareCustomIntegrationAuthConfigResult =
  | {
      callbackUrl?: string;
      documentationUrl?: string;
      fields: ProviderCredentialField[];
      integrationName: string;
      ok: true;
    }
  | { error: "unsupported" | "unavailable"; ok: false };

export type ReconcileCustomIntegrationAuthConfigResult =
  | { authConfig: ProviderAuthConfigReference; state: "configured" }
  | { state: "absent" | "still_unknown" };

export interface ComposioAuthConfigs {
  activeCustom(input: {
    integrationSlug: string;
  }): Promise<ProviderAuthConfigReference[] | undefined>;
  createManaged(input: {
    integrationSlug: string;
    name: string;
  }): Promise<CreateManagedIntegrationAuthConfigResult>;
  createCustom(input: {
    authScheme: ProviderAuthScheme;
    credentials: Record<string, string>;
    integrationSlug: string;
    name: string;
  }): Promise<CreateCustomIntegrationAuthConfigResult>;
  inspect(input: InspectProviderAuthInput): Promise<InspectProviderAuthResult>;
  isAvailable(): boolean;
  prepareCustom(input: {
    authScheme: ProviderAuthScheme;
    integrationSlug: string;
  }): Promise<PrepareCustomIntegrationAuthConfigResult>;
  reconcileCustom(input: {
    authScheme: ProviderAuthScheme;
    integrationSlug: string;
    name: string;
  }): Promise<ReconcileCustomIntegrationAuthConfigResult>;
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
  operation: "create" | "create_custom" | "inspect_toolkit" | "list" | "recovery";
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

function normalizeCreatedAuthConfig(
  authConfig: z.infer<typeof composioAuthConfigFieldsSchema>,
  integrationSlug: string,
  name: string,
  source: ProviderAuthConfigReference["source"],
): ProviderAuthConfigReference | null {
  const authScheme = normalizeScheme(authConfig.auth_scheme);

  return authScheme === null
    ? null
    : {
        authConfigId: authConfig.id,
        authScheme,
        integrationSlug,
        name,
        source,
      };
}

function safeDocumentationUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCredentialFields(
  details: z.infer<typeof composioAuthConfigCreationFieldsSchema>,
): ProviderCredentialField[] | null {
  const fields = [...details.required, ...details.optional]
    .filter((field) => field.name !== "oauth_redirect_uri")
    .map((field) => ({
      key: field.name,
      label: field.displayName,
      maximumLength: field.is_secret === false ? 2_048 : 8_192,
      required: field.required,
      secret: field.is_secret !== false,
      type: "string" as const,
    }));

  const parsed = providerCredentialFieldsSchema.safeParse(fields);
  return parsed.success ? parsed.data : null;
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
    managed?: boolean,
  ): Promise<ProviderAuthConfigReference[] | undefined> {
    const endpoint = new URL(COMPOSIO_AUTH_CONFIGS_URL);
    if (managed !== undefined) {
      endpoint.searchParams.set("is_composio_managed", managed ? "true" : "false");
    }
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
          (managed !== undefined && result.data.items[index]?.is_composio_managed !== managed),
      )
    ) {
      return undefined;
    }

    return normalized
      .filter((item): item is ProviderAuthConfigReference => item !== null)
      .toSorted((left, right) => left.authConfigId.localeCompare(right.authConfigId));
  }

  async function reconcileCustom(input: {
    authScheme: ProviderAuthScheme;
    integrationSlug: string;
    name: string;
  }): Promise<ReconcileCustomIntegrationAuthConfigResult> {
    try {
      const recovered = await listActive(input.integrationSlug, "recovery", false);
      if (recovered === undefined) return { state: "still_unknown" };
      const matches = recovered.filter(
        (config) => config.authScheme === input.authScheme && config.name === input.name,
      );
      const match = matches[0];
      return matches.length === 1 && match !== undefined
        ? { authConfig: match, state: "configured" }
        : { state: matches.length === 0 ? "absent" : "still_unknown" };
    } catch {
      return { state: "still_unknown" };
    }
  }

  return {
    async activeCustom(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);
      if (!apiKey.success || !integrationSlug.success) return undefined;
      try {
        return await listActive(integrationSlug.data, "list", false);
      } catch {
        return undefined;
      }
    },
    async createCustom(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);
      const authScheme = providerAuthSchemeSchema.safeParse(input.authScheme);
      const name = z.string().min(1).max(160).safeParse(input.name);
      const credentials = z
        .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().max(8_192))
        .refine((value) => Object.keys(value).length <= 17)
        .safeParse(input.credentials);
      if (
        !apiKey.success ||
        !integrationSlug.success ||
        !authScheme.success ||
        !name.success ||
        !credentials.success
      ) {
        return { error: "outcome_unknown", ok: false };
      }
      const credentialKeys = Object.keys(credentials.data);
      const callback = credentials.data.oauth_redirect_uri;
      if (
        credentialKeys.filter((key) => key !== "oauth_redirect_uri").length > 16 ||
        (callback !== undefined &&
          (authScheme.data !== "OAUTH2" || callback !== COMPOSIO_CUSTOM_OAUTH_CALLBACK_URL))
      ) {
        return { error: "outcome_unknown", ok: false };
      }

      try {
        const startedAt = performance.now();
        const response = await fetchImplementation(COMPOSIO_AUTH_CONFIGS_URL, {
          body: JSON.stringify({
            auth_config: {
              authScheme: authScheme.data,
              credentials: credentials.data,
              name: name.data,
              type: "use_custom_auth",
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
        recordResponse("create_custom", response.status, integrationSlug.data, startedAt);
        if (response.status === 400) return { error: "credentials_rejected", ok: false };

        if (
          response.status === 201 &&
          response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          const body = await readBoundedJson(response, MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES);
          const created = body.ok
            ? customAuthConfigCreateSchema.safeParse(body.value)
            : { success: false as const };
          if (created.success && created.data.toolkit.slug === integrationSlug.data) {
            const authConfig = normalizeCreatedAuthConfig(
              created.data.auth_config,
              integrationSlug.data,
              name.data,
              "crewhelm_custom",
            );
            if (authConfig?.authScheme === authScheme.data) {
              const secrets = Object.values(credentials.data);
              if (
                !containsSecret(authConfig, apiKey.data) &&
                !secrets.some((secret) => secret.length > 0 && containsSecret(authConfig, secret))
              ) {
                return { authConfig, ok: true };
              }
            }
          }
        }

        const recovered = await reconcileCustom({
          authScheme: authScheme.data,
          integrationSlug: integrationSlug.data,
          name: name.data,
        });
        return recovered.state === "configured"
          ? { authConfig: recovered.authConfig, ok: true }
          : { error: "outcome_unknown", ok: false };
      } catch {
        const recovered = await reconcileCustom({
          authScheme: authScheme.data,
          integrationSlug: integrationSlug.data,
          name: name.data,
        });
        return recovered.state === "configured"
          ? { authConfig: recovered.authConfig, ok: true }
          : { error: "outcome_unknown", ok: false };
      }
    },
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
            const authConfig = normalizeCreatedAuthConfig(
              created.data.auth_config,
              integrationSlug.data,
              name.data,
              "composio_managed",
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

        const authConfigs = await listActive(request.data.integrationSlug, "list", true);
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
    async prepareCustom(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);
      const authScheme = providerAuthSchemeSchema.safeParse(input.authScheme);
      if (!apiKey.success || !integrationSlug.success || !authScheme.success) {
        return { error: "unavailable", ok: false };
      }

      try {
        const endpoint = new URL(
          `${COMPOSIO_TOOLKITS_URL}/${encodeURIComponent(integrationSlug.data)}`,
        );
        endpoint.searchParams.set("version", "latest");
        const startedAt = performance.now();
        const response = await fetchImplementation(endpoint, {
          headers: { accept: "application/json", "x-api-key": apiKey.data },
          method: "GET",
          redirect: "manual",
          signal: signal(),
        });
        recordResponse("inspect_toolkit", response.status, integrationSlug.data, startedAt);
        if (
          response.status !== 200 ||
          !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          return { error: "unavailable", ok: false };
        }
        const body = await readBoundedJson(response, MAXIMUM_TOOLKIT_RESPONSE_BYTES);
        const toolkit = body.ok
          ? composioToolkitSchema.safeParse(body.value)
          : { success: false as const };
        if (!toolkit.success || toolkit.data.slug !== integrationSlug.data) {
          return { error: "unavailable", ok: false };
        }
        const matchingDetails = toolkit.data.auth_config_details.filter(
          (detail) => normalizeScheme(detail.mode) === authScheme.data,
        );
        const details = matchingDetails.length === 1 ? matchingDetails[0] : undefined;
        const creation = details?.fields?.auth_config_creation;
        if (details === undefined || creation === undefined) {
          return { error: "unsupported", ok: false };
        }
        if (
          creation.required.some((field) => !field.required) ||
          creation.optional.some((field) => field.required) ||
          [...creation.required, ...creation.optional].some(
            (field) =>
              field.type.toLowerCase() !== "string" || (field.is_secret === true && field.default),
          )
        ) {
          return { error: "unsupported", ok: false };
        }
        const fields = normalizeCredentialFields(creation);
        if (fields === null) return { error: "unsupported", ok: false };
        const documentationUrl = safeDocumentationUrl(details.auth_hint_url);
        const result: PrepareCustomIntegrationAuthConfigResult = {
          ...(authScheme.data === "OAUTH2"
            ? { callbackUrl: COMPOSIO_CUSTOM_OAUTH_CALLBACK_URL }
            : {}),
          ...(documentationUrl === undefined ? {} : { documentationUrl }),
          fields,
          integrationName: toolkit.data.name,
          ok: true,
        };
        return containsSecret(result, apiKey.data) ? { error: "unavailable", ok: false } : result;
      } catch {
        return { error: "unavailable", ok: false };
      }
    },
    reconcileCustom,
  };
}
