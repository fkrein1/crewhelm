# 0003: Declarative recipes on a hardened generic runtime

Status: accepted

## Context

Crewhelm needs shareable agents and broad integrations without deploying recipe code or rebuilding
provider adapters. Think and Composio are powerful, but their defaults are broader than Crewhelm's
authority model.

## Decision

- Use one data-driven `CrewAgent` class based on Think for all logical agent instances.
- Keep recipes immutable data with no code, credential, tool implementation, or grant.
- Keep Think behind Crewhelm-owned recipe, command, policy, event, and error contracts.
- Register tools explicitly and pass every call through execution-time `ToolGate` authorization.
- Disable Think workspace Bash, automatic MCP tool exposure, and default full-grant turn
  authorization.
- Use Composio as the default app and web integration plane, including Firecrawl. Search its
  catalog, then execute exact tool, version, and connected-account grants directly; do not expose
  Sessions or raw execution paths to the model.
- Use Cloudflare Actions only behind a stable Crewhelm boundary with pinned-version compatibility
  tests while that API is experimental.

## Consequences

- Installing a recipe never deploys code.
- New Composio toolkits do not require Crewhelm provider code.
- A new executable capability requires reviewed product code rather than recipe syntax.
- Think supplies the runtime mechanics without defining Crewhelm's public contracts or authority.
- Think or Composio upgrades require behavioral and security compatibility tests.

## Revisit when

Revisit if a demonstrated use case cannot fit declarative recipes, Think, or Composio. Do not
respond with arbitrary recipe code or an ungated provider path.
