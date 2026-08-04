interface DocsPage {
  label: string;
  slug: string;
}

interface DocsGroup {
  collapsed?: boolean;
  items: readonly DocsPage[];
  label: string;
}

interface DocsSection {
  label: string;
  pages: readonly (DocsGroup | DocsPage)[];
}

interface DocsSidebarGroup {
  collapsed?: boolean;
  items: Array<DocsPage | DocsSidebarGroup>;
  label: string;
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
      { label: "Models", slug: "docs/guides/models" },
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
      {
        collapsed: false,
        items: [
          { label: "Overview", slug: "docs/reference/mcp" },
          { label: "Agents", slug: "docs/reference/mcp/agents" },
          { label: "Automations", slug: "docs/reference/mcp/automations" },
          { label: "Connections", slug: "docs/reference/mcp/connections" },
          { label: "Models", slug: "docs/reference/mcp/models" },
          { label: "Context", slug: "docs/reference/mcp/context" },
          { label: "Recipes", slug: "docs/reference/mcp/recipes" },
          { label: "Work", slug: "docs/reference/mcp/work" },
          { label: "Recover", slug: "docs/reference/mcp/recover" },
        ],
        label: "MCP",
      },
    ],
  },
] as const satisfies readonly DocsSection[];

export const DOCS_ROUTES = DOCS_SECTIONS.flatMap(({ pages }) =>
  pages.flatMap((page) =>
    "slug" in page ? [`/${page.slug}/`] : page.items.map(({ slug }) => `/${slug}/`),
  ),
);

export function docsSidebar(): DocsSidebarGroup[] {
  return DOCS_SECTIONS.map(({ label, pages }) => ({
    label,
    items: pages.map((page) =>
      "slug" in page
        ? { label: page.label, slug: page.slug }
        : {
            collapsed: page.collapsed,
            items: page.items.map(({ label: pageLabel, slug }) => ({ label: pageLabel, slug })),
            label: page.label,
          },
    ),
  }));
}
