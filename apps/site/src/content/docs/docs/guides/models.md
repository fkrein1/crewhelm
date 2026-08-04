---
title: Choose and enable models
description: Discover live Cloudflare AI models, enable an exact model ID, select it for an Agent, and safely remove it later.
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

Use Cloudflare's live AI catalog to add a model without waiting for a Crewhelm release. Crewhelm
starts with a small recommended catalog, but you decide which exact model IDs are enabled for your
Agents.

## Before you begin

- Full control access.
- A model available in the [Cloudflare AI model catalog](https://developers.cloudflare.com/ai/models/).
- A text-generation model compatible with Crewhelm's Chat Completions and tool-call runtime.
- Any Cloudflare billing or account prerequisites for that model. Third-party models use
  Cloudflare unified billing; Crewhelm does not infer your balance or billing readiness.

Cloudflare catalog facts, descriptions, capability labels, and pricing links are untrusted provider
data. Crewhelm returns their source and retrieval time. Crewhelm does not call a model “tested” or
“untested,” and enabling one is not a quality certification.

The model-search endpoint is the authority for current inventory, not a release feed. It supports
name and description search plus author and task filters, but does not publish a release timestamp
or guarantee newest-first ordering. Capability filters use only Cloudflare-declared tags and
properties; `unspecified` means the catalog did not declare the capability, not that Crewhelm tested
and rejected it. Pricing is returned as catalog-reported facts when present, otherwise as the
relevant Cloudflare pricing reference with a retrieval time.

## Discover and enable a model

1. Call `crewhelm_inspect_models` and select `search_models`.
2. Search by `query`, `provider`, `task`, or a declared `capability`. Search results come from the
   live Cloudflare binding, not a model list compiled into Crewhelm.
3. Call `inspect_model` with the exact returned model ID. Confirm that `availability` is
   `available` and `runtimeCompatibility` is `compatible`. Review the provider source, retrieval
   time, platform, and current pricing source.
4. Call `list_enabled_models` and retain its model-catalog `revision`.
5. Call `crewhelm_change_models` with `operation.kind: "add_model"`, the exact `modelId`, the
   current `expectedRevision`, one stable `requestKey`, and `confirm: false`. Crewhelm inspects the
   live model again and previews the next owner catalog.
6. Repeat the unchanged operation with the same `requestKey` and `confirm: true` to enable it.
7. Create or replace an Agent with the `inference.workers-ai` capability and the exact enabled ID
   as `primaryModel`. Agent revisions pin that exact ID.

For example, when Kimi K3 appears in Cloudflare, search for `kimi k3`, inspect
`moonshotai/kimi-k3`, preview and confirm its addition, then select that ID for a test Agent. This
path requires no Crewhelm version that knows the ID in advance.

## Verify the result

- `list_enabled_models` includes the exact ID and a newer catalog revision.
- Agent creation returns the same exact model ID.
- The model remains separate from fleet execution limits: turns, duration, output tokens, tool
  calls, and concurrency continue to be bounded independently.
- Provider availability and owner enablement remain distinct. A returned model can be available at
  Cloudflare while disabled for this owner.

## Remove or change a model

1. Call `list_enabled_models` and retain the current revision.
2. Call `crewhelm_change_models` with `operation.kind: "remove_model"`, the exact ID,
   `expectedRevision`, one stable `requestKey`, and `confirm: false`.
3. Review `impact.affectedAgents`. This bounded list contains current Agents configured with the
   model as their primary or a fallback; `affectedAgentsTotal` reports the complete count.
4. If the model is the current default, include an already-enabled `replacementDefaultModelId`.
5. Repeat the unchanged operation with the same `requestKey` and `confirm: true`.

Removal prevents new Agent admission and new Runs that depend on the disabled model. It does not
rewrite or delete immutable Agent revisions. A direct Agent creation attempt reports
`model_disabled`; a model absent from live Cloudflare discovery reports `model_unavailable`; a
non-text-generation model reports `model_incompatible` when enablement is previewed.

## Recover safely

- On `revision_conflict`, list enabled models again and decide against the new current revision.
- On `model_unavailable`, repeat exact inspection. Do not substitute a similarly named ID.
- On a billing or credit failure during execution, resolve it in Cloudflare and retry the same
  immutable Agent revision only when the provider outcome is clear.
- If a removal preview is truncated, use the exact model filter in Agent inspection before
  confirming removal.

## Next step

[Create your first Agent](/docs/start/first-agent/) with the enabled model, or review
[owner responsibilities](/docs/security/owner-responsibilities/) before enabling a paid model.
