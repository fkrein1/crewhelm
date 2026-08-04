---
title: Choose and enable models
description: Browse Cloudflare AI models, enable an exact model ID, select it for an Agent, and safely remove it later.
type: how-to
audience: owner
area: agents
availability: available
sources:
  - docs/reference/mcp/index.md
  - docs/architecture/system.md
  - packages/contracts/src/model-catalog.ts
  - apps/worker/src/mcp/model-tools.ts
  - apps/worker/src/owner/model-catalog/module.ts
---

Use Cloudflare's AI catalog to add a model without waiting for a Crewhelm release. Crewhelm
starts with a small catalog; you decide which exact model IDs are enabled for your Agents.

## Before you begin

- Full control access.
- A model available in the [Cloudflare AI model catalog](https://developers.cloudflare.com/ai/models/).
- Any Cloudflare billing or account prerequisites for that model. Third-party models use unified
  billing; Crewhelm does not infer billing readiness.

`browse_models` returns only text-generation models that Crewhelm can route with tools. Workers AI
entries are live; third-party entries come from an hourly, last-known-good Cloudflare snapshot.
Snapshot provenance is returned with every page. OpenAI models use Responses, Anthropic models use
Anthropic Messages, and compatible providers use Chat Completions.

Cloudflare descriptions, capabilities, and pricing are untrusted provider data. Enabling a model
does not certify its quality.

## Discover and enable a model

1. Call `crewhelm_inspect_models` and select `browse_models`.
2. Filter by `query`, `provider`, `platform`, `task`, or `capability`. Results use relevance order
   and omit descriptions by default; set `includeDescriptions: true` for a narrowed comparison.
   Reuse the same filters with `nextPage` when another page exists.
3. Call `inspect_model` with the exact returned model ID. Confirm that `availability` is
   `available` and `runtimeCompatibility` is `compatible`. Review its compatibility evidence,
   provider source, platform, and pricing source.
4. Call `list_enabled_models` and retain its model-catalog `revision`.
5. Call `crewhelm_change_models` with `operation.kind: "add_model"`, the exact `modelId`, the current
   `expectedRevision`, one stable `requestKey`, and `confirm: false`.
6. Repeat the unchanged operation with the same `requestKey` and `confirm: true` to enable it.
7. Create or replace an Agent with the `inference.workers-ai` capability and the exact enabled ID
   as `primaryModel`. Agent revisions pin that exact ID.

## Verify the result

- `list_enabled_models` includes the exact ID and a newer catalog revision.
- Agent creation returns the exact enabled ID. Execution limits remain independent of model choice.

## Remove or change a model

1. Call `list_enabled_models` and retain the current revision.
2. Call `crewhelm_change_models` with `operation.kind: "remove_model"`, the exact ID,
   `expectedRevision`, one stable `requestKey`, and `confirm: false`.
3. Review `impact.affectedAgents`. This bounded list contains current Agents configured with the
   model as their primary or a fallback; `affectedAgentsTotal` reports the complete count.
4. If the model is the current default, include an already-enabled `replacementDefaultModelId`.
5. Repeat the unchanged operation with the same `requestKey` and `confirm: true`.

Removal prevents new Agent admission and Runs that depend on the disabled model. It does not rewrite
or delete immutable Agent revisions.

## Recover safely

- On `revision_conflict`, list enabled models again and decide against the new current revision.
- On `model_unavailable`, repeat exact inspection. Do not substitute a similarly named ID.
- Resolve billing failures in Cloudflare before retrying the same immutable Agent revision.
- If a removal preview is truncated, inspect Agents by exact model ID before confirming.

## Next step

[Create your first Agent](/docs/start/first-agent/) with the enabled model, or review
[owner responsibilities](/docs/security/owner-responsibilities/) before enabling a paid model.
