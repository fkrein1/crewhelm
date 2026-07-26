# Crewhelm domain language

This file is a glossary, not a specification. Use these terms consistently in code, tests, issues,
and documentation.

## Agent

A long-lived, owner-controlled actor with an explicit model, instructions, capability grants, and
execution limits.

## Agent revision

An immutable snapshot of an agent's configuration and installed recipe. A configuration change
creates a new revision; a run records the revision it uses.

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

The owner-authoritative source of truth for agent, connection, recipe, and policy definitions,
along with run admission and administrative lifecycle. Runtime execution state belongs to the
agent or Workflow performing it.

## MCP client

An owner-authorized AI tool, such as Claude or Codex, that administers the control plane through
Crewhelm's MCP interface.

## Recipe

A versioned, declarative template for an agent's model, instructions, requested capabilities,
connection requirements, and limits. A recipe contains neither credentials nor executable code.

## Run

One bounded attempt by an agent to complete a task under a fixed policy and budget snapshot.

## Tool gate

The deterministic execution-time policy boundary that decides whether a requested tool action is
allowed, denied, or requires approval. Tool visibility alone is not authorization.
