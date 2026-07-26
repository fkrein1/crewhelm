# Threat model

Status: initial foundation

## Scope

Crewhelm will expose a remote MCP administration surface, a private control plane, isolated agent
runtimes, and provider connectors. This document records the minimum threats that architecture and
implementation must address as those components are introduced.

## Assets

- Owner identity and authorization grants
- Composio project authority, connected accounts, and provider credentials
- Agent configuration, memory, artifacts, and schedules
- Recipe integrity and installed capability grants
- Audit history, budgets, and recovery material
- Repository instructions, automation, and release authority

## Trust boundaries

1. MCP client to public MCP ingress
2. Public ingress to the private control plane
3. Control plane to agent runtime and workflows
4. Runtime to Composio and external toolkits
5. Repository recipe to installed, owner-approved configuration
6. Build and release automation to published packages and deployments

## Primary threats

- Token theft, issuer/subject collision, confused-deputy behavior, and cross-owner references
- Prompt injection causing unauthorized tools, destinations, data flow, or self-approval
- Stale or replayed approval after policy, connection, or revocation changes
- Tool-name/source collision or raw Composio paths bypassing `ToolGate`
- Child-agent privilege amplification or lost cancellation
- Credential disclosure through model context, logs, errors, URLs, or backups
- SSRF, redirect abuse, arbitrary egress, and hostile external MCP servers
- Idempotency-key collision, duplicate effects, and unknown provider outcomes during retries
- Runaway loops, schedules, fan-out, provider usage, and cost
- Malicious or silently widened marketplace recipes
- Unsafe migrations, deletion without revocation, and restore that reactivates execution
- Compromised dependencies, CI workflows, or package publication
- Instruction poisoning or unsafe pull-request automation causing an agent or maintainer to run
  attacker-controlled commands

## Required control families

- Validated OAuth claim mapping, owner-namespaced references, and scoped execution permits
- Execution-time capability intersection and owner approval distinct from model output
- Default-empty tool inventory, capability IDs, and authority attenuation for child agents
- Pinned Composio execution with explicit accounts; Sessions, raw proxy, and model connection
  management stay disabled
- Schema, provenance, size, and content validation
- Idempotency, audit, budgets, rate limits, and a kill switch
- Versioned migrations, backup, quarantined restore, and rollback procedures
- Locked dependencies, minimal CI permissions, review gates, and release provenance
- Review instruction, workflow, manifest, and lockfile changes before running agents or scripts on
  untrusted contributions; never expose repository secrets to fork pull requests

## Update triggers

Update this model whenever a change adds a trust boundary, data class, provider, execution
capability, external side effect, authentication flow, persistent store, migration, or release
channel.
