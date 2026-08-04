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
import {
  getRecipeChoiceSignals,
  recipePreviews,
  recipeSeedVersion,
} from "../apps/site/src/lib/recipe-catalog.js";

const seededRecipeSlugs = [
  "research-brief-steward",
  "meeting-follow-up-editor",
  "decision-memo-advisor",
  "csv-insight-analyst",
  "content-calendar-planner",
  "github-issue-triage",
  "customer-feedback-synthesizer",
  "sales-account-brief",
  "incident-brief-coordinator",
  "daily-meeting-prep",
] as const;

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
  it("mirrors the ten local Registry seed identities", () => {
    expect(recipePreviews.map(({ slug }) => slug)).toEqual(seededRecipeSlugs);
    expect(new Set(recipePreviews.map(({ slug }) => slug)).size).toBe(10);
    expect(recipeSeedVersion).toBe(2);
    expect(
      recipePreviews.every(({ boundaries, outcome }) => boundaries.length > 0 && outcome),
    ).toBe(true);
  });

  it("shows every connection in the seed and keeps writes approval-bound", () => {
    expect([
      ...new Set(
        recipePreviews.flatMap(({ integrations }) => integrations.map(({ slug }) => slug)),
      ),
    ]).toEqual(["github", "slack", "hubspot", "googlecalendar"]);
    expect(
      recipePreviews.filter(({ authority }) => authority.approvalWrite > 0).map(({ slug }) => slug),
    ).toEqual(["github-issue-triage", "incident-brief-coordinator"]);
  });

  it("ranks and caps Recipe choice signals before showing a remainder", () => {
    const selection = getRecipeChoiceSignals({
      ...recipePreviews[0],
      automations: { eventTriggers: 1, schedules: 1 },
      capabilities: ["Workers AI", "Python sandbox", "Web search", "Web fetch", "Browser"],
      integrations: [
        { label: "GitHub", slug: "github" },
        { label: "Slack", slug: "slack" },
        { label: "HubSpot", slug: "hubspot" },
      ],
      operation: "Workflow",
    });

    expect(selection.integrations.map(({ label }) => label)).toEqual(["GitHub", "Slack"]);
    expect(selection.signals).toEqual([{ kind: "capability", label: "Sandbox" }]);
    expect(selection.hiddenCount).toBe(7);
    expect(selection.accessibleLabel).toContain("HubSpot");
    expect(selection.accessibleLabel).toContain("Workflow");
  });

  it("keeps the primary model outside the compressed feature ranking", () => {
    const selection = getRecipeChoiceSignals(recipePreviews[0]);

    expect(selection.signals).toEqual([
      { kind: "capability", label: "Fetch" },
      { kind: "capability", label: "Search" },
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
      readFile(new URL("../apps/site/src/pages/recipes/[slug].astro", import.meta.url), "utf8"),
    ]);

    expect(explorer).toContain("<dialog");
    expect(explorer).toContain("history.pushState");
    expect(explorer).toContain('window.addEventListener("popstate"');
    expect(explorer).toContain("startViewTransition");
    expect(directPage).toContain("<RecipeDetail {recipe} />");
    expect(directPage).not.toContain("<RecipeExplorer");
  });
});
