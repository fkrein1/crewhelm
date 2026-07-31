import { CREWHELM_BRAND_NAME, CREWHELM_BRAND_POSITIONING } from "@crewhelm/design";

export const CREWHELM_SITE = {
  description: CREWHELM_BRAND_POSITIONING,
  githubUrl: "https://github.com/fkrein1/crewhelm",
  language: "en",
  locale: "en_US",
  name: CREWHELM_BRAND_NAME,
  title: "Crewhelm — Open-source control plane for AI Agents",
  url: "https://crewhelm.app",
} as const;

export type JsonLd = Record<string, unknown>;

export function absoluteSiteUrl(pathname: string): string {
  return new URL(pathname, `${CREWHELM_SITE.url}/`).toString();
}

export function serializeJsonLd(value: JsonLd | JsonLd[]): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function homeStructuredData(description = CREWHELM_SITE.description): JsonLd {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@id": `${CREWHELM_SITE.url}/#website`,
        "@type": "WebSite",
        description,
        inLanguage: CREWHELM_SITE.language,
        name: CREWHELM_SITE.name,
        url: `${CREWHELM_SITE.url}/`,
      },
      {
        "@id": `${CREWHELM_SITE.url}/#software`,
        "@type": "SoftwareApplication",
        applicationCategory: "DeveloperApplication",
        codeRepository: CREWHELM_SITE.githubUrl,
        description,
        isAccessibleForFree: true,
        license: "https://opensource.org/license/mit",
        name: CREWHELM_SITE.name,
        url: `${CREWHELM_SITE.url}/`,
      },
    ],
  };
}

export function robotsText(): string {
  return [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${absoluteSiteUrl("/sitemap-index.xml")}`,
    "",
  ].join("\n");
}

export function llmsText(): string {
  return [
    `# ${CREWHELM_SITE.name}`,
    "",
    `> ${CREWHELM_SITE.description}`,
    "",
    "Crewhelm lets owners run long-lived AI Agents with explicit capability grants, immutable revisions, budgets, approvals, and a complete audit trail. It runs in the owner's Cloudflare account; provider credentials remain with Composio.",
    "",
    "## Product",
    "",
    `- [Crewhelm](${CREWHELM_SITE.url}/): Product overview, operating model, architecture, and installation path.`,
    "",
    "## Source and documentation",
    "",
    `- [GitHub repository](${CREWHELM_SITE.githubUrl}): Source code, README, setup instructions, and project documentation.`,
    "",
  ].join("\n");
}
