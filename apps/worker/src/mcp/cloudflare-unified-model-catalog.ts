import {
  MAXIMUM_MODEL_BROWSE_SCAN_ITEMS,
  cloudflareModelBrowseItemSchema,
  type CloudflareModelBrowseItem,
} from "@crewhelm/contracts";
import * as z from "zod";

import { bundledCloudflareUnifiedModelCatalog } from "./cloudflare-unified-model-catalog.snapshot.js";

const CATALOG_CACHE_KEY = 1;
const CATALOG_SOURCE_DIRECTORY = "src/content/catalog-models";
const CATALOG_SOURCE_URL =
  "https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/catalog-models";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com";
const MAXIMUM_CATALOG_BYTES = 1024 * 1024;
const MAXIMUM_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;
const SOURCE_FETCH_CONCURRENCY = 8;

const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const catalogSnapshotSchema = z.strictObject({
  models: z
    .array(cloudflareModelBrowseItemSchema)
    .max(MAXIMUM_MODEL_BROWSE_SCAN_ITEMS)
    .refine(
      (models) => models.every((model) => model.runtimeCompatibility === "compatible"),
      "Expected only agent-compatible models.",
    ),
  refreshedAt: z.iso.datetime(),
  sourceCommit: sourceCommitSchema,
  sourceUrl: z.literal(CATALOG_SOURCE_URL),
  status: z.enum(["last-known-good", "bundled-fallback"]),
});
const githubCommitSchema = z.looseObject({ sha: sourceCommitSchema });
const githubContentSchema = z.looseObject({
  name: z.string().regex(/^[a-zA-Z0-9._-]+\.json$/),
  size: z.number().int().nonnegative().max(MAXIMUM_SOURCE_FILE_BYTES),
  type: z.literal("file"),
});
const upstreamCatalogModelSchema = z.looseObject({
  created_at: z.string().min(1).max(64).nullable().optional(),
  description: z.string().max(10_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  model_id: z.string().min(3).max(160),
  name: z.string().min(1).max(240),
  request_formats: z
    .array(z.string().min(1).max(80))
    .max(8)
    .nullish()
    .transform((formats) => formats ?? []),
  schema: z.looseObject({ input: z.unknown().optional() }).optional(),
  tags: z.array(z.string().min(1).max(120)).max(64).default([]),
  task: z.string().min(1).max(120),
  zdr: z.boolean().optional(),
});
const storedCatalogRowSchema = z.strictObject({
  catalog: z.string(),
  source_commit: sourceCommitSchema,
});

export type CloudflareUnifiedModelCatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export type CloudflareUnifiedModelCatalogRefreshResult =
  | { modelCount: number; sourceCommit: string; status: "refreshed" }
  | { modelCount: number; sourceCommit: string; status: "unchanged" };

function githubHeaders(accept: string): HeadersInit {
  return { accept, "user-agent": "crewhelm-model-catalog" };
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.ok) throw new Error("catalog source request failed");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("catalog source response exceeded its bound");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > maximumBytes) {
    throw new Error("catalog source response exceeded its bound");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function providerFrom(modelId: string): string {
  return modelId.split("/", 1)[0] ?? modelId;
}

function normalizedCreatedAt(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizedFacts(model: z.infer<typeof upstreamCatalogModelSchema>): string {
  return [model.name, model.description, model.task, ...model.tags, JSON.stringify(model.metadata)]
    .join(" ")
    .toLowerCase()
    .replaceAll(/[_-]+/g, " ");
}

function schemaDeclaresProperty(schema: unknown, property: string): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: schema }];
  let visited = 0;
  while (pending.length > 0 && visited < 10_000) {
    const current = pending.pop();
    if (current === undefined) break;
    visited += 1;
    if (current.depth > 32 || current.value === null || typeof current.value !== "object") continue;
    if (!Array.isArray(current.value)) {
      const record = z.record(z.string(), z.unknown()).safeParse(current.value);
      const properties = record.success ? record.data.properties : undefined;
      if (
        properties !== null &&
        typeof properties === "object" &&
        !Array.isArray(properties) &&
        property in properties
      ) {
        return true;
      }
    }
    for (const value of Object.values(current.value)) {
      pending.push({ depth: current.depth + 1, value });
    }
  }
  return false;
}

function declaresToolSupport(
  model: z.infer<typeof upstreamCatalogModelSchema>,
  facts: string,
): boolean {
  return (
    schemaDeclaresProperty(model.schema?.input, "tools") ||
    facts.includes("function calling") ||
    facts.includes("tool use")
  );
}

