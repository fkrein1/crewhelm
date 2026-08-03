import {
  deriveRecipeProjectionFields,
  deriveSkillProjectionFields,
  MAXIMUM_RECIPE_BYTES,
  MAXIMUM_SKILL_PACKAGE_BYTES,
  recipePackageSchema,
  recipeRegistryOriginSchema,
  recipeRegistryProjectionSchema,
  registryArtifactVersionEnvelopeSchema,
  registryRecipeSearchResponseSchema,
  registrySkillPackageSchema,
  registrySkillProjectionSchema,
  type RecipePackage,
  type RecipeRegistryProjection,
  type RegistryArtifactCoordinate,
  type RegistryRecipeSearchResponse,
  type RegistrySkillPackage,
  type RegistrySkillProjection,
} from "@crewhelm/contracts";
import * as z from "zod";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_SEARCH_RESPONSE_BYTES = 512 * 1_024;
const TESTING_REGISTRY_ORIGIN = "https://crewhelm-registry-dev.fkrein.workers.dev/";

const recipeArtifactResponseSchema = z.strictObject({
  envelope: registryArtifactVersionEnvelopeSchema,
  projection: z.union([recipeRegistryProjectionSchema, registrySkillProjectionSchema]),
});

export class RecipeRegistryClientError extends Error {
  constructor(
    readonly code: "artifact_not_found" | "artifact_restricted" | "registry_unavailable",
  ) {
    super("Recipe Registry request failed.");
    this.name = "RecipeRegistryClientError";
  }
}

export function configuredRecipeRegistryOrigin(environment: {
  RECIPE_REGISTRY_ORIGIN?: string;
  CREWHELM_TESTING_INSTALLATION?: string;
}): string {
  const origin = environment.RECIPE_REGISTRY_ORIGIN ?? "https://crewhelm.app/";
  if (environment.CREWHELM_TESTING_INSTALLATION === "true" && origin !== TESTING_REGISTRY_ORIGIN) {
    throw new Error("Testing installation Recipe Registry is not configured safely.");
  }
  return origin;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function projectedRecipeFields(projection: RecipeRegistryProjection) {
  const {
    deliverables,
    description,
    limits,
    operations,
    outcome,
    requestedAuthority,
    requirements,
    summary,
    tags,
    title,
  } = projection;
  return {
    deliverables,
    description,
    limits,
    operations,
    outcome,
    requestedAuthority,
    requirements,
    summary,
    tags,
    title,
  };
}

function projectedSkillFields(projection: RegistrySkillProjection) {
  const { description, fileCount, license, warnings } = projection;
  return { description, fileCount, license, warnings };
}

async function boundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const contentLength = response.headers.get("content-length");
  if (
    contentType !== "application/json" ||
    (contentLength !== null && Number(contentLength) > maximumBytes)
  ) {
    throw new RecipeRegistryClientError("registry_unavailable");
  }

  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined) {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new RecipeRegistryClientError("registry_unavailable");
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RecipeRegistryClientError("registry_unavailable");
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new RecipeRegistryClientError("registry_unavailable");
  }
}

export class RecipeRegistryClient {
  readonly #fetch: Fetcher;
  readonly #origin: string;

  constructor(origin: string, fetcher?: Fetcher) {
    this.#origin = recipeRegistryOriginSchema.parse(origin);
    this.#fetch = fetcher ?? ((input, init) => fetch(input, init));
  }

  get origin(): string {
    return this.#origin;
  }

  async search(query: string, limit: number): Promise<RegistryRecipeSearchResponse> {
    const url = this.#url("recipes/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    return registryRecipeSearchResponseSchema.parse(
      parseJson(await this.#request(url, MAXIMUM_SEARCH_RESPONSE_BYTES)),
    );
  }

