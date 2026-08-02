import {
  OWNER_READ_SCOPE,
  OWNER_WRITE_SCOPE,
  getSkillResultSchema,
  listSkillsResultSchema,
  publishSkillResultSchema,
  retireSkillResultSchema,
  type GetSkillResult,
  type SkillPackage,
} from "@crewhelm/contracts";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { authorityFor } from "../testkit.js";
import { runtimeLoadFailureFromSkill, type SkillRuntimeLoadResult } from "./module.js";

type GetSkillFailureCode = Extract<GetSkillResult, { ok: false }>["error"]["code"];
type RuntimeLoadFailureCode = Extract<SkillRuntimeLoadResult, { ok: false }>["code"];

const RUNTIME_FAILURE_BY_SKILL_FAILURE = {
  idempotency_conflict: "reference_unavailable",
  incompatible_schema: "reference_unavailable",
  insufficient_scope: "reference_unavailable",
  invalid_authority: "reference_unavailable",
  invalid_request: "reference_unavailable",
  library_capacity_exceeded: "reference_unavailable",
  name_conflict: "reference_unavailable",
  no_changes: "reference_unavailable",
  owner_mismatch: "reference_unavailable",
  package_mismatch: "reference_unavailable",
  skill_limit_exceeded: "reference_unavailable",
  skill_not_found: "reference_unavailable",
  skill_retired: "reference_unavailable",
  skill_storage_corrupt: "storage_corrupt",
  skill_storage_unavailable: "storage_unavailable",
  suspected_secret: "reference_unavailable",
  version_conflict: "reference_unavailable",
  version_limit_exceeded: "reference_unavailable",
} as const satisfies Record<GetSkillFailureCode, RuntimeLoadFailureCode>;

function packageInput(
  name = "release-reviewer",
  skill = "# Release reviewer\n\nReview the release.",
) {
  return {
    description: "Review a release before publication.",
    files: [
      {
        content: "EXAMPLE_VALUE=not-a-real-secret-value\n",
        path: "references/example.env",
      },
      {
        content: "echo review\n",
        path: "scripts/review.sh",
      },
      { content: skill, path: "SKILL.md" },
    ],
    name,
    provenance: { kind: "authored" as const },
  };
}

function publishInput(idempotencyKey: string, skillPackage: SkillPackage = packageInput()) {
  return {
    idempotencyKey,
    mode: "apply" as const,
    target: {
      kind: "skill-package" as const,
      package: skillPackage,
    },
  };
}

describe("Skills control flow", () => {
  it("translates every Skill read failure for runtime loading", () => {
    for (const [skillCode, runtimeCode] of Object.entries(RUNTIME_FAILURE_BY_SKILL_FAILURE)) {
      const result = getSkillResultSchema.parse({
        error:
          skillCode === "skill_storage_corrupt" || skillCode === "skill_storage_unavailable"
            ? {
                code: skillCode,
                message: "Skill storage unavailable.",
                operation: {
                  nextAction:
                    skillCode === "skill_storage_corrupt"
                      ? "contact_operator"
                      : "retry_same_request",
                },
              }
            : { code: skillCode, message: "Skill request denied." },
        ok: false,
      });

      if (result.ok) {
        throw new Error("Expected a Skill read failure fixture.");
      }

      expect(runtimeLoadFailureFromSkill(result.error.code)).toEqual({
        code: runtimeCode,
        ok: false,
      });
    }
  });
});

