import {
  AUTONOMY_WRITE_SCOPE,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  crewhelmStarterModelCatalog,
} from "@crewhelm/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { workersAiCapabilityConfiguration } from "../../agent-capabilities/workers-ai.js";
import { authorityFor, fixedAgentFailure } from "../testkit.js";

const KIMI_K3 = "moonshotai/kimi-k3";

describe("OwnerControlPlane model catalog", () => {
  it("starts small and revision-checks one-model changes", async () => {
    const authority = await authorityFor("model-catalog-1", [
      OWNER_READ_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const initial = await stub.getModelCatalog(authority, { target: { kind: "model-catalog" } });

    expect(initial).toMatchObject({
      catalog: { data: crewhelmStarterModelCatalog, revision: 1 },
      ok: true,
    });
    if (!initial.ok) throw new Error("Expected the starter model catalog.");

    const preview = await stub.configureModelCatalog(authority, {
      change: { kind: "add", modelId: KIMI_K3 },
      expectedRevision: initial.catalog.revision,
      mode: "preview",
      target: { kind: "model-catalog" },
    });
    expect(preview).toMatchObject({
      applied: false,
      catalog: { data: { enabledModels: expect.arrayContaining([KIMI_K3]) }, revision: 2 },
      ok: true,
    });

    const applied = await stub.configureModelCatalog(authority, {
      change: { kind: "add", modelId: KIMI_K3 },
      expectedRevision: initial.catalog.revision,
      idempotencyKey: "add-kimi-k3",
      mode: "apply",
      target: { kind: "model-catalog" },
    });
    expect(applied).toMatchObject({ applied: true, catalog: { revision: 2 }, ok: true });
    await expect(
      stub.configureModelCatalog(authority, {
        change: { kind: "add", modelId: "moonshotai/a-different-model" },
        expectedRevision: initial.catalog.revision,
        idempotencyKey: "add-kimi-k3",
        mode: "apply",
        target: { kind: "model-catalog" },
      }),
    ).resolves.toMatchObject({ error: { code: "idempotency_conflict" }, ok: false });
  });

  it("allows an enabled new ID, previews affected Agents, then blocks new admission after removal", async () => {
    const authority = await authorityFor("model-catalog-2", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
      AUTONOMY_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const added = await stub.configureModelCatalog(authority, {
      change: { kind: "add", modelId: KIMI_K3 },
      expectedRevision: 1,
      idempotencyKey: "enable-kimi-k3",
      mode: "apply",
      target: { kind: "model-catalog" },
    });
    expect(added).toMatchObject({ applied: true, ok: true });

    const created = await stub.createAgent(authority, {
      capabilities: [workersAiCapabilityConfiguration(KIMI_K3)],
      idempotencyKey: "create-kimi-k3-agent",
      instructions: "Use tools to test the newly available model.",
      name: "Kimi K3 tester",
    });
    expect(created).toMatchObject({ agent: { model: KIMI_K3 }, created: true, ok: true });

    const fallbackCreated = await stub.createAgent(authority, {
      capabilities: [
        workersAiCapabilityConfiguration(crewhelmStarterModelCatalog.defaultModel, {
          fallbackModels: [KIMI_K3],
        }),
      ],
      idempotencyKey: "create-kimi-k3-fallback-agent",
      instructions: "Use the new model only if the starter model fails before producing output.",
      name: "Kimi K3 fallback tester",
    });
    expect(fallbackCreated).toMatchObject({
      agent: { model: crewhelmStarterModelCatalog.defaultModel },
      created: true,
      ok: true,
    });

    const preview = await stub.configureModelCatalog(authority, {
      change: { kind: "remove", modelId: KIMI_K3 },
      expectedRevision: 2,
      mode: "preview",
      target: { kind: "model-catalog" },
    });
    expect(preview).toMatchObject({
      applied: false,
      impact: {
        affectedAgents: expect.arrayContaining([
          expect.objectContaining({ model: KIMI_K3, name: "Kimi K3 tester", revision: 1 }),
          expect.objectContaining({
            model: crewhelmStarterModelCatalog.defaultModel,
            name: "Kimi K3 fallback tester",
            revision: 1,
          }),
        ]),
        affectedAgentsTotal: 2,
        truncated: false,
      },
      ok: true,
    });

    await expect(
      stub.configureModelCatalog(authority, {
        change: { kind: "remove", modelId: KIMI_K3 },
        expectedRevision: 2,
        idempotencyKey: "disable-kimi-k3",
        mode: "apply",
        target: { kind: "model-catalog" },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });

    await expect(
      stub.createAgent(authority, {
        capabilities: [workersAiCapabilityConfiguration(KIMI_K3)],
        idempotencyKey: "create-disabled-kimi-k3-agent",
        instructions: "This exact disabled model should be rejected.",
        name: "Disabled Kimi K3 tester",
      }),
    ).resolves.toEqual(fixedAgentFailure("model_disabled"));
  });
});
