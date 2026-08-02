---
title: Access levels
description: Compare Crewhelm View only, Use agents, and Full control MCP authorization levels.
type: reference
audience: owner
area: authentication
availability: available
sources:
  - README.md
  - apps/worker/src/oauth/access-levels.ts
  - apps/worker/src/oauth/scopes.ts
  - packages/contracts/src/control-plane.ts
---

Crewhelm presents three stable access levels during MCP authorization. Each maps to fixed internal
capabilities before an operation reaches its owning module.

| Access level | OAuth scope     | What it allows                                                                                                                       |
| ------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| View only    | `crewhelm:view` | Inspect fleet, Agent, Connection, authentication-configuration, and integration catalog state.                                       |
| Use agents   | `crewhelm:use`  | Everything in View only, plus start and operate Runs and decide Run-time approvals.                                                  |
| Full control | `crewhelm:full` | Reconfigure Agents, integrations, Connections, automation, fleet policy, and other control-plane state, in addition to using Agents. |

The installation owner defaults to Full control. Choose a narrower level when the MCP client does
not need administrative writes.

## Internal capability mapping

| Access level | Internal capabilities                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| View only    | `control:read`, `agents:read`, `connections:read`, `connection-configs:read`, `integrations:read`                                                                                                                   |
| Use agents   | View only capabilities plus `runs:write`                                                                                                                                                                            |
| Full control | `control:read`, `control:write`, `agents:read`, `agents:write`, `runs:write`, `autonomy:write`, `connections:read`, `connections:write`, `connection-configs:read`, `connection-configs:write`, `integrations:read` |

`offline_access` may accompany an access level when a client requests refresh access. It is not an
access level and does not grant Crewhelm operations by itself.

## Enforcement notes

- Tool discovery does not grant execution authority.
- Access levels do not bypass Agent revisions, capability grants, Connection state, approvals,
  limits, budgets, or single-use permits.
- Prompt text cannot widen an access level.
- Tokens and existing client registrations are never silently widened.
- Changing the configured GitHub owner blocks new authorization and refresh, but an already issued
  access token may remain valid for no more than 15 minutes unless explicitly revoked.

If a call returns `insufficient_scope`, authorize the required level only after confirming that the
client should perform that class of operation.
