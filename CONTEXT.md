# Crewhelm domain language

This file is a glossary, not a specification. Use these terms consistently in code, tests, issues,
and documentation.

## Agent

A long-lived, owner-controlled actor with an explicit model, instructions, capability grants, and
execution limits.

## Agent revision

An immutable snapshot of an agent's configuration. A configuration change creates a new revision;
a run records the revision it uses.

## Bootstrap CLI

The local command-line tool that creates or connects the infrastructure needed to operate a
Crewhelm control plane. It is not the ongoing administration surface.

## Capability grant

A bounded permission to perform a class of actions. Only the control plane can grant it.

## Connection

An owner's authorization relationship with an external provider or remote MCP server. A connection
is represented to agents by an opaque identifier, never by the underlying credential.

## Control plane

The owner-authoritative source of truth for Agent, connection, and policy definitions, along with
run admission and administrative lifecycle. Runtime execution state belongs to the Agent or
Workflow performing it.

## MCP client

An owner-authorized AI tool, such as Claude or Codex, that administers the control plane through
Crewhelm's MCP interface.

## Recipe

An immutable public declaration of one responsibility: Agent instructions and limits, pinned
Skills, Connection requirements, inputs, and bounded operation templates. The Registry holds only
public untrusted packages. An owner-local installation receipt pins the confirmed plan and imported
assets; it contains no credentials, grants no authority, and starts no work.

## Run

One bounded attempt by an agent to complete a task under a fixed policy and budget snapshot.

## Schedule

A named recurring instruction that starts a fresh Run for one exact Agent revision at an elapsed
interval or wall-clock time.

## Event Trigger

A named connected-app event rule that starts a fresh Run for one exact Agent revision when a
matching event occurs. It is an occurrence source, not authority.

## Tool gate

The deterministic execution-time policy boundary that decides whether a requested tool action is
allowed, denied, or requires approval. Tool visibility alone is not authorization.
