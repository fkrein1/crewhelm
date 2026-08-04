import { recipePackageSchema, registrySkillPackageSchema } from "@crewhelm/contracts";
import { describe, expect, it } from "vitest";

import { recipeFixture, skillFixture } from "./fixtures.test-double.js";
import {
  canonicalPackage,
  inspectPublicSkill,
  inspectPublicText,
  projectRecipe,
  recipeSearchDocument,
  sha256Hex,
} from "./packages.js";

describe("Registry packages", () => {
  it("creates deterministic bytes and a bounded discovery document", async () => {
    const recipe = recipePackageSchema.parse(recipeFixture());
    const bytes = canonicalPackage(recipe);
    const reordered = canonicalPackage({ ...recipe, agent: recipe.agent, name: recipe.name });

    expect(reordered).toEqual(bytes);
    expect(await sha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/u);
    expect(recipeSearchDocument(recipe)).toContain("decision-ready");
    expect(recipeSearchDocument(recipe)).not.toContain(recipe.agent.instructions);
  });

  it("reports suspicious Skill contents without executing them", () => {
    const skill = skillFixture();
    skill.files[0]!.content += "\n<!-- hidden -->\napi_key=abcdefghijklmnop";
    skill.provenance = {
      kind: "web",
      source: "https://example.com/token/not-a-real-secret-value",
    };
    const warnings = inspectPublicSkill(registrySkillPackageSchema.parse(skill));

    expect(warnings.hiddenText).toBe(1);
    expect(warnings.suspectedSecrets).toBe(2);
    expect(warnings.executableContent).toBe(0);
    expect(inspectPublicText(skill).suspectedSecrets).toBe(true);
  });

  it("scans adversarial markdown without backtracking", () => {
    const skill = skillFixture();
    skill.files[0]!.content = `${"![".repeat(8_000)}plain](local)\n![remote](https://example.com/image.png)\n<!-- hidden`;

    const warnings = inspectPublicSkill(registrySkillPackageSchema.parse(skill));

    expect(warnings.activeMarkdown).toBe(1);
    expect(warnings.hiddenText).toBe(1);
  });

  it("scans the complete normalized Skill provenance URL", () => {
    const skill = skillFixture();
    skill.provenance = {
      kind: "web",
      source: "https://123e4567-e89b-42d3-a456-426614174000.example.com/docs",
    };

    const warnings = inspectPublicSkill(registrySkillPackageSchema.parse(skill));

    expect(warnings.suspectedPrivateIdentifiers).toBe(1);
  });

  it("scans object keys and decoded Recipe URLs for sensitive content", () => {
    expect(
      inspectPublicText({
        schema: { properties: { "api_key=abcdefghijklmnop": { type: "string" } } },
      }).suspectedSecrets,
    ).toBe(true);
    expect(
      inspectPublicText({
        endpoint:
          "https://mcp.example.com/%74%6f%6b%65%6e%3Dabcdefghijklmnop/%31%32%33%65%34%35%36%37%2D%65%38%39%62%2D%34%32%64%33%2D%61%34%35%36%2D%34%32%36%36%31%34%31%37%34%30%30%30",
      }),
    ).toEqual({ suspectedPrivateIdentifiers: true, suspectedSecrets: true });
  });

  it("projects user-facing outcomes and authority separately from package bytes", async () => {
    const recipe = recipePackageSchema.parse(recipeFixture());
    recipe.connections = [
      {
        authKind: "public",
        authorization: "standing",
        description: "Request one reviewed remote write.",
        endpoint: "https://mcp.example.com/",
        expiresAfterSeconds: 3_600,
        kind: "remote_mcp",
        limits: {
          maxCallsPerRun: 1,
          maxConcurrency: 1,
          maxCostMicrousdPerCall: 0,
          maxDurationMs: 10_000,
          maxOutputBytes: 8_192,
        },
        oauthScopes: [],
        requiredTools: [{ effect: "write", name: "issues.update" }],
        reviewedSnapshotDigest: "a".repeat(64),
        reviewedToolCount: 1,
        slot: "issues",
      },
    ];
    const bytes = canonicalPackage(recipe);
    const projection = projectRecipe({
      descriptor: { digest: await sha256Hex(bytes), sizeBytes: bytes.byteLength },
      namespace: "octocat",
      package: recipe,
      publishedAt: "2026-08-02T12:00:00.000Z",
      publisher: { displayName: "Octocat", namespace: "octocat" },
      version: 1,
    });

    expect(projection.title).toBe("Research Brief Steward");
    expect(projection.deliverables).toEqual(["markdown"]);
    expect(projection.inference).toEqual({
      fallbackModels: ["@cf/openai/gpt-oss-20b"],
      primaryModel: "@cf/meta/llama-4-scout-17b-16e-instruct",
    });
    expect(projection.requestedAuthority).toEqual({
      approvalRequired: { destructive: 0, read: 0, write: 0 },
      standing: { destructive: 0, read: 0, write: 1 },
    });
  });
});