function compatibility(model: z.infer<typeof upstreamCatalogModelSchema>, declaresTools: boolean) {
  if (model.task.trim().toLowerCase() !== "text generation") {
    return { evidence: "unsupported-task" as const, status: "incompatible" as const };
  }
  const requestFormats = model.request_formats.map((format) => format.trim().toLowerCase());
  const isOpenAI = model.model_id.startsWith("openai/");
  const isAnthropic = model.model_id.startsWith("anthropic/");
  const adapterSupportsFormat = isOpenAI
    ? requestFormats.includes("responses")
    : isAnthropic
      ? requestFormats.includes("anthropic-messages")
      : requestFormats.includes("chat-completions");
  if (!adapterSupportsFormat) {
    return { evidence: "unsupported-request-format" as const, status: "incompatible" as const };
  }
  if (declaresTools) {
    return { evidence: "declared-tool-support" as const, status: "compatible" as const };
  }
  if (isAnthropic) {
    return {
      evidence: "adapter-inferred-tool-support" as const,
      status: "compatible" as const,
    };
  }
  return { evidence: "tool-support-undeclared" as const, status: "incompatible" as const };
}

export function createCloudflareUnifiedModelCatalogItem(
  raw: unknown,
  freshness: "last-known-good" | "bundled-fallback",
): CloudflareModelBrowseItem | null {
  const model = upstreamCatalogModelSchema.safeParse(raw);
  if (!model.success || model.data.model_id.startsWith("@")) return null;
  const facts = normalizedFacts(model.data);
  const declaresTools = declaresToolSupport(model.data, facts);
  const runtime = compatibility(model.data, declaresTools);
  const capabilities = [
    ...(declaresTools ? (["function-calling"] as const) : []),
    ...(facts.includes("reasoning") ? (["reasoning"] as const) : []),
    ...(facts.includes("vision") || facts.includes("multimodal") || facts.includes("text, image")
      ? (["vision"] as const)
      : []),
    ...(model.data.zdr === true ? (["zero-data-retention"] as const) : []),
  ];
  const parsed = cloudflareModelBrowseItemSchema.safeParse({
    capabilities,
    createdAt: normalizedCreatedAt(model.data.created_at),
    description: model.data.description.replaceAll(/\s+/g, " ").trim().slice(0, 500),
    freshness,
    id: model.data.model_id,
    name: model.data.name,
    platform: "third-party",
    provider: providerFrom(model.data.model_id),
    requestFormats: model.data.request_formats,
    runtimeCompatibility: runtime.status,
    runtimeCompatibilityEvidence: runtime.evidence,
    task: model.data.task,
  });
  return parsed.success ? parsed.data : null;
}

async function latestSourceCommit(fetchImplementation: typeof fetch): Promise<string> {
  const url = new URL("/repos/cloudflare/cloudflare-docs/commits", GITHUB_API_ORIGIN);
  url.searchParams.set("path", CATALOG_SOURCE_DIRECTORY);
  url.searchParams.set("sha", "production");
  url.searchParams.set("per_page", "1");
  const raw = await boundedJson(
    await fetchImplementation(url, {
      headers: githubHeaders("application/vnd.github+json"),
      redirect: "manual",
    }),
    64 * 1024,
  );
  const commits = z.array(githubCommitSchema).min(1).max(1).parse(raw);
  const commit = commits[0];
  if (commit === undefined) throw new Error("catalog source returned no commit");
  return commit.sha;
}

async function sourceFiles(fetchImplementation: typeof fetch, commit: string) {
  const url = new URL(
    `/repos/cloudflare/cloudflare-docs/contents/${CATALOG_SOURCE_DIRECTORY}`,
    GITHUB_API_ORIGIN,
  );
  url.searchParams.set("ref", commit);
  const raw = await boundedJson(
    await fetchImplementation(url, {
      headers: githubHeaders("application/vnd.github+json"),
      redirect: "manual",
    }),
    MAXIMUM_CATALOG_BYTES,
  );
  const files = z.array(githubContentSchema).min(1).max(MAXIMUM_MODEL_BROWSE_SCAN_ITEMS).parse(raw);
  if (files.reduce((total, file) => total + file.size, 0) > MAXIMUM_SOURCE_TOTAL_BYTES) {
    throw new Error("catalog source files exceeded their total bound");
  }
  return files.toSorted((left, right) => left.name.localeCompare(right.name));
}

