import {
  integrationCatalogSearchInputSchema,
  integrationCatalogSearchResultSchema,
  inspectIntegrationToolInputSchema,
  inspectIntegrationToolResultSchema,
  integrationToolkitVersionSchema,
  integrationToolParameterMapSchema,
  integrationToolSearchInputSchema,
  integrationToolSearchResultSchema,
  type IntegrationCatalogItem,
  type IntegrationCatalogSearchInput,
  type IntegrationCatalogSearchResult,
  type InspectIntegrationToolInput,
  type InspectIntegrationToolResult,
  type IntegrationToolCatalogItem,
  type IntegrationToolInspection,
  type IntegrationToolSearchInput,
  type IntegrationToolSearchResult,
} from "@crewhelm/contracts";
import * as z from "zod";

import { readBoundedJson } from "./bounded-json.js";
import { isUnknownRecord } from "./safe-values.js";

export {
  createComposioAuthConfigs,
  type ComposioAuthConfigs,
  type CreateCustomIntegrationAuthConfigResult,
  type CreateManagedIntegrationAuthConfigResult,
  type PrepareCustomIntegrationAuthConfigResult,
  type ReconcileCustomIntegrationAuthConfigResult,
} from "./auth-configs.js";

const COMPOSIO_TOOLKITS_URL = "https://backend.composio.dev/api/v3/toolkits";
const COMPOSIO_TOOLS_URL = "https://backend.composio.dev/api/v3.1/tools";
const MAXIMUM_TOOLKIT_RESPONSE_BYTES = 256 * 1_024;
const MAXIMUM_TOOL_RESPONSE_BYTES = 1_024 * 1_024;
const CATALOG_TIMEOUT_MS = 5_000;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioToolkitSchema = z.looseObject({
  auth_schemes: z.array(z.string().min(1).max(64)).max(16).optional(),
  meta: z.looseObject({
    description: z.string().max(2_000).nullish(),
    logo: z.string().max(2_048).nullish(),
    tools_count: z.number().int().min(0).max(1_000_000),
    version: integrationToolkitVersionSchema,
  }),
  name: z.string().min(1).max(160),
  no_auth: z.boolean().optional(),
  slug: z.string().min(1).max(128),
});
const composioCatalogResponseSchema = z.looseObject({
  items: z.array(composioToolkitSchema).max(50),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const composioToolSchema = z.looseObject({
  description: z.string().max(2_000).nullish(),
  is_deprecated: z.literal(false).optional(),
  name: z.string().min(1).max(160),
  no_auth: z.boolean().optional(),
  scopes: z.array(z.string().min(1).max(512)).max(32).nullish(),
  slug: z.string().min(1).max(256),
  tags: z.array(z.string().min(1).max(64)).max(32).nullish(),
  toolkit: z.looseObject({
    name: z.string().min(1).max(160),
    slug: z.string().min(1).max(128),
  }),
  version: integrationToolkitVersionSchema,
});
const composioToolCatalogResponseSchema = z.looseObject({
  items: z.array(composioToolSchema).max(20),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});
const composioToolInspectionSchema = composioToolSchema.extend({
  input_parameters: integrationToolParameterMapSchema,
  is_deprecated: z.literal(false),
  output_parameters: integrationToolParameterMapSchema,
});

export interface ComposioCatalog {
  inspectTool(input: InspectIntegrationToolInput): Promise<InspectIntegrationToolResult>;
  search(input: IntegrationCatalogSearchInput): Promise<IntegrationCatalogSearchResult>;
  searchTools(input: IntegrationToolSearchInput): Promise<IntegrationToolSearchResult>;
}

export interface ComposioCatalogOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

type CatalogResponse = { ok: true; value: unknown } | { ok: false };

function unavailable() {
  return {
    error: {
      code: "integration_catalog_unavailable" as const,
      message: "Integration catalog request denied." as const,
    },
    ok: false as const,
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
      for (const item of current as unknown[]) {
        pending.push(item);
      }
      continue;
    }

    if (isUnknownRecord(current)) {
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

function normalizeToolkit(toolkit: z.infer<typeof composioToolkitSchema>): IntegrationCatalogItem {
  return {
    authSchemes: toolkit.auth_schemes?.map((scheme) => scheme.toLowerCase()) ?? null,
    description: toolkit.meta.description ?? null,
    logoUrl: safeHttpsUrl(toolkit.meta.logo),
    name: toolkit.name,
    noAuth: toolkit.no_auth ?? null,
    slug: toolkit.slug,
    toolsCount: toolkit.meta.tools_count,
    version: toolkit.meta.version,
  };
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  if (value == null) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function normalizeTool(tool: z.infer<typeof composioToolSchema>): IntegrationToolCatalogItem {
  return {
    description: tool.description ?? null,
    integration: {
      name: tool.toolkit.name,
      slug: tool.toolkit.slug,
    },
    name: tool.name,
    noAuth: tool.no_auth ?? null,
    requiredScopes: tool.scopes ?? null,
    slug: tool.slug,
    tags: tool.tags ?? [],
    version: tool.version,
  };
}

function normalizeToolInspection(
  tool: z.infer<typeof composioToolInspectionSchema>,
): IntegrationToolInspection {
  return {
    ...normalizeTool(tool),
    inputParameters: tool.input_parameters,
    outputParameters: tool.output_parameters,
  };
}

export function createComposioCatalog(options: ComposioCatalogOptions): ComposioCatalog {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  async function fetchCatalog(endpoint: URL, maximumBytes: number): Promise<CatalogResponse> {
    if (!apiKey.success) {
      return { ok: false };
    }

    try {
      const response = await fetchImplementation(endpoint, {
        headers: {
          accept: "application/json",
          "x-api-key": apiKey.data,
        },
        method: "GET",
        redirect: "manual",
        signal:
          options.signal === undefined
            ? AbortSignal.timeout(CATALOG_TIMEOUT_MS)
            : AbortSignal.any([options.signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
      });

      if (
        response.status !== 200 ||
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
      ) {
        return { ok: false };
      }

      const body = await readBoundedJson(response, maximumBytes);
      return body.ok ? body : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  return {
    async inspectTool(input) {
      const request = inspectIntegrationToolInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return unavailable();
      }

      const endpoint = new URL(`${COMPOSIO_TOOLS_URL}/${encodeURIComponent(request.data.slug)}`);
      endpoint.searchParams.set("version", request.data.version);

      try {
        const response = await fetchCatalog(endpoint, MAXIMUM_TOOL_RESPONSE_BYTES);
        if (!response.ok) return unavailable();
        const inspected = composioToolInspectionSchema.safeParse(response.value);

        if (
          !inspected.success ||
          inspected.data.slug !== request.data.slug ||
          inspected.data.version !== request.data.version
        ) {
          return unavailable();
        }

        const result = inspectIntegrationToolResultSchema.parse({
          ok: true,
          tool: normalizeToolInspection(inspected.data),
        });

        return containsSecret(result, apiKey.data) ? unavailable() : result;
      } catch {
        return unavailable();
      }
    },
    async search(input) {
      const request = integrationCatalogSearchInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return unavailable();
      }

      const endpoint = new URL(COMPOSIO_TOOLKITS_URL);
      endpoint.searchParams.set("include_deprecated", "false");
      endpoint.searchParams.set("limit", String(request.data.limit));
      endpoint.searchParams.set("managed_by", "all");
      endpoint.searchParams.set("sort_by", "usage");

      if (request.data.cursor !== undefined) {
        endpoint.searchParams.set("cursor", request.data.cursor);
      }

      if (request.data.query !== undefined) {
        endpoint.searchParams.set("search", request.data.query);
      }

      try {
        const response = await fetchCatalog(endpoint, MAXIMUM_TOOLKIT_RESPONSE_BYTES);
        if (!response.ok) return unavailable();
        const catalog = composioCatalogResponseSchema.safeParse(response.value);

        if (!catalog.success) {
          return unavailable();
        }

        const result = integrationCatalogSearchResultSchema.parse({
          integrations: catalog.data.items.map(normalizeToolkit),
          nextCursor: catalog.data.next_cursor ?? null,
          ok: true,
        });

        return containsSecret(result, apiKey.data) ? unavailable() : result;
      } catch {
        return unavailable();
      }
    },
    async searchTools(input) {
      const request = integrationToolSearchInputSchema.safeParse(input);

      if (!apiKey.success || !request.success) {
        return unavailable();
      }

      const endpoint = new URL(COMPOSIO_TOOLS_URL);
      endpoint.searchParams.set("include_deprecated", "false");
      endpoint.searchParams.set("limit", String(request.data.limit));
      endpoint.searchParams.set("toolkit_versions", "latest");

      if (request.data.cursor !== undefined) {
        endpoint.searchParams.set("cursor", request.data.cursor);
      }

      if (request.data.integrationSlug !== undefined) {
        endpoint.searchParams.set("toolkit_slug", request.data.integrationSlug);
      }

      if (request.data.query !== undefined) {
        endpoint.searchParams.set("query", request.data.query);
      }

      try {
        const response = await fetchCatalog(endpoint, MAXIMUM_TOOL_RESPONSE_BYTES);
        if (!response.ok) return unavailable();
        const catalog = composioToolCatalogResponseSchema.safeParse(response.value);

        if (!catalog.success) {
          return unavailable();
        }

        const result = integrationToolSearchResultSchema.parse({
          nextCursor: catalog.data.next_cursor ?? null,
          ok: true,
          tools: catalog.data.items.map(normalizeTool),
        });

        return containsSecret(result, apiKey.data) ? unavailable() : result;
      } catch {
        return unavailable();
      }
    },
  };
}

export {
  createComposioRuntime,
  type ComposioConnectionVerificationResult,
  type ComposioRuntime,
  type ComposioRuntimeOptions,
} from "./execution.js";
export {
  createComposioConnectionLinks,
  type ComposioConnectionLink,
  type ComposioConnectionLinkResult,
  type ComposioConnectionLinks,
  type ComposioConnectionLinksOptions,
} from "./connection-links.js";
export {
  composioEventMatchesConfiguration,
  composioProviderTriggerConfiguration,
  createComposioEventCatalog,
  type ComposioEventCatalog,
  type ComposioEventCatalogOptions,
  type ComposioProviderTriggerConfigurationResult,
  type ComposioTriggerableEvent,
  type ComposioTriggerableEventCatalogResult,
  type ComposioTriggerableEventConfigurationField,
} from "./triggers.js";
export {
  createComposioTriggerInstances,
  type ComposioTriggerInstanceResult,
  type ComposioTriggerInstances,
  type ComposioTriggerInstancesOptions,
  type ComposioTriggerManageResult,
} from "./trigger-instances.js";
export {
  createComposioWebhookSubscriptions,
  verifiedComposioTriggerEventSchema,
  verifyComposioTriggerEvent,
  type ComposioWebhookSubscription,
  type ComposioWebhookSubscriptions,
  type ComposioWebhookSubscriptionsOptions,
  type EnsureComposioWebhookSubscriptionResult,
  type VerifiedComposioTriggerEvent,
  type VerifyComposioTriggerEventInput,
  type VerifyComposioTriggerEventResult,
} from "./webhook-subscriptions.js";
