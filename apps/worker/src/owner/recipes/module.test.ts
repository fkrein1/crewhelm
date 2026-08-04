import {
  AGENTS_READ_SCOPE,
  MAXIMUM_BRIEF_CONTENT_BYTES,
  MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS,
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  registryArtifactVersionEnvelopeSchema,
  recipeToolResultSchema,
  type RecipePackage,
  type RegistryArtifactVersionEnvelope,
  type RegistrySkillPackage,
} from "@crewhelm/contracts";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { recipeFixture, skillFixture } from "../../../../registry/src/fixtures.test-double.js";
import { projectRecipe, projectSkill } from "../../../../registry/src/packages.js";
import { authorityFor } from "../testkit.js";

const origin = "https://crewhelm.app/";
const publishedAt = "2026-08-02T12:00:00.000Z";
const publisher = { displayName: "Octocat", namespace: "octocat" };

function encodeHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encodedPackage(value: unknown) {
  const source = JSON.stringify(value);
  const bytes = new TextEncoder().encode(source);
  const digest = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return { bytes, descriptor: { digest, sizeBytes: bytes.byteLength }, source };
}

async function registryFixture(transformRecipe?: (recipe: RecipePackage) => RecipePackage) {
  const skill: RegistrySkillPackage = skillFixture();
  const encodedSkill = await encodedPackage(skill);
  const baseRecipe: RecipePackage = {
    ...recipeFixture(),
    agent: {
      ...recipeFixture().agent,
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
    },
    skills: [
      {
        digest: encodedSkill.descriptor.digest,
        name: skill.name,
        namespace: publisher.namespace,
        registry: origin,
        requirement: "required",
        version: 1,
      },
    ],
  };
  const recipe = transformRecipe?.(baseRecipe) ?? baseRecipe;
  const encodedRecipe = await encodedPackage(recipe);
  const recipeProjection = projectRecipe({
    descriptor: encodedRecipe.descriptor,
    namespace: publisher.namespace,
    package: recipe,
    publishedAt,
    publisher,
    version: 1,
  });
  const skillProjection = projectSkill({
    descriptor: encodedSkill.descriptor,
    namespace: publisher.namespace,
    package: skill,
    publishedAt,
    publisher,
    version: 1,
  });
  const envelope = (
    kind: "recipe" | "skill",
    name: string,
    descriptor: { digest: string; sizeBytes: number },
  ): RegistryArtifactVersionEnvelope =>
    registryArtifactVersionEnvelopeSchema.parse({
      contentTrust: "untrusted",
      coordinate: { kind, name, namespace: publisher.namespace, version: 1 },
      kind,
      lifecycle: "published",
      package: descriptor,
      publishedAt,
      publisher,
      review: "unreviewed",
    });

  const recipeEnvelope = envelope("recipe", recipe.name, encodedRecipe.descriptor);
  const skillEnvelope = envelope("skill", skill.name, encodedSkill.descriptor);
  return {
    encodedRecipe,
    encodedSkill,
    recipe,
    recipeEnvelope,
    recipeProjection,
    skill,
    skillEnvelope,
    skillProjection,
    target: {
      digest: encodedRecipe.descriptor.digest,
      kind: "recipe" as const,
      name: recipe.name,
      namespace: publisher.namespace,
      registry: origin,
      version: 1,
    },
    responses: new Map<string, () => Response>([
      [
        `/api/registry/v1/artifacts/recipe/${publisher.namespace}/${recipe.name}/1`,
        () =>
          Response.json({
            envelope: recipeEnvelope,
            projection: recipeProjection,
          }),
      ],
      [
        `/api/registry/v1/artifacts/recipe/${publisher.namespace}/${recipe.name}/1/package`,
        () =>
          new Response(encodedRecipe.source, {
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      ],
      [
        `/api/registry/v1/artifacts/skill/${publisher.namespace}/${skill.name}/1`,
        () =>
          Response.json({
            envelope: skillEnvelope,
            projection: skillProjection,
          }),
      ],
      [
        `/api/registry/v1/artifacts/skill/${publisher.namespace}/${skill.name}/1/package`,
        () =>
          new Response(encodedSkill.source, {
            headers: { "content-type": "application/json; charset=utf-8" },
          }),
      ],
    ]),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OwnerControlPlane Recipes", () => {
  it("previews exact consequences and installs a disabled Agent with a pinned local Skill", async () => {
    const fixture = await registryFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = fixture.responses.get(
        new URL(String(input instanceof Request ? input.url : input)).pathname,
      );
      return response?.() ?? new Response(null, { status: 404 });
    });
    const authority = await authorityFor("recipe-install", [
      AGENTS_READ_SCOPE,
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const request = {
      connectionBindings: [],
      operations: { eventTriggers: [], schedules: [] },
      optionalSkills: [],
      parameters: {},
      target: fixture.target,
    };
    const preview = recipeToolResultSchema.parse(
      await stub.recipes(authority, { action: "preview", request }),
    );
    if (!preview.ok) throw new Error("Expected Recipe preview.");
    expect(preview).toMatchObject({
      action: "preview",
      ok: true,
      plan: {
        authority: { createsConnections: false, createsGrants: false, startsWork: false },
        ready: true,
        skills: [{ name: fixture.skill.name, requirement: "required", selected: true }],
      },
    });
    if (!preview.ok || preview.action !== "preview") throw new Error("Expected Recipe preview.");

    const installed = recipeToolResultSchema.parse(
      await stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "install-research-recipe",
        request,
      }),
    );
    expect(installed).toMatchObject({
      action: "install",
      installationEvidence: "created",
      ok: true,
      receipt: {
        status: "installed",
        skills: [{ sourceDigest: fixture.encodedSkill.descriptor.digest }],
      },
    });
    if (!installed.ok || installed.action !== "install" || installed.receipt.agent === null) {
      throw new Error("Expected Recipe installation.");
    }
    const installedAgent = await stub.getAgent(authority, { id: installed.receipt.agent.id });
    expect(installedAgent).toMatchObject({
      agent: {
        capabilityGrants: [],
        status: "disabled",
      },
      ok: true,
    });
    if (!installedAgent.ok) throw new Error("Expected installed Agent.");
    expect(installedAgent.agent.capabilities.map(({ id }) => id)).toContain("context.skills");

    await expect(
      stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "install-research-recipe",
        request,
      }),
    ).resolves.toEqual({ ...installed, installationEvidence: "replayed" });
  });

  it("binds exact owner-local Briefs to selected recurring Recipe operations", async () => {
    const fixture = await registryFixture((recipe) => ({
      ...recipe,
      inputs: [
        ...recipe.inputs,
        {
          description: "The owner's exact weekly priorities.",
          kind: "brief" as const,
          name: "weekly-priorities",
          required: true,
        },
        {
          description: "The first large context source.",
          kind: "brief" as const,
          name: "large-context-a",
          required: true,
        },
        {
          description: "The second large context source.",
          kind: "brief" as const,
          name: "large-context-b",
          required: true,
        },
      ].toSorted((left, right) => left.name.localeCompare(right.name)),
      operations: {
        ...recipe.operations,
        schedules: [
          {
            briefInputNames: ["weekly-priorities"],
            instruction: "Prepare the weekly review using the owner's priorities.",
            name: "weekly-review",
            outputContract: { kind: "markdown" as const },
            trigger: { intervalSeconds: 604_800, type: "interval" as const },
          },
          {
            briefInputNames: ["large-context-a", "large-context-b"],
            instruction: "Prepare a review from both large context sources.",
            name: "oversized-review",
            outputContract: { kind: "markdown" as const },
            trigger: { intervalSeconds: 604_800, type: "interval" as const },
          },
        ].toSorted((left, right) => left.name.localeCompare(right.name)),
      },
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = fixture.responses.get(
        new URL(String(input instanceof Request ? input.url : input)).pathname,
      );
      return response?.() ?? new Response(null, { status: 404 });
    });
    const authority = await authorityFor("recipe-brief-binding", [
      AGENTS_READ_SCOPE,
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const brief = await stub.createBrief(authority, {
      content: "Ship the onboarding improvement and protect reliability work.",
      idempotencyKey: "recipe-weekly-priorities",
      mediaType: "text/plain",
      name: "Weekly priorities",
    });
    if (!brief.ok) throw new Error("Expected Recipe Brief fixture.");
    const request = {
      connectionBindings: [],
      operations: { eventTriggers: [], schedules: ["weekly-review"] },
      optionalSkills: [],
      parameters: {},
      target: fixture.target,
    };
    await expect(stub.recipes(authority, { action: "preview", request })).resolves.toMatchObject({
      action: "preview",
      ok: true,
      plan: {
        briefs: [
          {
            bound: null,
            inputName: "weekly-priorities",
            required: true,
            state: "missing",
          },
        ],
        ready: false,
      },
    });

    const boundRequest = {
      ...request,
      briefBindings: [
        {
          brief: { id: brief.brief.id, revision: brief.version.revision },
          inputName: "weekly-priorities",
        },
      ],
    };
    const preview = recipeToolResultSchema.parse(
      await stub.recipes(authority, { action: "preview", request: boundRequest }),
    );
    expect(preview).toMatchObject({
      action: "preview",
      ok: true,
      plan: {
        briefs: [
          {
            bound: { id: brief.brief.id, revision: brief.version.revision },
            inputName: "weekly-priorities",
            state: "available",
          },
        ],
        ready: true,
      },
    });
    if (!preview.ok || preview.action !== "preview") throw new Error("Expected bound preview.");
    await expect(
      stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "install-recipe-with-brief",
        request: boundRequest,
      }),
    ).resolves.toMatchObject({
      action: "install",
      ok: true,
      receipt: {
        briefs: [
          {
            brief: { id: brief.brief.id, revision: brief.version.revision },
            inputName: "weekly-priorities",
          },
        ],
      },
    });

    const largeBriefA = await stub.createBrief(authority, {
      content: "a".repeat(MAXIMUM_BRIEF_CONTENT_BYTES),
      idempotencyKey: "recipe-large-context-a",
      mediaType: "text/plain",
      name: "Large context A",
    });
    const largeBriefB = await stub.createBrief(authority, {
      content: "b".repeat(MAXIMUM_BRIEF_CONTENT_BYTES),
      idempotencyKey: "recipe-large-context-b",
      mediaType: "text/plain",
      name: "Large context B",
    });
    if (!largeBriefA.ok || !largeBriefB.ok) throw new Error("Expected large Brief fixtures.");
    await expect(
      stub.recipes(authority, {
        action: "preview",
        request: {
          connectionBindings: [],
          briefBindings: [
            {
              brief: { id: largeBriefA.brief.id, revision: largeBriefA.version.revision },
              inputName: "large-context-a",
            },
            {
              brief: { id: largeBriefB.brief.id, revision: largeBriefB.version.revision },
              inputName: "large-context-b",
            },
          ],
          operations: { eventTriggers: [], schedules: ["oversized-review"] },
          optionalSkills: [],
          parameters: {},
          target: fixture.target,
        },
      }),
    ).resolves.toMatchObject({
      action: "preview",
      ok: true,
      plan: {
        briefs: [
          { inputName: "large-context-a", state: "combination_unavailable" },
          { inputName: "large-context-b", state: "combination_unavailable" },
        ],
        ready: false,
      },
    });
  });

  it("denies stale confirmation and hostile Registry responses before creating local state", async () => {
    const fixture = await registryFixture();
    const artifactPath = `/api/registry/v1/artifacts/recipe/${publisher.namespace}/${fixture.recipe.name}/1`;
    const packagePath = `/api/registry/v1/artifacts/recipe/${publisher.namespace}/${fixture.recipe.name}/1/package`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === artifactPath) {
        return Response.json({
          envelope: fixture.recipeEnvelope,
          projection: { ...fixture.recipeProjection, title: "Misleading preview" },
        });
      }
      return fixture.responses.get(path)?.() ?? new Response(null, { status: 404 });
    });
    const authority = await authorityFor("recipe-hostile", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const request = {
      connectionBindings: [],
      operations: { eventTriggers: [], schedules: [] },
      optionalSkills: [],
      parameters: {},
      target: fixture.target,
    };
    await expect(stub.recipes(authority, { action: "preview", request })).resolves.toEqual({
      error: { code: "registry_unavailable", message: "Recipe request denied." },
      ok: false,
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === packagePath) {
        return new Response(`${fixture.encodedRecipe.source} `, {
          headers: { "content-type": "application/json" },
        });
      }
      return fixture.responses.get(path)?.() ?? new Response(null, { status: 404 });
    });
    await expect(stub.recipes(authority, { action: "preview", request })).resolves.toEqual({
      error: { code: "registry_unavailable", message: "Recipe request denied." },
      ok: false,
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = fixture.responses.get(
        new URL(String(input instanceof Request ? input.url : input)).pathname,
      );
      return response?.() ?? new Response(null, { status: 404 });
    });
    await expect(
      stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: "0".repeat(64),
        idempotencyKey: "stale-recipe-preview",
        request,
      }),
    ).resolves.toEqual({
      error: { code: "stale_preview", message: "Recipe request denied." },
      ok: false,
    });
    await expect(stub.listAgents(authority, { limit: 25 })).resolves.toMatchObject({
      agents: [],
      ok: true,
    });
  });

  it("reconciles retained child writes before cross-client recovery", async () => {
    const fixture = await registryFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = fixture.responses.get(
        new URL(String(input instanceof Request ? input.url : input)).pathname,
      );
      return response?.() ?? new Response(null, { status: 404 });
    });
    const authority = await authorityFor("recipe-recovery", [
      AGENTS_READ_SCOPE,
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const request = {
      connectionBindings: [],
      operations: { eventTriggers: [], schedules: [] },
      optionalSkills: [],
      parameters: {},
      target: fixture.target,
    };
    const preview = recipeToolResultSchema.parse(
      await stub.recipes(authority, { action: "preview", request }),
    );
    if (!preview.ok || preview.action !== "preview") throw new Error("Expected Recipe preview.");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_recipe_final_receipt
        BEFORE UPDATE ON recipe_installations
        WHEN json_extract(NEW.receipt, '$.status') = 'installed'
        BEGIN
          SELECT RAISE(ABORT, 'forced Recipe final receipt failure');
        END
      `);
    });
    const interrupted = recipeToolResultSchema.parse(
      await stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "recover-research-recipe",
        request,
      }),
    );
    expect(interrupted).toMatchObject({
      error: {
        code: "installation_incomplete",
        recovery: { retry: "recover" },
      },
      ok: false,
    });
    if (interrupted.ok || interrupted.error.recovery === undefined) {
      throw new Error("Expected recoverable Recipe interruption.");
    }
    const recoveryInstallationId = interrupted.error.recovery.installationId;
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT skill_id FROM skills").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT agent_id FROM agents").toArray()).toHaveLength(1);
      state.storage.sql.exec("DROP TRIGGER reject_recipe_final_receipt");
      state.storage.sql.exec("UPDATE recipe_installations SET plan_digest = ?", "0".repeat(64));
    });

    const recoveryAuthority = await authorityFor(
      "recipe-recovery",
      [AGENTS_READ_SCOPE, OWNER_READ_SCOPE, OWNER_WRITE_SCOPE],
      "https://recovery-client.example/mcp.json",
    );
    await expect(
      stub.recipes(recoveryAuthority, {
        action: "recover",
        installationId: recoveryInstallationId,
      }),
    ).resolves.toMatchObject({ error: { code: "installation_incomplete" }, ok: false });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE recipe_installations SET plan_digest = json_extract(receipt, '$.planDigest')",
      );
      expect(state.storage.sql.exec("SELECT agent_id FROM agents").toArray()).toHaveLength(1);
      state.storage.sql.exec(
        `UPDATE recipe_installations
         SET receipt = json_set(
           receipt,
           '$.agent.id',
           'agent_00000000-0000-4000-8000-000000000099'
         )`,
      );
    });
    await expect(
      stub.recipes(recoveryAuthority, {
        action: "recover",
        installationId: recoveryInstallationId,
      }),
    ).resolves.toMatchObject({ error: { code: "installation_incomplete" }, ok: false });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE recipe_installations
         SET receipt = json_set(
           receipt,
           '$.agent.id',
           (SELECT agent_id FROM agent_creations WHERE idempotency_key = ?)
         )`,
        `${recoveryInstallationId}.agent`,
      );
    });
    const recovered = recipeToolResultSchema.parse(
      await stub.recipes(recoveryAuthority, {
        action: "recover",
        installationId: recoveryInstallationId,
      }),
    );
    expect(recovered).toMatchObject({
      action: "recover",
      ok: true,
      receipt: { status: "installed" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT skill_id FROM skills").toArray()).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT agent_id FROM agents").toArray()).toHaveLength(1);
    });
  });

  it("bounds unfinished installation state without blocking an exact replay", async () => {
    const fixture = await registryFixture();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const response = fixture.responses.get(
        new URL(String(input instanceof Request ? input.url : input)).pathname,
      );
      return response?.() ?? new Response(null, { status: 404 });
    });
    const authority = await authorityFor("recipe-incomplete-limit", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const request = {
      connectionBindings: [],
      operations: { eventTriggers: [], schedules: [] },
      optionalSkills: [],
      parameters: {},
      target: fixture.target,
    };
    const preview = recipeToolResultSchema.parse(
      await stub.recipes(authority, { action: "preview", request }),
    );
    if (!preview.ok || preview.action !== "preview") throw new Error("Expected Recipe preview.");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_recipe_agents
        BEFORE INSERT ON agents
        BEGIN
          SELECT RAISE(ABORT, 'forced unfinished Recipe installation');
        END
      `);
    });

    let firstIncomplete: unknown;
    for (let index = 0; index < MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS; index += 1) {
      const result = await stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: `bounded-recipe-${index}`,
        request,
      });
      if (index === 0) firstIncomplete = result;
      expect(result).toMatchObject({
        error: { code: "installation_incomplete" },
        ok: false,
      });
    }
    await expect(
      stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "bounded-recipe-overflow",
        request,
      }),
    ).resolves.toEqual({
      error: { code: "installation_limit_exceeded", message: "Recipe request denied." },
      ok: false,
    });
    await expect(
      stub.recipes(authority, {
        action: "install",
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey: "bounded-recipe-0",
        request,
      }),
    ).resolves.toEqual(firstIncomplete);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT installation_id FROM recipe_installations").toArray(),
      ).toHaveLength(MAXIMUM_INCOMPLETE_RECIPE_INSTALLATIONS);
    });
  });
});
