import {
  recipeRegistryProjectionSchema,
  registrySkillProjectionSchema,
  type RecipePackage,
  type RecipeRegistryProjection,
  type RegistryArtifactVersionEnvelope,
  type RegistrySkillPackage,
  type RegistrySkillProjection,
} from "@crewhelm/contracts";

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

type WarningCounts = RegistrySkillProjection["warnings"];

const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=/]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
] as const;
const privateIdentifierPatterns = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
] as const;

export function inspectPublicText(value: unknown): {
  suspectedPrivateIdentifiers: boolean;
  suspectedSecrets: boolean;
} {
  const texts: string[] = [];
  const collect = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      texts.push(candidate);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) collect(item);
    } else if (candidate !== null && typeof candidate === "object") {
      for (const item of Object.values(candidate)) collect(item);
    }
  };
  collect(value);
  return {
    suspectedPrivateIdentifiers: texts.some((text) =>
      privateIdentifierPatterns.some((pattern) => pattern.test(text)),
    ),
    suspectedSecrets: texts.some((text) => secretPatterns.some((pattern) => pattern.test(text))),
  };
}

export function inspectPublicSkill(skillPackage: RegistrySkillPackage): WarningCounts {
  let provenanceSource: string | undefined;
  let invalidProvenanceSource = false;
  if (skillPackage.provenance.kind !== "authored") {
    try {
      provenanceSource = decodeURIComponent(new URL(skillPackage.provenance.source).href);
    } catch {
      invalidProvenanceSource = true;
    }
  }
  const warnings: WarningCounts = {
    activeMarkdown: 0,
    executableContent: 0,
    hiddenText: 0,
    obfuscatedContent: 0,
    suspectedPrivateIdentifiers: 0,
    suspectedSecrets: invalidProvenanceSource ? 1 : 0,
  };
  const texts = [
    skillPackage.description,
    ...(provenanceSource === undefined ? [] : [provenanceSource]),
    ...skillPackage.files.map(({ content }) => content),
  ];

  for (const text of texts) {
    if (/<(?:iframe|img|script|style|svg)\b|!\[[^\]]*\]\(https?:\/\//iu.test(text)) {
      warnings.activeMarkdown += 1;
    }
    if (/<!--[\s\S]*?-->|[\u200B-\u200F\u2060\uFEFF]/u.test(text)) warnings.hiddenText += 1;
    if (/\b[A-Za-z0-9+/]{160,}={0,2}\b/u.test(text)) warnings.obfuscatedContent += 1;
    if (privateIdentifierPatterns.some((pattern) => pattern.test(text))) {
      warnings.suspectedPrivateIdentifiers += 1;
    }
    if (secretPatterns.some((pattern) => pattern.test(text))) warnings.suspectedSecrets += 1;
  }
  return warnings;
}

function countRequestedAuthority(
  recipe: RecipePackage,
): RecipeRegistryProjection["requestedAuthority"] {
  const result: RecipeRegistryProjection["requestedAuthority"] = {
    approvalRequired: { destructive: 0, read: 0, write: 0 },
    standing: { destructive: 0, read: 0, write: 0 },
  };

  for (const connection of recipe.connections) {
    if (connection.kind === "composio") {
      for (const tool of connection.tools) {
        const bucket =
          tool.authorization === "approval_required" || tool.effect === "destructive"
            ? "approvalRequired"
            : "standing";
        result[bucket][tool.effect] += 1;
      }
    } else {
      for (const tool of connection.requiredTools) {
        const bucket =
          connection.authorization === "approval_required" || tool.effect === "destructive"
            ? "approvalRequired"
            : "standing";
        result[bucket][tool.effect] += 1;
      }
    }
  }
  return result;
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
  const deliverables = new Set([
    recipe.operations.primary.outputContract.kind,
    ...recipe.operations.eventTriggers.map(({ outputContract }) => outputContract.kind),
    ...recipe.operations.schedules.map(({ outputContract }) => outputContract.kind),
  ]);
  const projection: RecipeRegistryProjection = {
    artifact: {
      kind: "recipe",
      name: recipe.name,
      namespace: input.namespace,
      version: input.version,
    },
    contentTrust: "untrusted",
    description: recipe.discovery.description,
    deliverables: [...deliverables].toSorted(),
    requestedAuthority: countRequestedAuthority(recipe),
    lifecycle: input.lifecycle ?? "published",
    limits: recipe.agent.executionLimits,
    operations: {
      eventTriggers: recipe.operations.eventTriggers.length,
      primary: recipe.operations.primary.kind,
      schedules: recipe.operations.schedules.length,
    },
    outcome: recipe.responsibility.outcome,
    package: input.descriptor,
    publishedAt: input.publishedAt,
    publisher: input.publisher,
    requirements: {
      capabilityIds: recipe.agent.capabilities.map(({ id }) => id).toSorted(),
      integrations: [
        ...new Set(
          recipe.connections
            .filter((connection) => connection.kind === "composio")
            .map(({ integration }) => integration),
        ),
      ].toSorted(),
      remoteMcpServers: [
        ...new Set(
          recipe.connections
            .filter((connection) => connection.kind === "remote_mcp")
            .map(({ endpoint }) => endpoint),
        ),
      ].toSorted(),
      skills: {
        optional: recipe.skills.filter(({ requirement }) => requirement === "optional").length,
        required: recipe.skills.filter(({ requirement }) => requirement === "required").length,
      },
    },
    review: input.review ?? "unreviewed",
    summary: recipe.responsibility.summary,
    tags: recipe.discovery.tags,
    title: recipe.responsibility.title,
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
    description: input.package.description,
    fileCount: input.package.files.length,
    license: input.package.license,
    lifecycle: "published",
    package: input.descriptor,
    publishedAt: input.publishedAt,
    publisher: input.publisher,
    review: "unreviewed",
    updatedAt: input.publishedAt,
    warnings: inspectPublicSkill(input.package),
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
