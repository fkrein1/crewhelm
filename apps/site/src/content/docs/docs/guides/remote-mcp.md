---
title: Connect a remote MCP server
description: Review and attach a bounded public, bearer, or OAuth remote MCP tool catalog to an Agent.
type: how-to
audience: owner
area: remote-mcp
availability: available
sources:
  - docs/reference/mcp/index.md
  - docs/architecture/mcp.md
  - docs/security/invariants.md
  - docs/security/threat-model.md
  - packages/contracts/src/remote-mcp.ts
---

Connect one public HTTPS Streamable HTTP MCP server, review its frozen tool catalog, and attach that
whole snapshot to an Agent revision under one authorization mode and bounded limit set.

## Prerequisites

- Full control access.
- A canonical public HTTPS Streamable HTTP endpoint.
- The server's required authentication kind: public, bearer, or OAuth.
- Explicit OAuth scopes when the server requires them.
- Trust in the server operator and a reason to grant its complete reviewed catalog to an Agent.

## Authority and custody

Remote MCP metadata, schemas, annotations, and results are untrusted. Connecting freezes a bounded
catalog digest; it does not grant ambient network access. Every call is revalidated against the
active Connection, Agent revision, exact tool, catalog digest, input schema, approval, limits, and
budget.

Bearer and OAuth credentials enter through a short-lived owner-bound browser setup page. Crewhelm
encrypts them at rest and never places them in MCP tool arguments or Agent context.

## Connect and review the server

1. Call `crewhelm_change_connections` with `operation.kind: "connect_remote_mcp"`, a name, the exact
   endpoint, authentication kind, and requested OAuth scopes when applicable.
2. For public authentication, inspect the returned Connection directly. For bearer or OAuth,
   complete the returned browser setup yourself.
3. Pass the returned Connection unchanged to the same tool with
   `operation.kind: "inspect_remote_mcp"`.
4. Review every discovered tool, its effect classification, input schema, and the frozen
   `snapshotDigest`.
5. Stop if the catalog contains a tool you are not prepared to expose. Attachment is for the whole
   snapshot, not a per-tool selection.

Crewhelm rejects private or local endpoints, credentials in URLs, nonstandard ports, cross-origin
redirects, unsupported schema features, and oversized catalogs.

## Attach the catalog

1. Call `crewhelm_change_connections` with `operation.kind: "grant_remote_mcp"`, the returned Agent
   and inspected Connection objects, one authorization mode, an optional expiry, and the smallest
   useful limits.
2. Prefer `approval_required`. Use standing authority only after reviewing the full catalog and
   intended effects.
3. Retain the new Agent revision.

Remote hints cannot reduce Crewhelm's effect classification. Unknown and nominally read-only tools
default to writes; destructive tools always require approval.

## Verify the Connection

- Exact inspection reports the Connection active with the reviewed snapshot digest.
- Agent inspection reports that exact Connection and catalog snapshot.
- A bounded Run can select only a tool in the frozen catalog.
- No response or error exposes bearer or OAuth credential material.

## Recover safely

- If OAuth refresh fails, use `operation.kind: "reauthenticate_remote_mcp"` with the returned
  Connection object so existing attachments remain tied to its identity. Reauthentication cannot
  widen the frozen scope set.
- If the remote catalog changes, create and review a new Connection snapshot; Crewhelm does not
  silently refresh it.
- Use `operation.kind: "delete_remote_mcp"` with the returned Connection to clear local encrypted
  credentials and attempt advertised OAuth token revocation. Deletion does not prove the remote
  server reversed an already-applied effect.
- Treat a post-dispatch transport failure as an unresolved external effect until independently
  verified.

## Next action

[Run the Agent](/docs/guides/run-agent/) with approval required and inspect the first remote tool
action carefully.
