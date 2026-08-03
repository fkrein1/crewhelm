import {
  OWNER_WRITE_SCOPE,
  recipePublicationToolResultSchema,
  registryArtifactVersionEnvelopeSchema,
  registryPublishBundleSchema,
  type RecipePublicationCandidate,
  type RegistryArtifactVersionEnvelope,
  type SkillPackage,
} from "@crewhelm/contracts";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { skillsCapabilityConfiguration } from "../../agent-capabilities/skills.js";
import { recipeFixture } from "../../../../registry/src/fixtures.test-double.js";
import {
  canonicalPackage,
  projectRecipe,
  projectSkill,
  sha256Hex,
} from "../../../../registry/src/packages.js";
import { agentInput, authorityFor } from "../testkit.js";

const authorizationId = "publish_authorization_00000000-0000-4000-8000-000000000001";
const idempotencyKey = "00000000-0000-4000-8000-000000000002";
const publisher = { displayName: "Octocat", namespace: "octocat" };

function skillPackage(): SkillPackage {
  return {
    description: "Review evidence and state uncertainty before making a recommendation.",
    files: [
      {
        content: "# Evidence review\n\nCompare sources and state uncertainty explicitly.",
        path: "SKILL.md",
      },
    ],
    name: "evidence-review",
    provenance: { kind: "authored" },
  };
}

function envelope(
  kind: "recipe" | "skill",
  namespace: string,
  name: string,
  version: number,
  descriptor: { digest: string; sizeBytes: number },
  publishedAt: string,
): RegistryArtifactVersionEnvelope {
  return registryArtifactVersionEnvelopeSchema.parse({
    contentTrust: "untrusted",
    coordinate: { kind, name, namespace, version },
    kind,
    lifecycle: "published",
    package: descriptor,
    publishedAt,
    publisher,
    review: "unreviewed",
  });
}

function requestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("Expected JSON request body.");
  return JSON.parse(init.body) as unknown;
}

afterEach(() => vi.restoreAllMocks());

