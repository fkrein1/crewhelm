# Recipes

Status: planned portable contract; Registry persistence and owner-local installation are separate
delivery slices.

Crewhelm Recipes make useful responsibilities portable without moving authority, credentials, or
private owner context into a public service. A Recipe is one immutable mandate with one primary Run
or Workflow template plus bounded optional Schedules and Event Triggers. It is the public sharing
unit; the owner-scoped Agent revision remains the exact local execution unit.

## User promise

An owner can discover or publish a responsibility, understand what it owns, what they must provide,
what it returns, when it acts, what it can read or change, and its broad cost envelope, then resolve
it against their own Crewhelm installation before anything is created or granted.

The public surface explains the outcome. The immutable package preserves the exact untrusted
implementation. Local preview chooses the accounts, catalog snapshots, Skills, Briefs, authority,
model, budget, time zone, and final operations.

## Portable package

A Recipe declares:

- responsibility title, summary, expected outcome, and explicit boundaries;
- exact Agent instructions, a suggested name, typed setup parameters, capability configuration,
  and execution ceilings;
- required or optional immutable Skill dependencies;
- named Composio or remote MCP Connection slots and requested tool authority;
- named Brief or invocation inputs;
- one primary direct Run or durable Workflow template;
- zero to eight Schedule and Event Trigger templates in total;
- explicit Markdown or bounded JSON output contracts and one synthetic primary sample; and
- discovery description, canonical tags, declared license, source provenance, and package integrity.

A Recipe contains no credentials, owner-local IDs, private Briefs, grants, approval decisions, Run
history, runtime telemetry, or executable code. Exact model and provider configuration may be
portable when its capability module is portable; local preview remains authoritative for
availability and pricing.

One Recipe owns one responsibility. Its operations are bounded entry points, not a programmable
workflow graph. The primary operation describes a deliberate invocation. Schedules describe when
recurring work starts; Event Triggers describe which connected events start work. Both start one
normal bounded Run and carry no authority of their own.

## Skill artifacts

Skills preserve enough specialized method that excluding them would make many Recipes superficial.
The Registry therefore stores selected Skills as separate immutable artifacts rather than embedding
them in Recipe packages.

A Recipe pins each Skill by Registry origin, publisher namespace, name, version, digest, and
required or optional status. Initial public Skill artifacts contain bounded UTF-8 `SKILL.md`,
references, and text assets. They do not accept `scripts/`, transitive dependencies, floating
versions, or automatic updates.

Publishing an Agent requires an explicit decision for every local Skill:

1. publish an exact public Skill version with the Recipe;
2. reference an existing Registry version with the same digest; or
3. remove the Skill from the public candidate and rehearse the changed behavior.

Publishing never silently sanitizes a Skill, copies its instructions into the Agent, or republishes
third-party content. Public artifacts require declared license and provenance. Suspected secrets,
private identifiers, unsupported files, unresolved local coordinates, and missing attribution fail
closed.

Installation fetches and verifies the authoritative public bytes itself, imports an exact copy into
owner-local storage, assigns a local Skill ID, and attaches that version to the new Agent revision.
The MCP orchestrator may progressively inspect every raw file as bounded untrusted content, but its
copy is never accepted as installation input. Registry origins are canonical public HTTPS endpoints;
the owner fetch path rejects local or private resolved targets and unsafe redirects. Registry
availability is not a runtime dependency.

## Registry custody

The Registry is a normal public HTTP service, not an owner control plane or runtime marketplace.

- R2 stores immutable Recipe and Skill packages keyed by canonical digest.
- D1 stores publisher identity, artifact names and versions, searchable projections, dependency
  edges, lifecycle and review state, reports, and explicit social signals.
- The site and Crewhelm MCP use the same public read contract.
- Search and list responses use compact D1 projections; exact inspection reads the immutable R2
  package only after selection.
- Public snapshots and change feeds preserve an open read contract for mirrors.

The Registry never holds owner Connections, credentials, Briefs, grants, installation receipts, or
runtime telemetry. Downloads and upvotes are public signals, not evidence of private usage, safety,
or effectiveness.

## Local preview

The owner instance combines public content with private local facts. Preview resolves:

- exact inference and capability availability;
- existing or missing Skill versions;
- Connection bindings and the entire reviewed remote MCP catalog breadth;
- exact Composio tool versions, effect classification, requested authorization, expiry, and limits;
- Brief and invocation input choices;
- Schedule timing and owner-selected time zone, plus Event Trigger sources and filters;
- output contracts, aggregate budget, current pricing, and installation prerequisites; and
- how each untrusted Skill can influence the exact authority proposed for the Agent.

Raw Skill Markdown is inspected as inert source. Product surfaces do not activate HTML, remote
images, or automatic URL fetches. Deterministic checks report bounds, unsafe paths, suspected
secrets or private identifiers, hidden or obfuscated text, active Markdown, executable content, and
dependency mismatch. Semantic review is advisory: no model or review label can prove a Skill safe.

Preview creates no Agent, imports no Skill, attaches no Connection, grants no authority, creates no
Schedule or Event Trigger, and starts no work. A later installation must re-fetch and verify every
digest and match the confirmed installation plan.

## Updates and lifecycle

Recipe and Skill versions are immutable. Changing instructions, operations, output, dependencies,
or requested authority creates a new version. Installed Agents never follow public updates
automatically; an update requires a new local preview and explicit Agent revision. A changed Skill
digest also requires a new Recipe version when the Recipe adopts it.

Registry restriction or retirement changes discovery and future installation policy. It does not
mutate or disable an existing owner-local copy. Runtime authority remains entirely under the
owner's control plane and normal revocation paths.

## Delivery boundaries

1. Portable packages, Skill artifacts, Registry envelopes, projections, integrity, and trust
   contracts.
2. Immutable Registry persistence, public discovery and reads, publisher identity, validation, and
   publishing.
3. Owner-local MCP search, exact inspection, raw Skill review, compatibility, authority, cost, and
   installation preview.
4. Recoverable installation of Skills, Agent, bindings, retained operation templates, and selected
   Schedules and Event Triggers without automatically starting work.
5. Explicit Agent-to-Recipe publishing with per-Skill decisions.
6. Outcome-first site discovery, dependency and authority inspection, samples, versions, review,
   reports, and social signals.

Standalone Skill ranking, transitive dependencies, executable public Skills, automatic upgrades,
runtime Registry access, hosted execution, and private usage analytics remain outside the initial
product.
