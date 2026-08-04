export interface SiteRecipeProjection {
  artifact: { kind: "recipe"; name: string; namespace: string; version: number };
  deliverables: Array<"json" | "markdown">;
  description: string;
  inference: { fallbackModels: string[]; primaryModel: string };
  operations: { eventTriggers: number; primary: "run" | "workflow"; schedules: number };
  outcome: string;
  publisher: { displayName: string; namespace: string };
  requestedAuthority: {
    approvalRequired: { destructive: number; read: number; write: number };
    standing: { destructive: number; read: number; write: number };
  };
  requirements: {
    capabilityIds: string[];
    integrations: string[];
    skills: { optional: number; required: number };
  };
  summary: string;
  title: string;
}

export interface RecipeIntegration {
  label: string;
  slug: string;
}

export interface RecipePreview extends SiteRecipeProjection {
  capabilities: readonly string[];
  integrations: readonly RecipeIntegration[];
  route: string;
  slug: string;
}

export interface RecipeChoiceSignals {
  accessibleLabel: string;
  hiddenCount: number;
  integrations: readonly RecipeIntegration[];
  signals: readonly RecipeChoiceSignal[];
}

export interface RecipeChoiceSignal {
  kind: "automation" | "capability" | "workflow";
  label: string;
}

const maximumCardSignals = 2;
const maximumVisibleIntegrations = 2;
const modelLabels: Readonly<Record<string, string>> = {
  "@cf/ibm-granite/granite-4.0-h-micro": "Granite 4 Micro",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout",
  "@cf/moonshotai/kimi-k2.6": "Kimi K2.6",
  "@cf/moonshotai/kimi-k2.7-code": "Kimi K2.7 Code",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B",
  "@cf/zai-org/glm-4.7-flash": "GLM 4.7 Flash",
};

const capabilityLabels: Readonly<Record<string, string>> = {
  "inference.workers-ai": "Workers AI",
  "runtime.sandbox-code": "Sandbox",
  "web.fetch": "Fetch",
  "web.search": "Search",
};

function titleCase(value: string): string {
  return value
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function toRecipePreview(recipe: SiteRecipeProjection): RecipePreview {
  const namespace = recipe.artifact.namespace;
  const name = recipe.artifact.name;
  return {
    ...recipe,
    capabilities: recipe.requirements.capabilityIds.map(
      (capability) =>
        capabilityLabels[capability] ?? titleCase(capability.split(".").at(-1) ?? capability),
    ),
    integrations: recipe.requirements.integrations.map((integration) => ({
      label: titleCase(integration),
      slug: integration,
    })),
    route: `/recipes/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/`,
    slug: `${namespace}/${name}`,
  };
}

export function getRecipeModelLabel(model: string): string {
  return modelLabels[model] ?? model.split("/").at(-1) ?? model;
}

export function getRecipeChoiceSignals(recipe: RecipePreview): RecipeChoiceSignals {
  const capabilities = recipe.capabilities
    .filter((capability) => capability !== "Workers AI")
    .map((label) => ({ kind: "capability" as const, label }));
  const rankedSignals = [
    ...capabilities,
    recipe.operations.eventTriggers > 0
      ? { kind: "automation" as const, label: "Event" }
      : undefined,
    recipe.operations.schedules > 0
      ? { kind: "automation" as const, label: "Scheduled" }
      : undefined,
    recipe.operations.primary === "workflow"
      ? { kind: "workflow" as const, label: "Workflow" }
      : undefined,
  ].filter((signal): signal is RecipeChoiceSignal => signal !== undefined);
  const integrations = recipe.integrations.slice(0, maximumVisibleIntegrations);
  const signalBudget = maximumCardSignals - (integrations.length > 0 ? 1 : 0);
  const signals = rankedSignals.slice(0, signalBudget);

  return {
    accessibleLabel: [
      ...recipe.integrations.map((integration) => integration.label),
      ...rankedSignals.map(({ label }) => label),
    ].join(", "),
    hiddenCount:
      recipe.integrations.length - integrations.length + rankedSignals.length - signals.length,
    integrations,
    signals,
  };
}
