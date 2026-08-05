import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  CREWHELM_SITE,
  absoluteSiteUrl,
  homeStructuredData,
  llmsText,
  robotsText,
  serializeJsonLd,
} from "../apps/site/src/lib/seo.js";
import { getRecipeChoiceSignals, toRecipePreview } from "../apps/site/src/lib/recipe-catalog.js";

const recipePreview = toRecipePreview({
  artifact: { kind: "recipe", name: "research-steward", namespace: "crewhelm", version: 2 },
  deliverables: ["markdown"],
  description: "Produces an evidence-backed brief.",
  inference: { fallbackModels: [], primaryModel: "@cf/moonshotai/kimi-k2.6" },
  operations: { eventTriggers: 1, primary: "workflow", schedules: 1 },
  outcome: "A decision-ready research brief.",
  publisher: { displayName: "Crewhelm", namespace: "crewhelm" },
  requestedAuthority: {
    approvalRequired: { destructive: 0, read: 0, write: 1 },
    standing: { destructive: 0, read: 1, write: 0 },
  },
  requirements: {
    capabilityIds: ["inference.workers-ai", "runtime.sandbox-code", "web.fetch", "web.search"],
    integrations: ["github", "slack", "hubspot"],
    skills: { optional: 0, required: 1 },
  },
  summary: "Researches a decision with cited evidence.",
  title: "Research Steward",
});

describe("Crewhelm site discovery foundation", () => {
  it("follows the system color scheme without a user override", async () => {
    const [layout, page, seo] = await Promise.all([
      readFile(new URL("../apps/site/src/layouts/SiteLayout.astro", import.meta.url), "utf8"),
      readFile(new URL("../apps/site/src/pages/index.astro", import.meta.url), "utf8"),
      readFile(new URL("../apps/site/src/components/Seo.astro", import.meta.url), "utf8"),
    ]);

    expect(`${layout}\n${page}`).not.toMatch(/ThemeToggle|localStorage|data-theme/);
    expect(seo).toContain(
      '<meta name="theme-color" content="#f2f0e9" media="(prefers-color-scheme: light)" />',
    );
    expect(seo).toContain(
      '<meta name="theme-color" content="#11151e" media="(prefers-color-scheme: dark)" />',
    );
  });

  it("keeps canonical URLs on the production origin", () => {
    expect(absoluteSiteUrl("/")).toBe("https://crewhelm.app/");
    expect(absoluteSiteUrl("/recipes/example")).toBe("https://crewhelm.app/recipes/example");
  });

  it("publishes a large social card from the production origin", () => {
    expect(absoluteSiteUrl(CREWHELM_SITE.socialImage.url)).toBe(
      "https://crewhelm.app/crewhelm-social-preview-v2.png",
    );
    expect(CREWHELM_SITE.socialImage).toMatchObject({
      height: 640,
      mimeType: "image/png",
      width: 1280,
    });
    expect(CREWHELM_SITE.socialImage.alt).toContain("Give Agents a mandate");
  });

  it("publishes a neutral crawler policy and generated sitemap location", () => {
    expect(robotsText()).toBe(
      "User-agent: *\nAllow: /\n\nSitemap: https://crewhelm.app/sitemap-index.xml\n",
    );
  });

  it("describes only claims supported by the product and repository", () => {
    const structuredData = homeStructuredData();
    const serialized = JSON.stringify(structuredData);

    expect(serialized).toContain('"@type":"WebSite"');
    expect(serialized).toContain('"@type":"SoftwareApplication"');
    expect(serialized).toContain(`"sameAs":"${CREWHELM_SITE.githubUrl}"`);
    expect(serialized).toContain(CREWHELM_SITE.githubUrl);
    expect(serialized).not.toContain("codeRepository");
    expect(serialized).not.toContain("operatingSystem");
  });

  it("escapes executable markup in structured data", () => {
    expect(serializeJsonLd({ value: "</script><script>alert(1)</script>" })).toBe(
      '{"value":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}',
    );
  });

  it("keeps llms.txt concise and source-linked", () => {
    const content = llmsText();

    expect(content).toContain("# Crewhelm");
    expect(content).toContain("> The open-source personal control plane");
    expect(content).toContain("[GitHub repository](https://github.com/fkrein1/crewhelm)");
    expect(content).toContain("[Recipes](https://crewhelm.app/recipes/)");
    expect(content).not.toContain("## Optional");
  });
});

