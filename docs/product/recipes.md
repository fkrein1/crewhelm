# Recipes

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
- named Brief or invocation inputs, with each recurring operation naming the Brief slots it uses;
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

A public Brief input is only a portable name, description, and required-or-optional declaration.
Each Schedule or Event Trigger names the Brief inputs it needs. Installation binds those names to
exact owner-local Brief revisions; the Registry never receives the content, ID, or revision.

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
3. remove the Skill from the public candidate.

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

- The public contract lives under `/api/registry` on the Crewhelm site origin. A narrow site Worker
  gateway forwards only that prefix to an internal Registry Worker through a service binding. Each
  deployed environment isolates its Workers, storage, indexes, rate limits, and OAuth application.
- R2 stores immutable Recipe and Skill packages keyed by canonical digest.
- D1 stores publisher identity, artifact names and versions, searchable projections, dependency
  edges, lifecycle and review state, reports, and explicit social signals.
- The site and Crewhelm MCP use the same public read contract.
- Search and list responses use compact D1 projections; exact inspection reads the immutable R2
  package only after selection.
- Outcome search embeds only bounded public Recipe discovery metadata into Vectorize. It returns a
  bounded ranked shortlist, has no generated answer, and falls back to D1 full-text search while a
  new version is pending or embeddings are unavailable.
- Public reads are cacheable and rate limited. Publisher GitHub identity, per-publisher daily
  quotas, immutable versions, idempotency, and content checks bound public write abuse; search does
  not persist raw queries or receive installation identity.
- Agent publishing uses a short-lived, one-publication authorization bound to the owner's
  idempotency key. The browser keeps the GitHub session at the Registry; the owner instance proves
  possession of its verifier without receiving the GitHub token or Registry cookie.
- Publication preparation starts from one exact owner-local Agent revision. The owner control plane
  copies its executable definition, converts selected recurring operations and Connection grants
  into portable declarations, replaces exact Brief references with named inputs, and returns one
  candidate for public review and editing before authorization and digest confirmation.
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
- exact owner-local Brief bindings for the selected recurring operation slots, including missing
  required inputs and combinations that exceed the bounded Brief context;
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

Installation durably records that exact plan, imports or reuses each selected pinned Skill, and
creates a disabled Agent with the resulting local Skill references. Selected Connection bindings,
Brief bindings, the primary operation, Schedules, and Event Triggers remain inert in the
installation receipt.
MCP builds the plan as a short-lived owner-local draft: prepare the exact public target, update
setup values and bindings one decision at a time, preview the stored draft, then install that exact
draft and confirmation digest. Large plans are not copied through every MCP turn.
Granting Connection authority or activating an operation is a separate explicit owner action. If a
write is interrupted, the returned installation ID resumes deterministic child writes from the same
stored plan; it does not fetch a changed public plan or duplicate completed imports.

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
4. Recoverable installation of Skills and a disabled Agent, with confirmed Connection bindings and
   operation templates retained as inert owner-local plan data.
5. Explicit Agent-to-Recipe publishing with per-Skill decisions.
6. Outcome-first site discovery, dependency and authority inspection, samples, versions, review,
   reports, and social signals.

Standalone Skill ranking, transitive dependencies, executable public Skills, automatic upgrades,
runtime Registry access, hosted execution, and private usage analytics remain outside the initial
product.
