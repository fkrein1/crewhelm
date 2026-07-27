import {
  integrationCatalogSearchInputSchema,
  integrationCatalogSearchResultSchema,
  type IntegrationCatalogItem,
  type IntegrationCatalogSearchInput,
  type IntegrationCatalogSearchResult,
} from "@crewhelm/contracts";
import * as z from "zod";

const COMPOSIO_TOOLKITS_URL = "https://backend.composio.dev/api/v3/toolkits";
const MAXIMUM_CATALOG_RESPONSE_BYTES = 256 * 1_024;
const CATALOG_TIMEOUT_MS = 5_000;

const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const composioToolkitSchema = z.looseObject({
  auth_schemes: z.array(z.string().min(1).max(64)).max(16).optional(),
  meta: z.looseObject({
    description: z.string().max(2_000).nullish(),
    tools_count: z.number().int().min(0).max(1_000_000),
    version: z.string().min(1).max(128),
  }),
  name: z.string().min(1).max(160),
  no_auth: z.boolean().optional(),
  slug: z.string().min(1).max(128),
});
const composioCatalogResponseSchema = z.looseObject({
  items: z.array(composioToolkitSchema).max(50),
  next_cursor: z.string().min(1).max(2_048).nullish(),
});

export interface ComposioCatalog {
  search(input: IntegrationCatalogSearchInput): Promise<IntegrationCatalogSearchResult>;
}

export interface ComposioCatalogOptions {
  apiKey: string | undefined;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  while (true) {
    const result = await reader.read();

    if (result.done) {
      break;
    }

    byteLength += result.value.byteLength;

    if (byteLength > MAXIMUM_CATALOG_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Composio catalog response exceeded the bounded reader.");
    }

    chunks.push(result.value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
}

function unavailable(): IntegrationCatalogSearchResult {
  return {
    error: {
      code: "integration_catalog_unavailable",
      message: "Integration catalog request denied.",
    },
    ok: false,
  };
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") {
    return value.includes(secret);
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsSecret(item, secret));
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsSecret(item, secret));
  }

  return false;
}

function normalizeToolkit(toolkit: z.infer<typeof composioToolkitSchema>): IntegrationCatalogItem {
  return {
    authSchemes: toolkit.auth_schemes?.map((scheme) => scheme.toLowerCase()) ?? null,
    description: toolkit.meta.description ?? null,
    name: toolkit.name,
    noAuth: toolkit.no_auth ?? null,
    slug: toolkit.slug,
    toolsCount: toolkit.meta.tools_count,
    version: toolkit.meta.version,
  };
}

export function createComposioCatalog(options: ComposioCatalogOptions): ComposioCatalog {
  const apiKey = composioApiKeySchema.safeParse(options.apiKey);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
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
          return unavailable();
        }

        const catalog = composioCatalogResponseSchema.safeParse(await readBoundedJson(response));

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
  };
}
