import {
  deriveRecipeProjectionFields,
  deriveSkillProjectionFields,
  recipeRegistryProjectionSchema,
  registrySkillProjectionSchema,
  type RecipePackage,
  type RecipeRegistryProjection,
  type RegistryArtifactVersionEnvelope,
  type RegistrySkillPackage,
  type RegistrySkillProjection,
} from "@crewhelm/contracts";

export { inspectPublicSkill, inspectPublicText } from "@crewhelm/contracts";

const encoder = new TextEncoder();

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

export function canonicalPackage(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonicalValue(value)));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function packageObjectKey(envelope: RegistryArtifactVersionEnvelope): string {
  const { kind, namespace, name, version } = envelope.coordinate;
  return `v1/${kind}/${namespace}/${name}/${version}/${envelope.package.digest}.json`;
}

export function projectRecipe(input: {
  descriptor: { digest: string; sizeBytes: number };
  lifecycle?: "published" | "restricted" | "retired";
  namespace: string;
  package: RecipePackage;
  publishedAt: string;
  publisher: RecipeRegistryProjection["publisher"];
  review?: "featured" | "reviewed" | "unreviewed";
  version: number;
}): RecipeRegistryProjection {
  const recipe = input.package;
  const projection: RecipeRegistryProjection = {
    artifact: {
      kind: "recipe",
      name: recipe.name,
      namespace: input.namespace,
      version: input.version,
    },
    contentTrust: "untrusted",
    ...deriveRecipeProjectionFields(recipe),
    lifecycle: input.lifecycle ?? "published",
    package: input.descriptor,
    publishedAt: input.publishedAt,
    publisher: input.publisher,
    review: input.review ?? "unreviewed",
    updatedAt: input.publishedAt,
  };
  return recipeRegistryProjectionSchema.parse(projection);
}

export function projectSkill(input: {
  descriptor: { digest: string; sizeBytes: number };
  namespace: string;
  package: RegistrySkillPackage;
  publishedAt: string;
  publisher: RegistrySkillProjection["publisher"];
  version: number;
}): RegistrySkillProjection {
  return registrySkillProjectionSchema.parse({
    artifact: {
      kind: "skill",
      name: input.package.name,
      namespace: input.namespace,
      version: input.version,
    },
    contentTrust: "untrusted",
    ...deriveSkillProjectionFields(input.package),
    lifecycle: "published",
    package: input.descriptor,
    publishedAt: input.publishedAt,
    publisher: input.publisher,
    review: "unreviewed",
    updatedAt: input.publishedAt,
  });
}

export function recipeSearchDocument(recipe: RecipePackage): string {
  const requirements = [
    ...recipe.agent.capabilities.map(({ id }) => id),
    ...recipe.connections.map((connection) =>
      connection.kind === "composio"
        ? connection.integration
        : new URL(connection.endpoint).hostname,
    ),
    ...recipe.skills.map(({ name }) => name),
  ];
  return [
    recipe.responsibility.title,
    recipe.responsibility.summary,
    recipe.responsibility.outcome,
    recipe.discovery.description,
    recipe.responsibility.boundaries.join(" "),
    recipe.discovery.tags.join(" "),
    recipe.inputs.map(({ description }) => description).join(" "),
    recipe.sampleDeliverable.kind,
    requirements.join(" "),
  ].join("\n");
}
