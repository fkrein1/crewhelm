# Threat model

Status: initial foundation

## Scope

Crewhelm will expose a remote MCP administration surface, a private control plane, isolated agent
runtimes, and provider connectors. This document records the minimum threats that architecture and
implementation must address as those components are introduced.

## Assets

- Owner identity and authorization grants
- Provider credentials and connected accounts
- Agent configuration, memory, artifacts, and schedules
- Recipe integrity and installed capability grants
- Audit history, budgets, and recovery material
- Repository instructions, automation, and release authority

## Trust boundaries

1. MCP client to public MCP ingress
2. Public ingress to the private control plane
3. Control plane to agent runtime and workflows
4. Runtime to connector and network egress
5. Repository recipe to installed, owner-approved configuration
6. Build and release automation to published packages and deployments

## Primary threats

- Token theft, confused-deputy behavior, session hijacking, and cross-owner access
- Prompt injection causing unauthorized tools, destinations, or data flow
- Credential disclosure through model context, logs, errors, URLs, or backups
- SSRF, redirect abuse, arbitrary egress, and hostile external MCP servers
- Duplicate or partial external side effects during retries
- Runaway loops, schedules, fan-out, provider usage, and cost
- Malicious or silently widened marketplace recipes
- Unsafe migrations, deletion without revocation, and restore that reactivates execution
- Compromised dependencies, CI workflows, or package publication
- Instruction poisoning or unsafe pull-request automation causing an agent or maintainer to run
  attacker-controlled commands

## Required control families

- OAuth 2.1 authentication and execution-time authorization
- Capability intersection and step-up approval
- Typed, allowlisted connector egress without secret access
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
