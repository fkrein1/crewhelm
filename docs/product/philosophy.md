# Product philosophy

Crewhelm lets an individual safely own, launch, and share useful agents without becoming a
platform operator. Powerful behavior should be easy to understand; unsafe behavior should be hard
to reach.

## The product bet

- **MCP operates; the CLI bootstraps.** The CLI deploys and diagnoses. MCP manages agents,
  connections, recipes, policy, and runs.
- **Cloudflare runs the system.** Workers, Durable Objects, Think, Workflows, and platform storage
  provide the durable control and execution plane.
- **Framework power stays reachable.** MCP should administer the complete useful Agent lifecycle,
  and Crewhelm adapters should preserve the underlying Agents/Think capabilities instead of
  replacing them with a permanently reduced abstraction. Capabilities ship behind deterministic
  policy and recovery contracts, not by bypassing them.
- **Composio is the integration and web plane.** Its 1,000+ toolkits provide discovery,
  authentication, and execution for apps and web providers such as Firecrawl. Crewhelm should not
  rebuild those adapters or maintain a curated toolkit subset. Every catalog integration is
  eligible for owner connection and grant when it can satisfy Crewhelm's execution contract.
- **Recipes are the sharing unit.** A recipe declares an agent's job, model needs, Composio tools,
  connections, and limits. It contains no code, credential, or private history.
- **Safety is product quality.** Authority, secret isolation, data integrity, recovery, and clear
  failure behavior are never deferred polish.

## Choose work

Choose a user problem, not a component. Set the maximum investment—the **appetite**—before
designing the solution. Fix the appetite and quality; vary feature scope. Cut breadth and rare
cases before security, correctness, clear code, meaningful tests, or recovery.

Shape a meaningful capability with:

```text
Problem and evidence:
User payoff:
Appetite:
Epicenter:
Solution outline:
Rabbit holes:
No-gos:
Security and compatibility invariants:
Proof of success:
Stop or reshape condition:
```

Routine fixes and maintenance do not need a product pitch.

## Build the epicenter

Build one complete path before completing every layer:

```text
fresh clone -> bootstrap -> connect -> create agent -> run -> inspect -> revoke
```

- Prefer one coherent path over partial breadth.
- Let implementation push back. Unexpected concepts or surface area are product feedback.
- When appetite expires, ship a smaller whole or reshape; do not lower quality.
- Every built-in feature must earn its permanent policy, testing, documentation, and support cost.
- Treat issues as evidence, not roadmap promises.

## Grow through recipes

```text
prove an agent -> export a recipe -> validate and demo -> owner-confirmed PR
-> reviewed immutable version -> install, fork, credit, improve
```

Publishing is explicit. Installation shows the effective authority requested and pins the reviewed
source. Updates never silently widen grants. Make this Git loop excellent before building a hosted
marketplace.

## Scope boundaries

- hosted multi-tenancy, organization roles, billing, or a graphical control center;
- arbitrary executable recipes;
- custom integrations already served well by Composio;
- simultaneous support for every model or edge case; and
- a centralized marketplace backend.

These bound product investment, not underlying capability reach. Framework features, models, and
integrations can land incrementally while preserving a path to the full Agent framework and
Composio catalog.

## Influences

- [Shape Up](https://basecamp.com/shapeup)
- [Getting Real: Build Less](https://basecamp.com/gettingreal/02.1-build-less)
- [Getting Real: Epicenter Design](https://basecamp.com/gettingreal/09.2-epicenter-design)
- [DHH: Less software](https://world.hey.com/dhh/less-software-c69de1e8)

Crewhelm borrows principles, not another company's process. It does not require six-week cycles,
betting meetings, or a ban on useful issue tracking.