  async recipe(target: RegistryArtifactCoordinate & { digest: string }): Promise<{
    package: RecipePackage;
    projection: RecipeRegistryProjection;
  }> {
    const artifact = await this.#artifact(target);
    if (artifact.envelope.kind !== "recipe" || artifact.projection.artifact.kind !== "recipe") {
      throw new RecipeRegistryClientError("artifact_not_found");
    }
    const packageBytes = await this.#packageBytes(target, MAXIMUM_RECIPE_BYTES);
    if ((await sha256(packageBytes)) !== target.digest) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    const packageValue = recipePackageSchema.parse(parseJson(packageBytes));
    if (packageValue.name !== target.name) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    const projection = recipeRegistryProjectionSchema.parse(artifact.projection);
    if (
      !sameCanonical(deriveRecipeProjectionFields(packageValue), projectedRecipeFields(projection))
    ) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    return {
      package: packageValue,
      projection,
    };
  }

  async skill(target: RegistryArtifactCoordinate & { digest: string }): Promise<{
    package: RegistrySkillPackage;
    projection: RegistrySkillProjection;
  }> {
    const artifact = await this.#artifact(target);
    if (artifact.envelope.kind !== "skill" || artifact.projection.artifact.kind !== "skill") {
      throw new RecipeRegistryClientError("artifact_not_found");
    }
    const packageBytes = await this.#packageBytes(target, MAXIMUM_SKILL_PACKAGE_BYTES);
    if ((await sha256(packageBytes)) !== target.digest) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    const packageValue = registrySkillPackageSchema.parse(parseJson(packageBytes));
    if (packageValue.name !== target.name) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    const projection = registrySkillProjectionSchema.parse(artifact.projection);
    if (
      !sameCanonical(deriveSkillProjectionFields(packageValue), projectedSkillFields(projection))
    ) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    return {
      package: packageValue,
      projection,
    };
  }

  async #artifact(target: RegistryArtifactCoordinate & { digest: string }) {
    const value = recipeArtifactResponseSchema.parse(
      parseJson(await this.#request(this.#artifactUrl(target), MAXIMUM_RECIPE_BYTES)),
    );
    if (
      value.envelope.coordinate.kind !== target.kind ||
      value.envelope.coordinate.namespace !== target.namespace ||
      value.envelope.coordinate.name !== target.name ||
      value.envelope.coordinate.version !== target.version ||
      value.envelope.package.digest !== target.digest
    ) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    if (
      value.projection.artifact.kind !== target.kind ||
      value.projection.artifact.namespace !== target.namespace ||
      value.projection.artifact.name !== target.name ||
      value.projection.artifact.version !== target.version ||
      value.projection.package.digest !== target.digest ||
      value.projection.lifecycle !== value.envelope.lifecycle ||
      value.projection.review !== value.envelope.review
    ) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    if (value.envelope.lifecycle !== "published") {
      throw new RecipeRegistryClientError("artifact_restricted");
    }
    return value;
  }

  async #packageBytes(target: RegistryArtifactCoordinate, maximumBytes: number) {
    const url = this.#artifactUrl(target);
    url.pathname += "/package";
    return this.#request(url, maximumBytes);
  }

  #artifactUrl(target: RegistryArtifactCoordinate): URL {
    return this.#url(
      `artifacts/${target.kind}/${encodeURIComponent(target.namespace)}/${encodeURIComponent(target.name)}/${target.version}`,
    );
  }

  #url(path: string): URL {
    return new URL(`api/registry/v1/${path}`, this.#origin);
  }

  async #request(url: URL, maximumBytes: number): Promise<Uint8Array> {
    if (url.origin !== new URL(this.#origin).origin) {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { accept: "application/json" },
        method: "GET",
        redirect: "manual",
        signal,
      });
    } catch {
      throw new RecipeRegistryClientError("registry_unavailable");
    }
    if (response.status === 404) throw new RecipeRegistryClientError("artifact_not_found");
    if (!response.ok) throw new RecipeRegistryClientError("registry_unavailable");
    return boundedBytes(response, maximumBytes);
  }
}

export async function localSkillPackageDigest(value: unknown): Promise<string> {
  return sha256(encoder.encode(JSON.stringify(canonical(value))));
}