async function fetchSourceModels(
  fetchImplementation: typeof fetch,
  commit: string,
  files: z.infer<typeof githubContentSchema>[],
): Promise<CloudflareModelBrowseItem[]> {
  const models: CloudflareModelBrowseItem[] = [];
  for (let offset = 0; offset < files.length; offset += SOURCE_FETCH_CONCURRENCY) {
    const group = files.slice(offset, offset + SOURCE_FETCH_CONCURRENCY);
    const responses = await Promise.all(
      group.map(async (file) => {
        const url = new URL(
          `/cloudflare/cloudflare-docs/${commit}/${CATALOG_SOURCE_DIRECTORY}/${file.name}`,
          GITHUB_RAW_ORIGIN,
        );
        return boundedJson(
          await fetchImplementation(url, {
            headers: githubHeaders("application/json"),
            redirect: "manual",
          }),
          file.size + 1024,
        );
      }),
    );
    for (const response of responses) {
      const model = createCloudflareUnifiedModelCatalogItem(response, "last-known-good");
      if (model === null) throw new Error("catalog source contained an invalid model");
      if (model.runtimeCompatibility === "compatible") models.push(model);
    }
  }
  const unique = new Map(models.map((model) => [model.id, model]));
  if (unique.size !== models.length) throw new Error("catalog source contained duplicate models");
  return [...unique.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

async function storedCatalog(
  database: D1Database,
): Promise<CloudflareUnifiedModelCatalogSnapshot | null> {
  try {
    const raw = await database
      .prepare(
        'SELECT "catalog", "source_commit" FROM "cloudflare_model_catalog_cache" WHERE "id" = ?',
      )
      .bind(CATALOG_CACHE_KEY)
      .first();
    const row = storedCatalogRowSchema.safeParse(raw);
    if (!row.success) return null;
    const snapshot = catalogSnapshotSchema.safeParse(JSON.parse(row.data.catalog) as unknown);
    return snapshot.success && snapshot.data.sourceCommit === row.data.source_commit
      ? snapshot.data
      : null;
  } catch {
    return null;
  }
}

export async function readCloudflareUnifiedModelCatalog(
  database: D1Database,
): Promise<CloudflareUnifiedModelCatalogSnapshot> {
  const fallback = catalogSnapshotSchema.parse(bundledCloudflareUnifiedModelCatalog);
  const stored = await storedCatalog(database);
  if (stored === null) return fallback;
  return Date.parse(stored.refreshedAt) >= Date.parse(fallback.refreshedAt) ? stored : fallback;
}

export async function refreshCloudflareUnifiedModelCatalog(
  database: D1Database,
  fetchImplementation: typeof fetch = fetch,
): Promise<CloudflareUnifiedModelCatalogRefreshResult> {
  const sourceCommit = await latestSourceCommit(fetchImplementation);
  const current = await storedCatalog(database);
  if (current?.sourceCommit === sourceCommit) {
    return { modelCount: current.models.length, sourceCommit, status: "unchanged" };
  }
  const models = await fetchSourceModels(
    fetchImplementation,
    sourceCommit,
    await sourceFiles(fetchImplementation, sourceCommit),
  );
  const snapshot = catalogSnapshotSchema.parse({
    models,
    refreshedAt: new Date().toISOString(),
    sourceCommit,
    sourceUrl: CATALOG_SOURCE_URL,
    status: "last-known-good",
  });
  const serialized = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAXIMUM_CATALOG_BYTES) throw new Error("catalog cache exceeded its bound");
  await database
    .prepare(
      `INSERT INTO "cloudflare_model_catalog_cache"
         ("id", "source_commit", "refreshed_at", "model_count", "catalog", "catalog_bytes")
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT("id") DO UPDATE SET
         "source_commit" = excluded."source_commit",
         "refreshed_at" = excluded."refreshed_at",
         "model_count" = excluded."model_count",
         "catalog" = excluded."catalog",
         "catalog_bytes" = excluded."catalog_bytes"`,
    )
    .bind(
      CATALOG_CACHE_KEY,
      snapshot.sourceCommit,
      Date.parse(snapshot.refreshedAt),
      snapshot.models.length,
      serialized,
      bytes,
    )
    .run();
  return { modelCount: snapshot.models.length, sourceCommit, status: "refreshed" };
}
