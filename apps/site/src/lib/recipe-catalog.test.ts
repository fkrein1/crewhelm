import { describe, expect, it } from "vitest";

import {
  RECIPE_CATALOG_CACHE_CONTROL,
  RECIPE_DETAIL_CACHE_CONTROL,
  fitRecipeMetadataItems,
  getComposioLogoUrl,
  getRecipeCardModelLabel,
  getRecipeChoiceSignals,
  getRecipePublisherLabel,
  type RecipePreview,
} from "./recipe-catalog";

const csvRecipe: RecipePreview = {
  artifact: { kind: "recipe", name: "csv-insight-analyst", namespace: "fkrein1", version: 1 },
  capabilities: ["Workers AI", "Sandbox Code"],
  deliverables: ["markdown"],
  description: "Analyze CSV data.",
  inference: { fallbackModels: ["openai/gpt-5.6-terra"], primaryModel: "@cf/openai/gpt-oss-120b" },
  integrations: [],
  operations: { eventTriggers: 0, primary: "workflow", schedules: 0 },
  outcome: "Produce a reproducible analysis.",
  publisher: { displayName: "Felipe Krein", namespace: "fkrein1" },
  requestedAuthority: {
    approvalRequired: { destructive: 0, read: 0, write: 0 },
    standing: { destructive: 0, read: 0, write: 0 },
  },
  requirements: {
    capabilityIds: ["inference.workers-ai", "runtime.sandbox-code"],
    integrations: [],
    skills: { optional: 0, required: 0 },
  },
  route: "/recipes/fkrein1/csv-insight-analyst/",
  slug: "fkrein1/csv-insight-analyst",
  summary: "Analyze CSV data.",
  title: "CSV Insight Analyst",
};

describe("Recipe catalog presentation", () => {
  it("uses every integration slug with Composio's bounded logo endpoint", () => {
    expect(getComposioLogoUrl("firecrawl")).toBe("https://logos.composio.dev/api/firecrawl");
    expect(getComposioLogoUrl("google_calendar")).toBe(
      "https://logos.composio.dev/api/google_calendar",
    );
  });

  it("identifies publishers by their stable Registry namespace", () => {
    expect(getRecipePublisherLabel({ displayName: "Felipe Krein", namespace: "fkrein1" })).toBe(
      "@fkrein1",
    );
  });

  it("keeps successful Registry pages fresh at the edge", () => {
    expect(RECIPE_CATALOG_CACHE_CONTROL).toBe(
      "public, max-age=0, s-maxage=30, stale-while-revalidate=30",
    );
    expect(RECIPE_DETAIL_CACHE_CONTROL).toBe(RECIPE_CATALOG_CACHE_CONTROL);
  });

  it("bounds card model labels to fifteen characters while preserving short labels", () => {
    expect(getRecipeCardModelLabel("GPT-OSS 120B")).toBe("GPT-OSS 120B");
    expect(getRecipeCardModelLabel("Claude Sonnet 4.5")).toBe("Claude Sonnet …");
    expect(getRecipeCardModelLabel("123456789012345")).toBe("123456789012345");
  });

  it("keeps every ranked card signal available for width-based fitting", () => {
    expect(
      getRecipeChoiceSignals({
        ...csvRecipe,
        integrations: [{ label: "Firecrawl", slug: "firecrawl" }],
        requirements: { ...csvRecipe.requirements, integrations: ["firecrawl"] },
      }),
    ).toMatchObject({
      hiddenCount: 0,
      integrations: [{ label: "Firecrawl", slug: "firecrawl" }],
      signals: [
        { kind: "capability", label: "Sandbox Code" },
        { kind: "workflow", label: "Workflow" },
      ],
    });
  });

  it("offers up to three integration logos before counting overflow", () => {
    const integrations = ["firecrawl", "slack", "github", "notion"].map((slug) => ({
      label: slug,
      slug,
    }));

    expect(
      getRecipeChoiceSignals({
        ...csvRecipe,
        integrations,
        requirements: {
          ...csvRecipe.requirements,
          integrations: integrations.map(({ slug }) => slug),
        },
      }),
    ).toMatchObject({
      hiddenCount: 1,
      integrations: integrations.slice(0, 3),
    });
  });

  it("replaces whole overflowing metadata items with their exact hidden count", () => {
    expect(
      fitRecipeMetadataItems({
        availableWidth: 230,
        baseHiddenCount: 0,
        fixedWidth: 105,
        gapWidth: 7,
        items: [
          { count: 1, width: 75 },
          { count: 1, width: 70 },
        ],
        overflowWidth: 25,
      }),
    ).toEqual({ hiddenCount: 1, visibleItems: 1 });

    expect(
      fitRecipeMetadataItems({
        availableWidth: 165,
        baseHiddenCount: 0,
        fixedWidth: 105,
        gapWidth: 7,
        items: [
          { count: 1, width: 75 },
          { count: 1, width: 70 },
        ],
        overflowWidth: 25,
      }),
    ).toEqual({ hiddenCount: 2, visibleItems: 0 });
  });
});
