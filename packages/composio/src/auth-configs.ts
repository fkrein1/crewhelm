import {
  connectionAuthConfigIdSchema,
  integrationSlugSchema,
  type EnableIntegrationInput,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";

const COMPOSIO_AUTH_CONFIGS_URL = "https://backend.composio.dev/api/v3.1/auth_configs";
const AUTH_CONFIG_TIMEOUT_MS = 5_000;
const MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES = 256 * 1_024;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const managedAuthConfigFieldsSchema = z.looseObject({
  auth_scheme: z.string().min(1).max(64),
  id: connectionAuthConfigIdSchema,
  is_composio_managed: z.literal(true),
});
const managedAuthConfigSchema = managedAuthConfigFieldsSchema.extend({
  toolkit: z.looseObject({
    slug: integrationSlugSchema,
  }),
});
const managedAuthConfigListSchema = z.looseObject({
  items: z
    .array(
      managedAuthConfigSchema.extend({
        status: z.literal("ENABLED"),
      }),
    )
    .max(50),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const managedAuthConfigCreateSchema = z.looseObject({
  auth_config: managedAuthConfigFieldsSchema,
  toolkit: z.looseObject({
    slug: integrationSlugSchema,
  }),
});

export interface ManagedIntegrationAuthConfig {
  authConfigId: string;
  authScheme: string;
  integrationSlug: string;
  managed: true;
}

export type EnsureManagedIntegrationAuthConfigResult =
  | {
      authConfig: ManagedIntegrationAuthConfig;
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
  ensureManaged(
    input: Pick<EnableIntegrationInput, "integrationSlug">,
  ): Promise<EnsureManagedIntegrationAuthConfigResult>;
  isAvailable(): boolean;
}

export interface ComposioAuthConfigsOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function outcomeUnknown(): EnsureManagedIntegrationAuthConfigResult {
  return {
    error: {
      code: "integration_enablement_outcome_unknown",
      message: "Integration enablement request denied.",
    },
    ok: false,
  };
}

function normalize(
  authConfig: z.infer<typeof managedAuthConfigFieldsSchema>,
  integrationSlug: string,
): ManagedIntegrationAuthConfig {
  return {
    authConfigId: authConfig.id,
    authScheme: authConfig.auth_scheme.toLowerCase(),
    integrationSlug,
    managed: true,
  };
}

function containsSecret(value: unknown, secret: string): boolean {
  const pending: unknown[] = [value];

  while (pending.length > 0) {
    const current = pending.pop();

    if (typeof current === "string" && current.includes(secret)) {
      return true;
    }

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }

    if (typeof current === "object" && current !== null) {
      for (const [key, item] of Object.entries(current)) {
        if (key.includes(secret)) {
          return true;
        }

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

  function signal(): AbortSignal {
    return options.signal === undefined
      ? AbortSignal.timeout(AUTH_CONFIG_TIMEOUT_MS)
      : AbortSignal.any([options.signal, AbortSignal.timeout(AUTH_CONFIG_TIMEOUT_MS)]);
  }

  async function findManaged(
    integrationSlug: string,
  ): Promise<ManagedIntegrationAuthConfig | null | undefined> {
    const endpoint = new URL(COMPOSIO_AUTH_CONFIGS_URL);
    endpoint.searchParams.set("is_composio_managed", "true");
    endpoint.searchParams.set("limit", "50");
    endpoint.searchParams.set("show_disabled", "false");
    endpoint.searchParams.set("toolkit_slug", integrationSlug);
    const response = await fetchImplementation(endpoint, {
      headers: {
        accept: "application/json",
        "x-api-key": apiKey.success ? apiKey.data : "",
      },
      method: "GET",
      redirect: "manual",
      signal: signal(),
    });

    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return undefined;
    }

    const result = managedAuthConfigListSchema.safeParse(
      await readBoundedJson(response, MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES),
    );

    if (
      !result.success ||
      result.data.items.some((item) => item.toolkit.slug !== integrationSlug) ||
      (result.data.items.length === 0 && result.data.next_cursor != null)
    ) {
      return undefined;
    }

    const selected = result.data.items
      .map((item) => normalize(item, item.toolkit.slug))
      .toSorted((left, right) => left.authConfigId.localeCompare(right.authConfigId))[0];

    return selected ?? null;
  }

  return {
    async ensureManaged(input) {
      const integrationSlug = integrationSlugSchema.safeParse(input.integrationSlug);

      if (!apiKey.success || !integrationSlug.success) {
        return outcomeUnknown();
      }

      try {
        const existing = await findManaged(integrationSlug.data);

        if (existing === undefined) {
          return outcomeUnknown();
        }

        if (existing !== null) {
          return containsSecret(existing, apiKey.data)
            ? outcomeUnknown()
            : { authConfig: existing, created: false, ok: true };
        }

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

        if (
          response.status === 201 &&
          response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
        ) {
          const created = managedAuthConfigCreateSchema.safeParse(
            await readBoundedJson(response, MAXIMUM_AUTH_CONFIG_RESPONSE_BYTES),
          );

          if (created.success && created.data.toolkit.slug === integrationSlug.data) {
            const authConfig = normalize(created.data.auth_config, created.data.toolkit.slug);

            return containsSecret(authConfig, apiKey.data)
              ? outcomeUnknown()
              : { authConfig, created: true, ok: true };
          }
        }

        const recovered = await findManaged(integrationSlug.data);

        return recovered === null ||
          recovered === undefined ||
          containsSecret(recovered, apiKey.data)
          ? outcomeUnknown()
          : { authConfig: recovered, created: false, ok: true };
      } catch {
        return outcomeUnknown();
      }
    },
    isAvailable() {
      return apiKey.success;
    },
  };
}
