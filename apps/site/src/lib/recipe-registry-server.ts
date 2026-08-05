import { env as cloudflareEnv } from "cloudflare:workers";

import type { SiteRecipeProjection } from "./recipe-catalog.js";
import { registryReadHeaders } from "../site-registry-gateway.js";

interface AuthorityCounts {
  destructive: number;
  read: number;
  write: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Invalid Registry response");
  }
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid Registry response");
  return value;
}

function count(value: unknown, positive = false): number {
  if (!Number.isInteger(value) || typeof value !== "number" || value < (positive ? 1 : 0)) {
    throw new Error("Invalid Registry response");
  }
  return value;
}

function texts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Invalid Registry response");
  return value.map(text);
}

function authority(value: unknown): AuthorityCounts {
  const input = record(value);
  return {
    destructive: count(input.destructive),
    read: count(input.read),
    write: count(input.write),
  };
}

function parseRecipe(value: unknown): SiteRecipeProjection {
  const input = record(value);
  const artifact = record(input.artifact);
  const inference = record(input.inference);
  const operations = record(input.operations);
  const publisher = record(input.publisher);
  const requestedAuthority = record(input.requestedAuthority);
  const requirements = record(input.requirements);
  const skills = record(requirements.skills);
  const deliverables = texts(input.deliverables);
  if (
    artifact.kind !== "recipe" ||
    !deliverables.every((item) => item === "json" || item === "markdown")
  ) {
    throw new Error("Invalid Registry response");
  }
  if (operations.primary !== "run" && operations.primary !== "workflow") {
    throw new Error("Invalid Registry response");
  }
  const standingAuthority = authority(requestedAuthority.standing);
  if (standingAuthority.destructive !== 0) throw new Error("Invalid Registry response");
  return {
    artifact: {
      kind: "recipe",
      name: text(artifact.name),
      namespace: text(artifact.namespace),
      version: count(artifact.version, true),
    },
    deliverables: deliverables.map((item) => (item === "json" ? "json" : "markdown")),
    description: text(input.description),
    inference: {
      fallbackModels: texts(inference.fallbackModels),
      primaryModel: text(inference.primaryModel),
    },
    operations: {
      eventTriggers: count(operations.eventTriggers),
      primary: operations.primary,
      schedules: count(operations.schedules),
    },
    outcome: text(input.outcome),
    publisher: { displayName: text(publisher.displayName), namespace: text(publisher.namespace) },
    requestedAuthority: {
      approvalRequired: authority(requestedAuthority.approvalRequired),
      standing: standingAuthority,
    },
    requirements: {
      capabilityIds: texts(requirements.capabilityIds),
      integrations: texts(requirements.integrations),
      skills: { optional: count(skills.optional), required: count(skills.required) },
    },
    summary: text(input.summary),
    title: text(input.title),
  };
}

interface RegistryService {
  fetch(request: Request): Promise<Response>;
}

interface RecipeSiteEnv {
  REGISTRY: RegistryService;
  REGISTRY_ORIGIN?: string;
}

function registryOrigin(requestUrl: URL, configuredOrigin: string | undefined): string {
  if (configuredOrigin === undefined) return requestUrl.origin;
  const origin = new URL(configuredOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== configuredOrigin
  ) {
    throw new Error("Invalid Registry origin configuration");
  }
  return origin.origin;
}

async function registryJson(path: string, request: Request): Promise<unknown> {
  const runtime: RecipeSiteEnv = cloudflareEnv;
  const url = new URL(path, registryOrigin(new URL(request.url), runtime.REGISTRY_ORIGIN));
  const response = await runtime.REGISTRY.fetch(
    new Request(url, { headers: registryReadHeaders(request) }),
  );
  if (!response.ok) throw new Error(`Registry read failed with ${response.status}`);
  return response.json();
}

export async function listRegistryRecipes(request: Request): Promise<SiteRecipeProjection[]> {
  const body = record(await registryJson("/v1/recipes?limit=30", request));
  if (body.listVersion !== 1 || !Array.isArray(body.recipes) || body.recipes.length > 30) {
    throw new Error("Invalid Registry response");
  }
  return body.recipes.map(parseRecipe);
}

export async function getRegistryRecipe(
  request: Request,
  namespace: string,
  name: string,
): Promise<SiteRecipeProjection | null> {
  const runtime: RecipeSiteEnv = cloudflareEnv;
  const url = new URL(
    `/v1/recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
    registryOrigin(new URL(request.url), runtime.REGISTRY_ORIGIN),
  );
  const response = await runtime.REGISTRY.fetch(
    new Request(url, { headers: registryReadHeaders(request) }),
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Registry read failed with ${response.status}`);
  return parseRecipe(await response.json());
}
