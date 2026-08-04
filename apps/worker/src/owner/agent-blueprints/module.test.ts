import {
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  getAgentBlueprintResultSchema,
  instantiateAgentBlueprintResultSchema,
  listAgentBlueprintsResultSchema,
  publishAgentBlueprintResultSchema,
  retireAgentBlueprintResultSchema,
  type AgentBlueprintPackage,
} from "@crewhelm/contracts";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { authorityFor } from "../testkit.js";

function packageInput(name = "research-helper"): AgentBlueprintPackage {
  return {
    agent: {
      capabilities: [
        {
          configuration: {
            fallbackModels: [],
            primaryModel: "@cf/openai/gpt-oss-120b",
          },
          id: "inference.workers-ai",
          schemaVersion: 2,
        },
      ],
      executionLimits: {
        maxDurationSeconds: 120,
        maxModelTokens: 8_000,
        maxToolCalls: 4,
        maxTurns: 6,
      },
      instructions: "Help {{audience}}. Detailed: {{detailed}}. Depth: {{depth}}.",
      name: "{{audience}} helper",
    },
    description: "A configurable research helper.",
    name,
    parameters: [
      { description: "Audience name.", name: "audience", type: "string" as const },
      {
        default: true,
        description: "Whether to include detail.",
        name: "detailed",
        type: "boolean" as const,
      },
      {
        default: 2,
        description: "Research depth.",
        maximum: 5,
        minimum: 1,
        name: "depth",
        type: "integer" as const,
      },
    ],
    provenance: { kind: "authored" as const },
    publisher: { name: "Crewhelm" },
    schemaVersion: 1 as const,
    tags: ["research", "starter"],
  };
}

