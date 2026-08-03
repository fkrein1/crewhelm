import type {
  RecipePackage,
  RecipeRegistryProjection,
  RegistrySkillPackage,
  RegistrySkillProjection,
} from "./recipes.js";

const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=/]\s*["']?[A-Za-z0-9_./+=-]{12,}/iu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/u,
] as const;
const privateIdentifierPatterns = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
] as const;
const activeHtmlPattern = /<(?:iframe|img|script|style|svg)\b/iu;
const hiddenCharacterPattern = /[\u200B-\u200F\u2060\uFEFF]/u;

function hasRemoteMarkdownImage(value: string): boolean {
  let cursor = 0;
  for (;;) {
    const imageStart = value.indexOf("![", cursor);
    if (imageStart === -1) return false;
    const targetStart = value.indexOf("](", imageStart + 2);
    if (targetStart === -1) return false;
    const urlStart = targetStart + 2;
    if (value.startsWith("http://", urlStart) || value.startsWith("https://", urlStart)) {
      return true;
    }
    cursor = urlStart;
  }
}

export function inspectPublicText(value: unknown): {
  suspectedPrivateIdentifiers: boolean;
  suspectedSecrets: boolean;
} {
  const texts: string[] = [];
  const collectText = (text: string): void => {
    texts.push(text);
    try {
      let normalized = new URL(text).href;
      for (let index = 0; index < 3; index += 1) {
        const decoded = decodeURIComponent(normalized);
        if (decoded === normalized) break;
        texts.push(decoded);
        normalized = decoded;
      }
    } catch {
      // Non-URL text is scanned in its exact public form.
    }
  };
  const collect = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      collectText(candidate);
    } else if (Array.isArray(candidate)) {
      for (const item of candidate) collect(item);
    } else if (candidate !== null && typeof candidate === "object") {
      for (const [key, item] of Object.entries(candidate)) {
        collectText(key);
        collect(item);
      }
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

export function inspectPublicSkill(
  skillPackage: RegistrySkillPackage,
): RegistrySkillProjection["warnings"] {
  let provenanceSource: string | undefined;
  let invalidProvenanceSource = false;
  if (skillPackage.provenance.kind !== "authored") {
    try {
      provenanceSource = decodeURIComponent(new URL(skillPackage.provenance.source).href);
    } catch {
      invalidProvenanceSource = true;
    }
  }
  const warnings: RegistrySkillProjection["warnings"] = {
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
    if (activeHtmlPattern.test(text) || hasRemoteMarkdownImage(text)) {
      warnings.activeMarkdown += 1;
    }
    if (text.includes("<!--") || hiddenCharacterPattern.test(text)) warnings.hiddenText += 1;
    if (/\b[A-Za-z0-9+/]{160,}={0,2}\b/u.test(text)) warnings.obfuscatedContent += 1;
    if (privateIdentifierPatterns.some((pattern) => pattern.test(text))) {
      warnings.suspectedPrivateIdentifiers += 1;
    }
    if (secretPatterns.some((pattern) => pattern.test(text))) warnings.suspectedSecrets += 1;
  }
  return warnings;
}

function requestedAuthority(recipe: RecipePackage): RecipeRegistryProjection["requestedAuthority"] {
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

export function deriveRecipeProjectionFields(
  recipe: RecipePackage,
): Pick<
  RecipeRegistryProjection,
  | "deliverables"
  | "description"
  | "limits"
  | "operations"
  | "outcome"
  | "requestedAuthority"
  | "requirements"
  | "summary"
  | "tags"
  | "title"
> {
  const deliverables = new Set([
    recipe.operations.primary.outputContract.kind,
    ...recipe.operations.eventTriggers.map(({ outputContract }) => outputContract.kind),
    ...recipe.operations.schedules.map(({ outputContract }) => outputContract.kind),
  ]);
  return {
    deliverables: [...deliverables].toSorted(),
    description: recipe.discovery.description,
    limits: recipe.agent.executionLimits,
    operations: {
      eventTriggers: recipe.operations.eventTriggers.length,
      primary: recipe.operations.primary.kind,
      schedules: recipe.operations.schedules.length,
    },
    outcome: recipe.responsibility.outcome,
    requestedAuthority: requestedAuthority(recipe),
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
    summary: recipe.responsibility.summary,
    tags: recipe.discovery.tags,
    title: recipe.responsibility.title,
  };
}

export function deriveSkillProjectionFields(
  skillPackage: RegistrySkillPackage,
): Pick<RegistrySkillProjection, "description" | "fileCount" | "license" | "warnings"> {
  return {
    description: skillPackage.description,
    fileCount: skillPackage.files.length,
    license: skillPackage.license,
    warnings: inspectPublicSkill(skillPackage),
  };
}