describe("OwnerControlPlane Recipe publications", () => {
  it("authorizes, previews every Skill decision, and publishes only the confirmed bundle", async () => {
    let publishedRequest: unknown;
    let authorizationRequest: unknown;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path === "/api/registry/v1/publish/authorizations") {
        authorizationRequest = requestBody(init);
        return Response.json(
          {
            authorizationUrl: `https://crewhelm.app/api/registry/publish/authorizations/${authorizationId}`,
            expiresAt: "2026-08-03T18:00:00.000Z",
            id: authorizationId,
          },
          { status: 201 },
        );
      }
      if (path.endsWith(`/${authorizationId}/resolve`)) {
        return Response.json({
          expiresAt: "2026-08-03T18:00:00.000Z",
          id: authorizationId,
          publisher,
        });
      }
      if (
        path.startsWith("/api/registry/v1/skills/octocat/") ||
        path.startsWith("/api/registry/v1/recipes/octocat/")
      ) {
        return Response.json({ error: "request_denied" }, { status: 404 });
      }
      if (path === "/api/registry/v1/publish") {
        publishedRequest = requestBody(init);
        const bundle = registryPublishBundleSchema.parse(publishedRequest);
        const publishedAt = "2026-08-03T17:00:00.000Z";
        const skillArtifacts = await Promise.all(
          bundle.skills.map(async (skill) => {
            const bytes = canonicalPackage(skill.package);
            const descriptor = { digest: await sha256Hex(bytes), sizeBytes: bytes.byteLength };
            const projection = projectSkill({
              descriptor,
              namespace: bundle.namespace,
              package: skill.package,
              publishedAt,
              publisher,
              version: skill.version,
            });
            return {
              envelope: envelope(
                "skill",
                bundle.namespace,
                skill.package.name,
                skill.version,
                descriptor,
                publishedAt,
              ),
              projection,
            };
          }),
        );
        const recipeBytes = canonicalPackage(bundle.recipe.package);
        const recipeDescriptor = {
          digest: await sha256Hex(recipeBytes),
          sizeBytes: recipeBytes.byteLength,
        };
        const recipe = projectRecipe({
          descriptor: recipeDescriptor,
          namespace: bundle.namespace,
          package: bundle.recipe.package,
          publishedAt,
          publisher,
          version: bundle.recipe.version,
        });
        return Response.json(
          {
            artifacts: [
              ...skillArtifacts.map(({ envelope: skillEnvelope }) => skillEnvelope),
              envelope(
                "recipe",
                bundle.namespace,
                bundle.recipe.package.name,
                bundle.recipe.version,
                recipeDescriptor,
                publishedAt,
              ),
            ],
            recipe,
            semanticIndex: "pending",
          },
          { status: 201 },
        );
      }
      return Response.json({ error: "unavailable" }, { status: 500 });
    });

    const authority = await authorityFor("recipe-publication", [OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const publishedSkill = await stub.publishSkill(authority, {
      idempotencyKey: "publish-local-skill",
      mode: "apply",
      target: { kind: "skill-package", package: skillPackage() },
    });
    if (!publishedSkill.ok || publishedSkill.skill === undefined) {
      throw new Error("Expected local Skill publication.");
    }
    const localAgentInput = agentInput("create-publish-source", "Research brief steward");
    localAgentInput.instructions =
      "Research the supplied topic and produce a concise, source-backed brief.";
    localAgentInput.executionLimits = recipeFixture().agent.executionLimits;
    localAgentInput.capabilities = [
      skillsCapabilityConfiguration([{ id: publishedSkill.skill.id, version: 1 }]),
      ...(localAgentInput.capabilities ?? []),
    ].toSorted((left, right) => left.id.localeCompare(right.id));
    const createdAgent = await stub.createAgent(authority, localAgentInput);
    if (!createdAgent.ok) throw new Error("Expected source Agent creation.");

    const authorization = recipePublicationToolResultSchema.parse(
      await stub.recipePublications(authority, {
        action: "authorize_publish",
        idempotencyKey,
        installationLabel: "Franklin's Crewhelm",
      }),
    );
    expect(authorization).toMatchObject({
      action: "authorize_publish",
      authorization: { id: authorizationId },
      ok: true,
    });
    expect(authorizationRequest).toMatchObject({
      challenge: expect.stringMatching(/^[0-9a-f]{64}$/),
      idempotencyKey,
      installationLabel: "Franklin's Crewhelm",
    });
    expect(JSON.stringify(authorizationRequest)).not.toContain("verifier");

    const recipe = recipeFixture();
    const { skills: _skills, ...recipeDraft } = recipe;
    recipeDraft.agent = {
      capabilities: createdAgent.agent.capabilities.filter(({ id }) => id !== "context.skills"),
      executionLimits: createdAgent.agent.executionLimits,
      instructions: createdAgent.agent.instructions,
      suggestedName: createdAgent.agent.name,
    };
    const candidate: RecipePublicationCandidate = {
      agent: { id: createdAgent.agent.id, revision: createdAgent.agent.revision },
      recipe: recipeDraft,
      skills: [],
    };
    await expect(
      stub.recipePublications(authority, {
        action: "preview_publish",
        authorizationId,
        candidate,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ error: { code: "skill_decisions_incomplete" }, ok: false });

    candidate.skills.push({
      decision: "publish" as const,
      license: "MIT",
      local: { id: publishedSkill.skill.id, version: 1 },
      requirement: "required" as const,
    });
    const preview = recipePublicationToolResultSchema.parse(
      await stub.recipePublications(authority, {
        action: "preview_publish",
        authorizationId,
        candidate,
        idempotencyKey,
      }),
    );
    if (!preview.ok || preview.action !== "preview_publish") {
      throw new Error(`Expected Recipe publication preview: ${JSON.stringify(preview)}`);
    }
    expect(preview.plan).toMatchObject({
      exclusions: [
        "briefs",
        "connection_credentials",
        "grants",
        "history",
        "owner_local_ids",
        "runtime_telemetry",
      ],
      recipe: { version: 1 },
      skills: [
        {
          decision: "publish",
          name: "evidence-review",
          provenance: { kind: "authored" },
          version: 1,
          warnings: {
            activeMarkdown: 0,
            executableContent: 0,
            hiddenText: 0,
            obfuscatedContent: 0,
            suspectedPrivateIdentifiers: 0,
            suspectedSecrets: 0,
          },
        },
      ],
    });

    const removedCandidate: RecipePublicationCandidate = {
      ...candidate,
      skills: [
        {
          decision: "remove",
          local: { id: publishedSkill.skill.id, version: 1 },
        },
      ],
    };
    const removedPreview = recipePublicationToolResultSchema.parse(
      await stub.recipePublications(authority, {
        action: "preview_publish",
        authorizationId,
        candidate: removedCandidate,
        idempotencyKey,
      }),
    );
    expect(removedPreview).toMatchObject({
      action: "preview_publish",
      ok: true,
      plan: {
        blockingReasons: ["skill_removal_rehearsal_required"],
        ready: false,
      },
    });
    if (!removedPreview.ok || removedPreview.action !== "preview_publish") {
      throw new Error("Expected blocked Skill-removal preview.");
    }
    await expect(
      stub.recipePublications(authority, {
        action: "publish",
        authorizationId,
        candidate: removedCandidate,
        expectedConfirmationDigest: removedPreview.plan.confirmationDigest,
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ error: { code: "rehearsal_required" }, ok: false });

    await expect(
      stub.recipePublications(authority, {
        action: "publish",
        authorizationId,
        candidate,
        expectedConfirmationDigest: "0".repeat(64),
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ error: { code: "stale_preview" }, ok: false });
    expect(publishedRequest).toBeUndefined();

    const result = recipePublicationToolResultSchema.parse(
      await stub.recipePublications(authority, {
        action: "publish",
        authorizationId,
        candidate,
        expectedConfirmationDigest: preview.plan.confirmationDigest,
        idempotencyKey,
      }),
    );
    expect(result).toMatchObject({
      action: "publish",
      ok: true,
      publication: { recipe: { artifact: { namespace: "octocat", version: 1 } } },
    });
    expect(publishedRequest).toMatchObject({
      idempotencyKey,
      namespace: "octocat",
      recipe: { package: { skills: [{ name: "evidence-review" }] }, version: 1 },
      skills: [{ package: { license: "MIT", name: "evidence-review" }, version: 1 }],
    });
    expect(JSON.stringify(publishedRequest)).not.toContain(createdAgent.agent.id);
    expect(JSON.stringify(publishedRequest)).not.toContain(publishedSkill.skill.id);
  });
});