describe("OwnerControlPlane Agent blueprints", () => {
  it("publishes immutable versions and provides compact discovery", async () => {
    const authority = await authorityFor("blueprint-library", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const preview = publishAgentBlueprintResultSchema.parse(
      await stub.publishAgentBlueprint(authority, {
        mode: "preview",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    );

    expect(preview).toMatchObject({ applied: false, ok: true, version: 1 });

    const published = publishAgentBlueprintResultSchema.parse(
      await stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-1",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    );

    expect(published).toMatchObject({
      applied: true,
      blueprint: { currentVersion: 1, name: "research-helper", status: "active" },
      ok: true,
      version: 1,
    });
    if (!published.ok || published.blueprint === undefined) {
      throw new Error("Expected Agent blueprint publication.");
    }

    await expect(
      stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-1",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    ).resolves.toMatchObject({ applied: false, ok: true, version: 1 });
    await expect(
      stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-1",
        mode: "apply",
        target: {
          kind: "agent-blueprint-package",
          package: packageInput("different-blueprint"),
        },
      }),
    ).resolves.toEqual({
      error: {
        code: "idempotency_conflict",
        message: "Agent blueprint request denied.",
      },
      ok: false,
    });

    const catalog = listAgentBlueprintsResultSchema.parse(
      await stub.listAgentBlueprints(authority, {
        target: {
          kind: "agent-blueprint-catalog",
          limit: 25,
          tag: "research",
        },
      }),
    );
    expect(catalog).toMatchObject({
      blueprints: [{ id: published.blueprint.id, versionCount: 1 }],
      nextCursor: null,
      ok: true,
    });

    const exact = getAgentBlueprintResultSchema.parse(
      await stub.getAgentBlueprint(authority, {
        target: {
          id: published.blueprint.id,
          kind: "agent-blueprint-package",
          version: 1,
        },
      }),
    );
    expect(exact).toMatchObject({
      ok: true,
      version: {
        contentTrust: "untrusted",
        metadataTrust: "unverified",
        package: { publisher: { name: "Crewhelm" } },
      },
    });
  }, 30_000);

  it("previews exact implications and creates a provenance-linked Agent without grants", async () => {
    const authority = await authorityFor("blueprint-instance", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const published = publishAgentBlueprintResultSchema.parse(
      await stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-instance",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    );

    if (!published.ok || published.blueprint === undefined) {
      throw new Error("Expected Agent blueprint publication.");
    }

    const target = {
      id: published.blueprint.id,
      kind: "agent-blueprint-instance" as const,
      parameters: { audience: "Analyst", depth: 4, detailed: false },
      version: 1,
    };
    const preview = instantiateAgentBlueprintResultSchema.parse(
      await stub.instantiateAgentBlueprint(authority, { mode: "preview", target }),
    );

    expect(preview).toMatchObject({
      created: false,
      ok: true,
      preview: {
        agent: {
          instructions: "Help Analyst. Detailed: false. Depth: 4.",
          name: "Analyst helper",
        },
        authority: { createsGrants: false, requestedGrants: [] },
        budget: {
          maxDurationSeconds: 120,
          maxModelTokens: 8_000,
          maxToolCalls: 4,
          maxTurns: 6,
          pricing: "provider-metered",
        },
        ready: true,
      },
    });

    const created = instantiateAgentBlueprintResultSchema.parse(
      await stub.instantiateAgentBlueprint(authority, {
        idempotencyKey: "instantiate-blueprint-1",
        mode: "apply",
        target,
      }),
    );

    expect(created).toMatchObject({
      agent: {
        blueprint: {
          digest: published.package.digest,
          id: published.blueprint.id,
          parameterDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          version: 1,
        },
        capabilityGrants: [],
        instructions: "Help Analyst. Detailed: false. Depth: 4.",
      },
      created: true,
      ok: true,
    });
    await expect(
      stub.instantiateAgentBlueprint(authority, {
        idempotencyKey: "instantiate-blueprint-1",
        mode: "apply",
        target,
      }),
    ).resolves.toMatchObject({ created: false, ok: true });
  }, 30_000);

  it("returns typed failures for invalid, unavailable, conflicting, and retired requests", async () => {
    const authority = await authorityFor("blueprint-failures", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const missingBlueprintId = "blueprint_00000000-0000-4000-8000-000000000001";

    await expect(stub.getAgentBlueprint(authority, {})).resolves.toMatchObject({
      error: { code: "invalid_request" },
      ok: false,
    });
    await expect(
      stub.instantiateAgentBlueprint(authority, {
        mode: "preview",
        target: {
          id: missingBlueprintId,
          kind: "agent-blueprint-instance",
          parameters: {},
          version: 1,
        },
      }),
    ).resolves.toMatchObject({ error: { code: "blueprint_not_found" }, ok: false });

    const published = publishAgentBlueprintResultSchema.parse(
      await stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-failures",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    );

    if (!published.ok || published.blueprint === undefined) {
      throw new Error("Expected Agent blueprint publication.");
    }

    await expect(
      stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-no-changes",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.blueprint.id,
          kind: "agent-blueprint-package",
          package: packageInput(),
        },
      }),
    ).resolves.toMatchObject({ error: { code: "no_changes" }, ok: false });
    await expect(
      stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-name-conflict",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: packageInput() },
      }),
    ).resolves.toMatchObject({ error: { code: "name_conflict" }, ok: false });
    await expect(
      stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-version-conflict",
        mode: "apply",
        target: {
          expectedVersion: 2,
          id: published.blueprint.id,
          kind: "agent-blueprint-package",
          package: packageInput("renamed-helper"),
        },
      }),
    ).resolves.toMatchObject({ error: { code: "version_conflict" }, ok: false });

    await expect(
      stub.retireAgentBlueprint(authority, {
        idempotencyKey: "retire-blueprint-failures",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.blueprint.id,
          kind: "agent-blueprint-retirement",
        },
      }),
    ).resolves.toMatchObject({ applied: true, ok: true });
    await expect(
      stub.instantiateAgentBlueprint(authority, {
        idempotencyKey: "instantiate-retired-blueprint",
        mode: "apply",
        target: {
          id: published.blueprint.id,
          kind: "agent-blueprint-instance",
          parameters: { audience: "Operator" },
          version: 1,
        },
      }),
    ).resolves.toMatchObject({ error: { code: "blueprint_retired" }, ok: false });
  });

  it("shows missing exact Skill prerequisites and retains old versions after retirement", async () => {
    const authority = await authorityFor("blueprint-prerequisites", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const withMissingSkill = packageInput("skill-helper");
    withMissingSkill.agent.capabilities = [
      {
        configuration: {
          skills: [
            {
              id: "skill_00000000-0000-4000-8000-000000000001",
              version: 1,
            },
          ],
        },
        id: "context.skills",
        schemaVersion: 1,
      },
      ...withMissingSkill.agent.capabilities,
    ];
    const published = publishAgentBlueprintResultSchema.parse(
      await stub.publishAgentBlueprint(authority, {
        idempotencyKey: "publish-blueprint-prerequisite",
        mode: "apply",
        target: { kind: "agent-blueprint-package", package: withMissingSkill },
      }),
    );

    if (!published.ok || published.blueprint === undefined) {
      throw new Error("Expected Agent blueprint publication.");
    }

    const target = {
      id: published.blueprint.id,
      kind: "agent-blueprint-instance" as const,
      parameters: { audience: "Operator" },
    };
    const preview = instantiateAgentBlueprintResultSchema.parse(
      await stub.instantiateAgentBlueprint(authority, { mode: "preview", target }),
    );
    expect(preview).toMatchObject({ ok: true, preview: { ready: false } });
    if (!preview.ok) {
      throw new Error("Expected Agent blueprint preview.");
    }
    expect(preview.preview.prerequisites).toContainEqual({
      description: "Exact active Skill version required by this Agent blueprint.",
      id: "skill_00000000-0000-4000-8000-000000000001:1",
      kind: "skill",
      state: "missing",
    });
    await expect(
      stub.instantiateAgentBlueprint(authority, {
        idempotencyKey: "instantiate-missing-skill",
        mode: "apply",
        target,
      }),
    ).resolves.toEqual({
      error: {
        code: "prerequisite_unavailable",
        message: "Agent blueprint request denied.",
      },
      ok: false,
    });

    const retired = retireAgentBlueprintResultSchema.parse(
      await stub.retireAgentBlueprint(authority, {
        idempotencyKey: "retire-blueprint-1",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.blueprint.id,
          kind: "agent-blueprint-retirement",
        },
      }),
    );
    expect(retired).toMatchObject({
      applied: true,
      blueprint: { status: "retired" },
      ok: true,
    });
    await expect(
      stub.getAgentBlueprint(authority, {
        target: {
          id: published.blueprint.id,
          kind: "agent-blueprint-package",
          version: 1,
        },
      }),
    ).resolves.toMatchObject({ ok: true, version: { version: 1 } });
  });
});