describe("Crewhelm Recipe catalog", () => {
  it("builds namespaced catalog routes from Registry projections", () => {
    expect(recipePreview.route).toBe("/recipes/crewhelm/research-steward/");
    expect(recipePreview.slug).toBe("crewhelm/research-steward");
  });

  it("keeps three integrations and every signal available for width fitting", () => {
    const selection = getRecipeChoiceSignals({
      ...recipePreview,
      capabilities: ["Workers AI", "Python sandbox", "Web search", "Web fetch", "Browser"],
      integrations: [
        { label: "GitHub", slug: "github" },
        { label: "Slack", slug: "slack" },
        { label: "HubSpot", slug: "hubspot" },
      ],
    });

    expect(selection.integrations.map(({ label }) => label)).toEqual([
      "GitHub",
      "Slack",
      "HubSpot",
    ]);
    expect(selection.signals).toEqual([
      { kind: "capability", label: "Python sandbox" },
      { kind: "capability", label: "Web search" },
      { kind: "capability", label: "Web fetch" },
      { kind: "capability", label: "Browser" },
      { kind: "automation", label: "Event" },
      { kind: "automation", label: "Scheduled" },
      { kind: "workflow", label: "Workflow" },
    ]);
    expect(selection.hiddenCount).toBe(0);
    expect(selection.accessibleLabel).toContain("HubSpot");
    expect(selection.accessibleLabel).toContain("Workflow");
  });

  it("keeps the primary model outside the compressed feature ranking", () => {
    const selection = getRecipeChoiceSignals({ ...recipePreview, integrations: [] });

    expect(selection.signals).toEqual([
      { kind: "capability", label: "Sandbox" },
      { kind: "capability", label: "Fetch" },
      { kind: "capability", label: "Search" },
      { kind: "automation", label: "Event" },
      { kind: "automation", label: "Scheduled" },
      { kind: "workflow", label: "Workflow" },
    ]);
    expect(selection.accessibleLabel).not.toContain("Kimi K2.6");
  });

  it("renders integrations and the primary model in a compact metadata line", async () => {
    const source = await readFile(
      new URL("../apps/site/src/components/recipes/RecipeCatalog.astro", import.meta.url),
      "utf8",
    );

    expect(source).toContain('class="metadata-line"');
    expect(source).toContain('class="integration-block"');
    expect(source).toContain('class="metadata-separator"');
    expect(source).toContain("Primary model:");
    expect(source).not.toContain("fallbackCount");
  });

  it("keeps the production catalog complete and linked", async () => {
    const source = await readFile(
      new URL("../apps/site/src/components/recipes/RecipeCatalog.astro", import.meta.url),
      "utf8",
    );

    expect(source).toMatch(/class="[^"]*\brecipe-card\b[^"]*"/u);
    expect(source).toContain("data-recipe-open");
    expect(source).toContain("data-recipe-slug={recipe.slug}");
    expect(source).toContain("<ConnectionLogo");
    expect(source).not.toContain("data-facet");
    expect(source).not.toContain("Variation");
    expect(source).not.toContain("prototype");
  });

  it("keeps the Recipe detail header focused on the title and summary", async () => {
    const source = await readFile(
      new URL("../apps/site/src/components/recipes/RecipeDetail.astro", import.meta.url),
      "utf8",
    );

    expect(source).toContain('class="ledger-integrations"');
    expect(source).not.toContain("recipeSeedVersion");
    expect(source).not.toContain("operation-chip");
    expect(source).not.toContain("How to install");
  });

  it("uses history-backed dialogs for list navigation and full direct pages", async () => {
    const [explorer, directPage] = await Promise.all([
      readFile(
        new URL("../apps/site/src/components/recipes/RecipeExplorer.astro", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../apps/site/src/pages/recipes/[namespace]/[name].astro", import.meta.url),
        "utf8",
      ),
    ]);

    expect(explorer).toContain("<dialog");
    expect(explorer).toContain("history.pushState");
    expect(explorer).toContain('window.addEventListener("popstate"');
    expect(explorer).toContain("@starting-style");
    expect(explorer).toContain("allow-discrete");
    expect(explorer).not.toContain("startViewTransition");
    expect(directPage).toContain("<RecipeDetail {recipe} />");
    expect(directPage).not.toContain("<RecipeExplorer");
  });
});
