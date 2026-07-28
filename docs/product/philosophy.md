# Product philosophy

Crewhelm lets an individual safely own, launch, and share useful agents without becoming a
platform operator. Powerful behavior should be easy to understand; unsafe behavior should be hard
to reach.

## Product bets

- **MCP operates; the CLI bootstraps.** The CLI deploys and diagnoses. MCP manages agents,
  connections, recipes, policy, and runs.
- **Cloudflare runs the system.** Workers, Durable Objects, Think, Workflows, and platform storage
  own durable control and execution.
- **Framework power stays reachable.** Crewhelm preserves useful Agents and Think capabilities
  behind deterministic policy and recovery contracts.
- **Composio is the integration plane.** Crewhelm uses its catalog, authentication, and execution
  instead of rebuilding provider adapters.
- **Recipes are the sharing unit.** A recipe declares an agent's job, model needs, Composio tools,
  connections, and limits. It contains no code, credential, or private history.
- **Safety is product quality.** Authority, secret isolation, data integrity, recovery, and clear
  failure behavior are never deferred polish.

## Choosing work

Choose a demonstrated user problem and set an appetite before designing the solution. Build one
coherent path, cut breadth before quality, and reshape when the implementation reveals unexpected
concepts or permanent support cost. Routine fixes do not need a product pitch.

Publishing is explicit. Recipes pin reviewed source and show requested authority; updates never
silently widen grants.

## Current non-goals

- hosted multi-tenancy, organization roles, billing, or a graphical control center;
- arbitrary executable recipes;
- custom integrations already served well by Composio;
- simultaneous support for every model or edge case; and
- a centralized marketplace backend.

These constrain product investment, not the eventual reach of the underlying frameworks.
