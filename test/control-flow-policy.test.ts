import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  compareControlFlowProgress,
  discoverControlFlowFiles,
  evaluateControlFlowPolicy,
  loadControlFlowPolicy,
  renderControlFlowReport,
  verifyControlFlowEvidence,
} from "../scripts/control-flow-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function fixturePolicy(overrides: Record<string, unknown> = {}) {
  return {
    definitionOfMigrated: ["Expected failures are values."],
    definitionVersion: 1,
    excludedFiles: [],
    excludedFileSuffixes: [".test.ts"],
    recordedProgress: {
      migratedFiles: 0,
      migratedUnits: 0,
      totalFiles: 1,
      totalUnits: 1,
    },
    schemaVersion: 1,
    sourceRoots: ["src"],
    units: [{ id: "orders", pathPrefixes: ["src/orders/"], status: "legacy" }],
    ...overrides,
  };
}

describe("control-flow migration policy", () => {
  it("classifies every in-scope repository file exactly once", () => {
    const policy = loadControlFlowPolicy();
    const files = discoverControlFlowFiles(policy, repositoryRoot);
    const result = evaluateControlFlowPolicy(policy, files);

    expect(result.errors).toEqual([]);
    expect(result.summary).toMatchObject({
      migratedFiles: policy.recordedProgress.migratedFiles,
      migratedUnits: policy.recordedProgress.migratedUnits,
      totalFiles: policy.recordedProgress.totalFiles,
      totalUnits: policy.recordedProgress.totalUnits,
    });
    expect(result.summary.migratedFilePercentage).toBeGreaterThan(0);
    expect(result.summary.migratedUnitPercentage).toBeGreaterThan(0);
    expect(result.summary.totalFiles).toBeGreaterThan(100);
    expect(result.summary.totalUnits).toBeGreaterThan(20);
  });

  it("discovers production files while excluding test infrastructure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crewhelm-control-flow-"));
    await mkdir(join(directory, "src/orders"), { recursive: true });
    await writeFile(join(directory, "src/orders/create.ts"), "export {};\n");
    await writeFile(join(directory, "src/orders/create.test.ts"), "export {};\n");

    expect(discoverControlFlowFiles(fixturePolicy(), directory)).toEqual(["src/orders/create.ts"]);
  });

  it("rejects unclassified, overlapping, and empty capability units", () => {
    const policy = fixturePolicy({
      units: [
        { id: "orders", pathPrefixes: ["src/orders/"], status: "legacy" },
        { id: "all", pathPrefixes: ["src/"], status: "legacy" },
        { id: "empty", pathPrefixes: ["src/empty/"], status: "legacy" },
      ],
    });
    const result = evaluateControlFlowPolicy(policy, ["outside/file.ts", "src/orders/create.ts"]);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not assigned"),
        expect.stringContaining("multiple capability units"),
        "Capability unit has no production files: orders.",
        "Capability unit has no production files: all.",
        "Capability unit has no production files: empty.",
      ]),
    );
  });

  it("rejects invalid statuses and unrecorded migration changes", () => {
    const policy = fixturePolicy({
      recordedProgress: {
        migratedFiles: 2,
        migratedUnits: 1,
        totalFiles: 1,
        totalUnits: 1,
      },
      units: [{ id: "orders", pathPrefixes: ["src/orders/"], status: "partial" }],
    });
    const result = evaluateControlFlowPolicy(policy, ["src/orders/create.ts"]);

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "Capability unit orders has invalid status: partial.",
        expect.stringContaining("Migrated unit count changed"),
        expect.stringContaining("Migrated file count changed"),
      ]),
    );
  });

  it("requires progress to be recorded when an in-scope file is added", () => {
    const policy = fixturePolicy();
    const result = evaluateControlFlowPolicy(policy, [
      "src/orders/create.ts",
      "src/orders/update.ts",
    ]);

    expect(result.errors).toContain(
      "Total file count changed: policy records 1, repository has 2.",
    );
  });

  it("rejects migrated units without current test evidence", () => {
    const policy = fixturePolicy({
      recordedProgress: {
        migratedFiles: 1,
        migratedUnits: 1,
        totalFiles: 1,
        totalUnits: 1,
      },
      units: [{ id: "orders", pathPrefixes: ["src/orders/"], status: "migrated" }],
    });
    const result = evaluateControlFlowPolicy(policy, ["src/orders/create.ts"]);

    expect(result.errors).toContain("Migrated capability unit lacks evidence: orders.");
  });

  it("rejects demotion or removal that leaves a surviving file legacy", () => {
    const migratedUnit = {
      evidence: { definitionVersion: 1, testFiles: ["src/orders/create.test.ts"] },
      id: "orders",
      pathPrefixes: ["src/orders/"],
      status: "migrated",
    };
    const basePolicy = fixturePolicy({ units: [migratedUnit] });

    expect(
      compareControlFlowProgress(
        fixturePolicy({
          units: [{ id: "orders", pathPrefixes: ["src/orders/"], status: "legacy" }],
        }),
        basePolicy,
        ["src/orders/create.ts"],
        ["src/orders/create.ts"],
      ),
    ).toEqual(["Previously migrated file is no longer migrated: src/orders/create.ts."]);
    expect(
      compareControlFlowProgress(
        fixturePolicy({ units: [] }),
        basePolicy,
        ["src/orders/create.ts"],
        ["src/orders/create.ts"],
      ),
    ).toEqual(["Previously migrated file is no longer migrated: src/orders/create.ts."]);
  });

  it("preserves the files covered by migrated units on the base branch", () => {
    const migratedUnit = {
      evidence: { definitionVersion: 1, testFiles: ["test/orders/create.test.ts"] },
      id: "orders",
      pathPrefixes: ["src/orders/"],
      status: "migrated",
    };
    const basePolicy = fixturePolicy({ units: [migratedUnit] });
    const currentPolicy = fixturePolicy({
      units: [
        { ...migratedUnit, pathPrefixes: ["src/orders/new/"] },
        { id: "old-orders", files: ["src/orders/create.ts"], status: "legacy" },
      ],
    });

    expect(
      compareControlFlowProgress(
        currentPolicy,
        basePolicy,
        ["src/orders/create.ts"],
        ["src/orders/create.ts"],
      ),
    ).toEqual(["Previously migrated file is no longer migrated: src/orders/create.ts."]);
  });

  it("allows migrated capability units to be renamed or split", () => {
    const evidence = { definitionVersion: 1, testFiles: ["test/orders/create.test.ts"] };
    const basePolicy = fixturePolicy({
      units: [{ evidence, id: "orders", pathPrefixes: ["src/orders/"], status: "migrated" }],
    });
    const currentPolicy = fixturePolicy({
      units: [
        { evidence, files: ["src/orders/create.ts"], id: "order-commands", status: "migrated" },
      ],
    });

    expect(
      compareControlFlowProgress(
        currentPolicy,
        basePolicy,
        ["src/orders/create.ts"],
        ["src/orders/create.ts"],
      ),
    ).toEqual([]);
  });

  it("requires migration-definition changes to increase the version", () => {
    const basePolicy = fixturePolicy();
    const changedPolicy = fixturePolicy({ definitionOfMigrated: ["Weaker criteria."] });
    const loweredPolicy = fixturePolicy({ definitionVersion: 0 });

    expect(compareControlFlowProgress(changedPolicy, basePolicy, [], [])).toContain(
      "Migration definition changed without increasing its version.",
    );
    expect(compareControlFlowProgress(loweredPolicy, basePolicy, [], [])).toContain(
      "Migration definition version decreased.",
    );
  });

  it("requires evidence to name existing TypeScript tests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "crewhelm-control-flow-evidence-"));
    const policy = fixturePolicy({
      units: [
        {
          evidence: {
            definitionVersion: 1,
            testFiles: ["test/orders/missing.test.ts", "test/orders/not-a-test.ts"],
          },
          id: "orders",
          pathPrefixes: ["src/orders/"],
          status: "migrated",
        },
      ],
    });

    expect(verifyControlFlowEvidence(policy, directory, new Set())).toEqual([
      "Evidence test for orders is not a regular file: test/orders/missing.test.ts.",
      "Evidence for orders is not included by Vitest: test/orders/not-a-test.ts.",
    ]);
  });

  it("renders a stable human-readable percentage report", () => {
    const policy = fixturePolicy({
      recordedProgress: {
        migratedFiles: 1,
        migratedUnits: 1,
        totalFiles: 1,
        totalUnits: 1,
      },
      units: [
        {
          evidence: { definitionVersion: 1, testFiles: ["src/orders/create.test.ts"] },
          id: "orders",
          pathPrefixes: ["src/orders/"],
          status: "migrated",
        },
      ],
    });
    const result = evaluateControlFlowPolicy(policy, ["src/orders/create.ts"]);

    expect(renderControlFlowReport(policy, result)).toContain(
      "- Capability units: 1/1 (100%)\n- Production files: 1/1 (100%)",
    );
  });
});
