import { describe, expect, it } from "vitest";

import {
  MAXIMUM_SKILL_FILE_BYTES,
  MAXIMUM_SKILL_PACKAGE_BYTES,
  listSkillsResultSchema,
  publishSkillInputSchema,
  skillPackageSchema,
} from "./skills.js";

function packageInput() {
  return {
    description: "Review a release before publication.",
    files: [
      { content: "Use the checklist.", path: "references/checklist.md" },
      { content: "# Release reviewer", path: "SKILL.md" },
    ],
    name: "release-reviewer",
    provenance: { kind: "authored" as const },
  };
}

describe("Skill contracts", () => {
  it("canonicalizes bounded UTF-8 packages", () => {
    expect(skillPackageSchema.parse(packageInput())).toEqual({
      ...packageInput(),
      files: [
        { content: "# Release reviewer", path: "SKILL.md" },
        { content: "Use the checklist.", path: "references/checklist.md" },
      ],
    });
  });

  it("rejects traversal, duplicate paths, control bytes, and oversized content", () => {
    for (const skillPackage of [
      {
        ...packageInput(),
        files: [{ content: "escape", path: "references/../secret.txt" }],
      },
      {
        ...packageInput(),
        files: [
          { content: "one", path: "SKILL.md" },
          { content: "two", path: "SKILL.md" },
        ],
      },
      {
        ...packageInput(),
        files: [{ content: "bad\u0000text", path: "SKILL.md" }],
      },
      {
        ...packageInput(),
        files: [{ content: "x".repeat(MAXIMUM_SKILL_FILE_BYTES + 1), path: "SKILL.md" }],
      },
      {
        ...packageInput(),
        description: "x".repeat(MAXIMUM_SKILL_PACKAGE_BYTES),
      },
    ]) {
      expect(skillPackageSchema.safeParse(skillPackage).success).toBe(false);
    }
  });

  it("requires exact pinned repository provenance and apply idempotency", () => {
    const unpinned = {
      ...packageInput(),
      provenance: {
        commit: "main",
        kind: "repository",
        source: "https://github.com/example/skills?token=secret",
      },
    };

    expect(skillPackageSchema.safeParse(unpinned).success).toBe(false);
    expect(
      publishSkillInputSchema.safeParse({
        mode: "apply",
        target: { kind: "skill-package", package: packageInput() },
      }).success,
    ).toBe(false);
    expect(
      publishSkillInputSchema.safeParse({
        idempotencyKey: "preview-must-not-have-key",
        mode: "preview",
        target: { kind: "skill-package", package: packageInput() },
      }).success,
    ).toBe(false);
  });

  it("keeps a maximum catalog page compact", () => {
    const maximumPage = listSkillsResultSchema.parse({
      nextCursor: null,
      ok: true,
      skills: Array.from({ length: 25 }, (_, index) => ({
        createdAt: "2026-01-01T00:00:00.000Z",
        currentVersion: 100,
        description: "d".repeat(320),
        id: `skill_00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        name: `skill-${index}-${"n".repeat(70)}`.slice(0, 80),
        package: {
          digest: "a".repeat(64),
          fileCount: 64,
          sizeBytes: MAXIMUM_SKILL_PACKAGE_BYTES,
          warningCounts: { executableContent: 64, suspectedSecrets: 64 },
        },
        status: "active",
        updatedAt: "2026-01-01T00:00:00.000Z",
        versionCount: 100,
      })),
    });

    expect(new TextEncoder().encode(JSON.stringify(maximumPage)).byteLength).toBeLessThanOrEqual(
      32 * 1_024,
    );
  });
});