describe("OwnerControlPlane Skills", () => {
  it("previews, publishes, lists, and reads one immutable package without content in SQLite", async () => {
    const authority = await authorityFor("skills-lifecycle", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = publishInput("skill-publish-lifecycle");
    const secretPackage = {
      ...input.target.package,
      description: "token=not-a-real-secret-value",
      files: input.target.package.files.map((file) =>
        file.path === "references/example.env"
          ? { ...file, content: "TOKEN=not-a-real-secret-value\n" }
          : file,
      ),
    };
    const secretPreview = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, {
        mode: "preview",
        target: { kind: "skill-package", package: secretPackage },
      }),
    );

    expect(secretPreview).toMatchObject({
      ok: true,
      package: {
        warnings: [
          { code: "suspected_secret", path: "$description" },
          { code: "suspected_secret", path: "references/example.env" },
          { code: "executable_content", path: "scripts/review.sh" },
        ],
      },
    });
    await expect(
      stub.publishSkill(authority, publishInput("skill-secret-must-not-persist", secretPackage)),
    ).resolves.toMatchObject({
      error: { code: "suspected_secret" },
      ok: false,
    });
    const preview = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, {
        mode: "preview",
        target: input.target,
      }),
    );

    expect(preview).toMatchObject({
      applied: false,
      ok: true,
      package: {
        fileCount: 3,
        warnings: [{ code: "executable_content", path: "scripts/review.sh" }],
      },
      version: 1,
    });

    const published = publishSkillResultSchema.parse(await stub.publishSkill(authority, input));

    expect(published).toMatchObject({
      applied: true,
      ok: true,
      skill: {
        currentVersion: 1,
        name: "release-reviewer",
        status: "active",
        versionCount: 1,
      },
      version: 1,
    });
    if (!published.ok || published.skill === undefined) {
      throw new Error("Expected Skill publication.");
    }

    await expect(stub.publishSkill(authority, input)).resolves.toMatchObject({
      applied: false,
      ok: true,
      skill: { id: published.skill.id },
      version: 1,
    });
    const mutationsBeforeNoOp = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM skill_mutations")
        .one(),
    );
    await expect(
      stub.publishSkill(authority, {
        idempotencyKey: "skill-no-op-does-not-persist",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.skill.id,
          kind: "skill-package",
          package: packageInput(),
        },
      }),
    ).resolves.toMatchObject({
      error: { code: "no_changes" },
      ok: false,
    });
    const mutationsAfterNoOp = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM skill_mutations")
        .one(),
    );

    expect(mutationsAfterNoOp.count).toBe(mutationsBeforeNoOp.count);
    expect(
      listSkillsResultSchema.parse(
        await stub.listSkills(authority, {
          target: { kind: "skill-catalog", name: "release", status: "active" },
        }),
      ),
    ).toEqual({
      nextCursor: null,
      ok: true,
      skills: [published.skill],
    });

    await evictDurableObject(stub);
    const exact = getSkillResultSchema.parse(
      await stub.getSkill(authority, {
        target: { id: published.skill.id, kind: "skill-package" },
      }),
    );

    expect(exact).toMatchObject({
      ok: true,
      skill: { id: published.skill.id },
      version: {
        contentTrust: "untrusted",
        files: packageInput().files.toSorted((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
        ),
        id: published.skill.id,
        version: 1,
      },
    });

    const sqliteText = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ value: string }>(
          `SELECT group_concat(value, '') AS value
           FROM (
             SELECT CAST(name AS TEXT) AS value FROM sqlite_master
             UNION ALL
             SELECT CAST(action AS TEXT) FROM audit_events
             UNION ALL
             SELECT CAST(subject_id AS TEXT) FROM audit_events
           )`,
        )
        .one(),
    );

    expect(sqliteText.value).not.toContain("not-a-real-secret-value");
    await expect(stub.status(authority, { includeRecentAudit: true })).resolves.toMatchObject({
      ok: true,
      status: {
        recentAudit: [
          {
            action: "skill.published",
            subjectId: published.skill.id,
          },
        ],
        usage: {
          skills: {
            active: 1,
            pendingObjects: 0,
            storedBytes: published.package.sizeBytes,
            total: 1,
            versions: 1,
          },
        },
      },
    });
  });

  it("versions exact packages, enforces optimistic concurrency, and retires without deleting history", async () => {
    const authority = await authorityFor("skills-versioning", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const first = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, publishInput("skill-version-1")),
    );

    if (!first.ok || first.skill === undefined) {
      throw new Error("Expected initial Skill publication.");
    }

    const secondInput = {
      idempotencyKey: "skill-version-2",
      mode: "apply" as const,
      target: {
        expectedVersion: 1,
        id: first.skill.id,
        kind: "skill-package" as const,
        package: packageInput(
          "release-reviewer",
          "# Release reviewer\n\nReview release provenance and rollback.",
        ),
      },
    };
    const second = publishSkillResultSchema.parse(await stub.publishSkill(authority, secondInput));

    expect(second).toMatchObject({
      applied: true,
      ok: true,
      skill: { currentVersion: 2, versionCount: 2 },
      version: 2,
    });
    await expect(
      stub.publishSkill(authority, {
        ...secondInput,
        idempotencyKey: "skill-stale-version",
      }),
    ).resolves.toMatchObject({
      error: { code: "version_conflict" },
      ok: false,
    });
    await expect(
      stub.publishSkill(authority, {
        ...secondInput,
        target: { ...secondInput.target, package: packageInput("different-request") },
      }),
    ).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
      ok: false,
    });

    const retirement = {
      idempotencyKey: "skill-retire-2",
      mode: "apply" as const,
      target: {
        expectedVersion: 2,
        id: first.skill.id,
        kind: "skill-retirement" as const,
      },
    };
    expect(
      retireSkillResultSchema.parse(await stub.retireSkill(authority, retirement)),
    ).toMatchObject({
      applied: true,
      ok: true,
      skill: { status: "retired", versionCount: 2 },
    });
    await expect(stub.retireSkill(authority, retirement)).resolves.toMatchObject({
      applied: false,
      ok: true,
      skill: { status: "retired" },
    });
    await expect(
      stub.getSkill(authority, {
        target: { id: first.skill.id, kind: "skill-package", version: 1 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      version: { version: 1 },
    });

    const historicalObjectKey = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ objectKey: string }>(
            "SELECT object_key AS objectKey FROM skill_versions WHERE skill_id = ? AND version = 1",
            first.skill!.id,
          )
          .one().objectKey,
    );
    await env.SKILL_PACKAGES.delete(historicalObjectKey);
    await expect(
      stub.publishSkill(authority, {
        idempotencyKey: "skill-repair-retired-history",
        mode: "apply",
        target: {
          id: first.skill.id,
          kind: "skill-package",
          package: packageInput(),
          repairVersion: 1,
        },
      }),
    ).resolves.toMatchObject({
      applied: true,
      ok: true,
      skill: { status: "retired" },
      version: 1,
    });
    await expect(
      stub.getSkill(authority, {
        target: { id: first.skill.id, kind: "skill-package", version: 1 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      version: { version: 1 },
    });
  });

  it("rejects suspected secrets in provenance metadata", async () => {
    const authority = await authorityFor("skills-provenance-secret", [
      OWNER_READ_SCOPE,
      OWNER_WRITE_SCOPE,
    ]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const skillPackage = {
      ...packageInput(),
      provenance: {
        kind: "web" as const,
        source: "https://example.com/token/not-a-real-secret-value",
      },
    };

    await expect(
      stub.publishSkill(authority, {
        mode: "preview",
        target: { kind: "skill-package", package: skillPackage },
      }),
    ).resolves.toMatchObject({
      ok: true,
      package: {
        warnings: expect.arrayContaining([
          { code: "suspected_secret", path: "$provenance.source" },
        ]),
      },
    });
    await expect(
      stub.publishSkill(authority, publishInput("skill-provenance-secret", skillPackage)),
    ).resolves.toMatchObject({
      error: { code: "suspected_secret" },
      ok: false,
    });
  });

  it("paginates compact catalog summaries with deterministic filters", async () => {
    const authority = await authorityFor("skills-catalog", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);

    for (const [key, name] of [
      ["catalog-alpha", "alpha-reviewer"],
      ["catalog-beta", "beta-reviewer"],
    ] as const) {
      await stub.publishSkill(authority, publishInput(key, packageInput(name)));
    }

    const firstPage = listSkillsResultSchema.parse(
      await stub.listSkills(authority, {
        target: { kind: "skill-catalog", limit: 1, status: "active" },
      }),
    );

    expect(firstPage).toMatchObject({ ok: true, skills: [{ status: "active" }] });
    if (!firstPage.ok || firstPage.nextCursor === null) {
      throw new Error("Expected a paginated Skill catalog.");
    }

    const secondPage = listSkillsResultSchema.parse(
      await stub.listSkills(authority, {
        target: { cursor: firstPage.nextCursor, kind: "skill-catalog", limit: 1 },
      }),
    );
    const filtered = listSkillsResultSchema.parse(
      await stub.listSkills(authority, {
        target: { kind: "skill-catalog", name: "beta", status: "active" },
      }),
    );

    expect(secondPage).toMatchObject({ nextCursor: null, ok: true, skills: [{}] });
    expect(filtered).toMatchObject({
      nextCursor: null,
      ok: true,
      skills: [{ name: "beta-reviewer" }],
    });
    expect(JSON.stringify([firstPage, secondPage, filtered])).not.toContain('"files"');
  });

  it("recovers an R2 write whose metadata transaction failed", async () => {
    const authority = await authorityFor("skills-recovery", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = publishInput("skill-recovery");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER reject_skill_version
        BEFORE INSERT ON skill_versions
        BEGIN
          SELECT RAISE(ABORT, 'forced Skill metadata failure');
        END
      `);
    });
    await expect(stub.publishSkill(authority, input)).resolves.toEqual({
      error: {
        code: "skill_storage_unavailable",
        message: "Skill storage unavailable.",
        operation: { nextAction: "retry_same_request" },
      },
      ok: false,
    });
    await expect(stub.status(authority, {})).resolves.toMatchObject({
      ok: true,
      status: {
        usage: {
          skills: {
            pendingObjects: 1,
            storedBytes: expect.any(Number),
            versions: 0,
          },
        },
      },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER reject_skill_version");
    });
    await expect(stub.publishSkill(authority, input)).resolves.toMatchObject({
      applied: true,
      ok: true,
      skill: { currentVersion: 1 },
    });
    await expect(stub.status(authority, {})).resolves.toMatchObject({
      ok: true,
      status: {
        usage: {
          skills: {
            pendingObjects: 0,
            versions: 1,
          },
        },
      },
    });
  });

  it("rolls back and reports a violated publication metadata invariant", async () => {
    const authority = await authorityFor("skills-invariant", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const input = publishInput("skill-invariant");

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(`
        CREATE TRIGGER invalidate_published_skill_summary
        AFTER INSERT ON audit_events
        WHEN NEW.action = 'skill.published'
        BEGIN
          UPDATE skills
          SET current_version = current_version + 1
          WHERE skill_id = NEW.subject_id;
        END
      `);
    });
    await expect(stub.publishSkill(authority, input)).resolves.toEqual({
      error: {
        code: "skill_storage_corrupt",
        message: "Skill storage unavailable.",
        operation: { nextAction: "contact_operator" },
      },
      ok: false,
    });
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec<{ skills: number; versions: number }>(
            `SELECT
               (SELECT count(*) FROM skills) AS skills,
               (SELECT count(*) FROM skill_versions) AS versions`,
          )
          .one(),
      ),
    ).resolves.toEqual({ skills: 0, versions: 0 });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER invalidate_published_skill_summary");
    });
    await expect(stub.publishSkill(authority, input)).resolves.toMatchObject({
      applied: true,
      ok: true,
      skill: { currentVersion: 1 },
    });
  });

  it("fails closed for missing package objects and unauthorized access", async () => {
    const authority = await authorityFor("skills-storage", [OWNER_READ_SCOPE, OWNER_WRITE_SCOPE]);
    const unauthorized = await authorityFor("skills-storage", [OWNER_READ_SCOPE]);
    const stub = env.OWNER_CONTROL_PLANE.getByName(authority.ownerKey);
    const published = publishSkillResultSchema.parse(
      await stub.publishSkill(authority, publishInput("skill-storage")),
    );

    if (!published.ok || published.skill === undefined) {
      throw new Error("Expected Skill publication.");
    }

    await expect(
      stub.publishSkill(unauthorized, publishInput("skill-storage-denied")),
    ).resolves.toMatchObject({
      error: { code: "insufficient_scope" },
      ok: false,
    });

    const objectKey = await runInDurableObject(
      stub,
      (_instance, state) =>
        state.storage.sql
          .exec<{ objectKey: string }>(
            "SELECT object_key AS objectKey FROM skill_versions WHERE skill_id = ?",
            published.skill!.id,
          )
          .one().objectKey,
    );
    await env.SKILL_PACKAGES.delete(objectKey);
    await expect(
      stub.getSkill(authority, {
        target: { id: published.skill.id, kind: "skill-package" },
      }),
    ).resolves.toEqual({
      error: {
        code: "skill_storage_corrupt",
        message: "Skill storage unavailable.",
        operation: { nextAction: "contact_operator" },
      },
      ok: false,
    });
    await expect(
      stub.publishSkill(authority, {
        idempotencyKey: "skill-storage-repair",
        mode: "apply",
        target: {
          expectedVersion: 1,
          id: published.skill.id,
          kind: "skill-package",
          package: packageInput(),
        },
      }),
    ).resolves.toMatchObject({
      applied: true,
      ok: true,
      skill: { id: published.skill.id },
      version: 1,
    });
    await expect(
      stub.getSkill(authority, {
        target: { id: published.skill.id, kind: "skill-package" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      version: { version: 1 },
    });

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE skill_versions SET file_count = file_count + 1 WHERE skill_id = ?",
        published.skill!.id,
      );
    });
    await expect(
      stub.getSkill(authority, {
        target: { id: published.skill.id, kind: "skill-package" },
      }),
    ).resolves.toMatchObject({
      error: { code: "skill_storage_corrupt" },
      ok: false,
    });
  });
});
