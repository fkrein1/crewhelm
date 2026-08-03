import { CREWHELM_BRAND_NAME, CREWHELM_BRAND_POSITIONING } from "@crewhelm/design";

export interface SocialImage {
  alt: string;
  height: number;
  mimeType: string;
  url: string | URL;
  width: number;
}

export const CREWHELM_SITE = {
  description: CREWHELM_BRAND_POSITIONING,
  githubUrl: "https://github.com/fkrein1/crewhelm",
  language: "en",
  locale: "en_US",
  name: CREWHELM_BRAND_NAME,
  socialImage: {
    alt: "Crewhelm wordmark with the message Give Agents a mandate. Not a master key.",
    height: 640,
    mimeType: "image/png",
    url: "/crewhelm-social-preview-v2.png",
    width: 1280,
  } satisfies SocialImage,
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
        description,
        isAccessibleForFree: true,
        license: "https://opensource.org/license/mit",
        name: CREWHELM_SITE.name,
        sameAs: CREWHELM_SITE.githubUrl,
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
    `- [Documentation](${CREWHELM_SITE.url}/docs/): Start here for Crewhelm concepts, guides, security responsibilities, and reference material.`,
    `- [Install Crewhelm](${CREWHELM_SITE.url}/docs/start/install/): Bring up an owner-controlled Crewhelm installation.`,
    `- [Create your first Agent](${CREWHELM_SITE.url}/docs/start/first-agent/): Configure an Agent and complete a bounded first Run.`,
    `- [Authority and custody](${CREWHELM_SITE.url}/docs/concepts/authority-and-custody/): Understand where identity, credentials, policy, and execution live.`,
    `- [Diagnose and recover](${CREWHELM_SITE.url}/docs/guides/diagnose-and-recover/): Inspect failures and choose bounded recovery actions.`,
    `- [MCP tool reference](${CREWHELM_SITE.url}/docs/reference/mcp-tools/): Inspect Crewhelm's authenticated MCP surface.`,
    `- [GitHub repository](${CREWHELM_SITE.githubUrl}): Source code, contribution guidance, and implementation documentation.`,
    "",
  ].join("\n");
}
