# Crewhelm domain language

This file is a glossary, not a specification. Use these terms consistently in code, tests, issues,
and documentation.

## Agent

A long-lived, owner-controlled actor with an explicit model, instructions, capability grants, and
execution limits.

## Bootstrap CLI

The local command-line tool that creates or connects the infrastructure needed to operate a
Crewhelm control plane. It is not the ongoing administration surface.

## Capability grant

A bounded permission to perform a class of actions. A recipe may request a capability; only the
control plane can grant it.

## Connection

An owner's authorization relationship with an external provider. A connection is represented to
agents by an opaque identifier, never by the underlying credential.

## Control plane

The owner-authoritative source of truth for agents, connections, recipes, policy, runs, and their
lifecycle.

## MCP client

An owner-authorized AI tool, such as Claude or Codex, that administers the control plane through
Crewhelm's MCP interface.

## Recipe

A versioned, declarative template for an agent's model, instructions, requested capabilities,
connection requirements, and limits. A recipe contains neither credentials nor executable code.

## Run

One bounded attempt by an agent to complete a task under a fixed policy and budget snapshot.
