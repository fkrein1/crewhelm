# Product philosophy

Crewhelm lets an individual safely own, launch, and share useful agents without becoming a
platform operator. Powerful behavior should be easy to understand; unsafe behavior should be hard
to reach.

The [Crewhelm brand guide](brand.md) translates this philosophy into the voice and visual language
used across the public site, browser handoffs, CLI, and future product surfaces.

## Product bets

- **MCP operates; the CLI bootstraps.** The CLI deploys and diagnoses. MCP manages Agents,
  connections, policy, and runs.
- **Cloudflare runs the system.** Workers, Durable Objects, Think, Workflows, and platform storage
  own durable control and execution.
- **Framework power stays reachable.** Crewhelm preserves useful Agents and Think capabilities
  behind deterministic policy and recovery contracts.
- **Tools improve outcomes.** Code, search, fetch, and future runtime capabilities are bounded
  reasoning tools an Agent can choose when useful—not separate Agent personas or workflows the
  owner must orchestrate.
- **Paid infrastructure is progressive enhancement.** Provider-plan features are disabled by
  default, require explicit owner activation, never become enabled implicitly during an upgrade,
  and never prevent the Free-compatible Crewhelm core from operating.
- **Outcomes outlive the chat.** A durable Workflow carries one known multi-step objective across
  ordered bounded Runs, so an owner can leave the MCP conversation and return to exact progress,
  recovery, or one clear final deliverable.
- **Deliverables fit the consumer.** Markdown remains the effortless default. When downstream
  software needs predictable data, an operation may freeze one bounded JSON schema; Crewhelm
  validates the final object and never presents invalid model output as typed success.
- **Context is explicit.** Briefs let an owner attach exact versioned reference material without
  pasting it into every prompt. Capabilities remain on the Agent; inputs remain on the work.
- **Composio is the integration plane.** Crewhelm uses its catalog, authentication, and execution
  instead of rebuilding provider adapters.
- **Recipes are the eventual sharing unit.** Once the operating model is mature, a recipe will
  declare an Agent's job, model needs, Composio tools, connections, and limits without code,
  credentials, or private history.
- **Safety is product quality.** Authority, secret isolation, data integrity, recovery, and clear
  failure behavior are never deferred polish.
- **Errors are product state.** A failure must say what is known, whether retrying is safe, and
  which bounded read or action can resolve it. Durable failures remain inspectable after the
  original request ends; raw exceptions, credentials, and provider payloads do not.

## Choosing work

Choose a demonstrated user problem and set an appetite before designing the solution. Build one
coherent path, cut breadth before quality, and reshape when the implementation reveals unexpected
concepts or permanent support cost. Routine fixes do not need a product pitch.

Future recipe publishing must be explicit: recipes pin reviewed source and show requested
authority, and updates never silently widen grants.

The product should feel like asking an agent to own an outcome, not programming a workflow graph.
Use a direct Run for one bounded turn. Use a Workflow when the outcome already has a small ordered
plan that must survive disconnects. Crewhelm keeps internal Runs inspectable for diagnosis without
making the owner reconstruct them to understand progress.

The MCP experience should make the distinction obvious: configure Skills and integrations on the
Agent when they change how it works; attach exact Brief revisions when a particular Run or Workflow
needs context. List and inspection stay compact, content is fetched only on demand, and a completed
Workflow presents its final deliverable without asking the owner to find the last internal Run.

## Current non-goals

- hosted multi-tenancy, organization roles, billing, or a graphical control center;
- arbitrary executable recipes;
- custom integrations already served well by Composio;
- simultaneous support for every model or edge case; and
- a centralized marketplace backend.

These constrain product investment, not the eventual reach of the underlying frameworks.
