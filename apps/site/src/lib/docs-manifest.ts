interface DocsPage {
  label: string;
  slug: string;
}

interface DocsSection {
  label: string;
  pages: readonly DocsPage[];
}

export const DOCS_SECTIONS = [
  {
    label: "Start",
    pages: [
      { label: "Overview", slug: "docs" },
      { label: "Install Crewhelm", slug: "docs/start/install" },
      { label: "Connect an MCP client", slug: "docs/start/connect-mcp" },
      { label: "Create your first Agent", slug: "docs/start/first-agent" },
    ],
  },
  {
    label: "Concepts",
    pages: [
      { label: "Operating model", slug: "docs/concepts/operating-model" },
      { label: "Authority and custody", slug: "docs/concepts/authority-and-custody" },
    ],
  },
  {
    label: "Guides",
    pages: [
      { label: "Run an Agent", slug: "docs/guides/run-agent" },
      { label: "Durable Workflows", slug: "docs/guides/workflows" },
      { label: "Briefs and Skills", slug: "docs/guides/briefs-and-skills" },
      { label: "Install a Recipe", slug: "docs/guides/install-recipe" },
      { label: "Publish a Recipe", slug: "docs/guides/publish-recipe" },
      { label: "Connections", slug: "docs/guides/connections" },
      { label: "Remote MCP", slug: "docs/guides/remote-mcp" },
      { label: "Schedules", slug: "docs/guides/schedules" },
      { label: "Event Triggers", slug: "docs/guides/event-triggers" },
      { label: "Diagnose and recover", slug: "docs/guides/diagnose-and-recover" },
    ],
  },
  {
    label: "Security",
    pages: [{ label: "Owner responsibilities", slug: "docs/security/owner-responsibilities" }],
  },
  {
    label: "Reference",
    pages: [
      { label: "Access levels", slug: "docs/reference/access-levels" },
      { label: "Errors and recovery", slug: "docs/reference/errors" },
      { label: "MCP tools", slug: "docs/reference/mcp-tools" },
    ],
  },
] as const satisfies readonly DocsSection[];

export const DOCS_ROUTES = DOCS_SECTIONS.flatMap(({ pages }) =>
  pages.map(({ slug }) => `/${slug}/`),
);

export function docsSidebar(): Array<{ items: DocsPage[]; label: string }> {
  return DOCS_SECTIONS.map(({ label, pages }) => ({
    label,
    items: pages.map(({ label: pageLabel, slug }) => ({ label: pageLabel, slug })),
  }));
}
