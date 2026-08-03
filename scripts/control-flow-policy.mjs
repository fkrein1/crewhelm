import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policyUrl = new URL("./control-flow-policy.json", import.meta.url);
const productionSourceRoots = [
  "apps/cli/src",
  "apps/registry/src",
  "apps/site/src",
  "apps/worker/control-plane-migrations",
  "apps/worker/src",
  "packages/composio/src",
  "packages/contracts/src",
];
const excludedFileSuffixes = [".d.ts", ".test-double.ts", ".test.ts"];
const excludedFiles = new Set([
  "apps/worker/src/agent/admitted-runs/test-agent.ts",
  "apps/worker/src/oauth/testkit.ts",
  "apps/worker/src/owner/testkit.ts",
  "apps/worker/src/worker-test-entry.ts",
]);

/**
 * @typedef {object} ControlFlowUnit
 * @property {string} id
 * @property {string[]} [files]
 * @property {string[]} [pathPrefixes]
 * @property {{definitionVersion: number, testFiles: string[]}} evidence
 */

/**
 * @typedef {object} ControlFlowPolicy
 * @property {number} schemaVersion
 * @property {number} definitionVersion
 * @property {string[]} definitionOfMigrated
 * @property {ControlFlowUnit[]} units
 */

/**
 * @typedef {object} ControlFlowPolicyResult
 * @property {string[]} errors
 * @property {Map<string, string[]>} filesByUnit
 * @property {{classifiedFiles: number, classifiedPercentage: number, compliantUnits: number, compliantUnitPercentage: number, totalFiles: number, totalUnits: number}} summary
 */

/** @param {string} path */
function toRepositoryPath(path) {
  return path.split(sep).join("/");
}

/**
 * @param {number} part
 * @param {number} whole
 */
function percentage(part, whole) {
  return whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(1));
}

/**
 * @template T
 * @param {T[]} values
 * @returns {T[]}
 */
function duplicates(values) {
  /** @type {Set<T>} */
  const seen = new Set();
  /** @type {Set<T>} */
  const repeated = new Set();

  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }

  return [...repeated].toSorted((left, right) => String(left).localeCompare(String(right)));
}

/**
 * @param {string} file
 * @param {ControlFlowUnit} unit
 */
function matchesUnit(file, unit) {
  return (
    (unit.files ?? []).includes(file) ||
    (unit.pathPrefixes ?? []).some((prefix) => file.startsWith(prefix))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string[]}
 */
function readStringArray(value, name) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${name} must be an array of strings.`);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function readNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number.`);
  }

  return value;
}

/**
 * @param {string} value
 * @param {{directory: boolean}} options
 */
function isRepositoryPath(value, options) {
  const path = options.directory && value.endsWith("/") ? value.slice(0, -1) : value;
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
    (!options.directory || value.endsWith("/")) &&
    (options.directory || path.endsWith(".ts"))
  );
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {{directory: boolean}} options
 */
function readRepositoryPaths(value, name, options) {
  const paths = readStringArray(value, name);

  if (paths.length === 0 || !paths.every((path) => isRepositoryPath(path, options))) {
    throw new TypeError(`${name} must contain repository-relative paths.`);
  }

  return paths;
}

/**
 * Discover production TypeScript files covered by the permanent policy.
 *
 * @param {string} [root]
 * @returns {string[]}
 */
export function discoverControlFlowFiles(root = repositoryRoot) {
  /** @type {string[]} */
  const discovered = [];

  /** @param {string} directory */
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }

      const repositoryPath = toRepositoryPath(relative(root, absolutePath));
      if (
        entry.isFile() &&
        repositoryPath.endsWith(".ts") &&
        !excludedFiles.has(repositoryPath) &&
        !excludedFileSuffixes.some((suffix) => repositoryPath.endsWith(suffix))
      ) {
        discovered.push(repositoryPath);
      }
    }
  }

  for (const sourceRoot of productionSourceRoots) visit(resolve(root, sourceRoot));
  return discovered.toSorted((left, right) => left.localeCompare(right));
}

/**
 * Require every production file to belong to exactly one unit and every unit to carry current
 * test evidence. There is no legacy state after migration: any regression fails directly.
 *
 * @param {ControlFlowPolicy} policy
 * @param {string[]} files
 */
export function evaluateControlFlowPolicy(policy, files) {
  const errors = [];
  const unitIds = policy.units.map((unit) => unit.id);

  if (policy.schemaVersion !== 2) {
    errors.push(`Unsupported policy schema version: ${policy.schemaVersion}.`);
  }
  if (policy.units.length === 0) {
    errors.push("Control-flow policy has no capability units.");
  }
  if (files.length === 0) {
    errors.push("Control-flow policy discovered no production files.");
  }
  if (
    policy.definitionOfMigrated.length === 0 ||
    policy.definitionOfMigrated.some((definition) => definition.trim().length === 0)
  ) {
    errors.push("Control-flow policy has no migration definition.");
  }
  for (const id of duplicates(unitIds)) {
    errors.push(`Capability unit id is duplicated: ${id}.`);
  }

  /** @type {Map<string, string[]>} */
  const filesByUnit = new Map(policy.units.map((unit) => [unit.id, []]));
  let compliantUnits = 0;

  for (const unit of policy.units) {
    const selectors = [...(unit.files ?? []), ...(unit.pathPrefixes ?? [])];
    let compliant = true;

    if (selectors.length === 0) {
      errors.push(`Capability unit ${unit.id} has no file selectors.`);
      compliant = false;
    }
    for (const selector of duplicates(selectors)) {
      errors.push(`Capability unit ${unit.id} repeats selector: ${selector}.`);
      compliant = false;
    }
    if (unit.evidence.definitionVersion !== policy.definitionVersion) {
      errors.push(`Capability unit uses stale criteria: ${unit.id}.`);
      compliant = false;
    }
    if (unit.evidence.testFiles.length === 0) {
      errors.push(`Capability unit has no evidence tests: ${unit.id}.`);
      compliant = false;
    }

    if (compliant) compliantUnits += 1;
  }

  let classifiedFiles = 0;

  for (const file of files) {
    const matchingUnits = policy.units.filter((unit) => matchesUnit(file, unit));

    if (matchingUnits.length === 0) {
      errors.push(`Production file is not assigned to a capability unit: ${file}.`);
      continue;
    }
    if (matchingUnits.length > 1) {
      errors.push(
        `Production file belongs to multiple capability units (${matchingUnits
          .map((unit) => unit.id)
          .join(", ")}): ${file}.`,
      );
      continue;
    }

    const unit = matchingUnits[0];
    if (unit) filesByUnit.get(unit.id)?.push(file);
    classifiedFiles += 1;
  }

  for (const unit of policy.units) {
    if (filesByUnit.get(unit.id)?.length === 0) {
      errors.push(`Capability unit has no production files: ${unit.id}.`);
    }
  }

  return {
    errors,
    filesByUnit,
    summary: {
      classifiedFiles,
      classifiedPercentage: percentage(classifiedFiles, files.length),
      compliantUnits,
      compliantUnitPercentage: percentage(compliantUnits, policy.units.length),
      totalFiles: files.length,
      totalUnits: policy.units.length,
    },
  };
}

/**
 * @param {ControlFlowPolicy} policy
 * @param {string} [root]
 * @param {Set<string>} [trackedFiles]
 * @returns {string[]}
 */
export function verifyControlFlowEvidence(policy, root = repositoryRoot, trackedFiles) {
  const errors = [];
  let repositoryFiles = trackedFiles;

  if (!repositoryFiles) {
    const inventory = spawnSync("git", ["ls-files", "--cached"], { cwd: root, encoding: "utf8" });

    if (inventory.status !== 0) {
      throw new Error("Could not inventory tracked files for control-flow evidence.");
    }

    repositoryFiles = new Set(inventory.stdout.split("\n"));
  }

  for (const unit of policy.units) {
    for (const testFile of duplicates(unit.evidence.testFiles)) {
      errors.push(`Evidence test for ${unit.id} is duplicated: ${testFile}.`);
    }

    for (const testFile of unit.evidence.testFiles) {
      const absolutePath = resolve(root, testFile);
      const insideRepository = absolutePath.startsWith(`${resolve(root)}${sep}`);
      const includedByVitest =
        /^(?:packages|test)\/.*\.test\.ts$/.test(testFile) ||
        /^apps\/registry\/src\/.*\.test\.ts$/.test(testFile) ||
        /^apps\/site\/src\/.*\.test\.ts$/.test(testFile) ||
        /^apps\/worker\/src\/.*\.test\.ts$/.test(testFile) ||
        /^apps\/cli\/test\/.*\.test\.ts$/.test(testFile);

      if (!insideRepository) {
        errors.push(`Evidence for ${unit.id} leaves the repository: ${testFile}.`);
      } else if (!includedByVitest) {
        errors.push(`Evidence for ${unit.id} is not included by Vitest: ${testFile}.`);
      } else if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
        errors.push(`Evidence test for ${unit.id} is not a regular file: ${testFile}.`);
      } else if (!repositoryFiles.has(testFile)) {
        errors.push(`Evidence test for ${unit.id} is not tracked: ${testFile}.`);
      }
    }
  }

  return errors;
}

/**
 * @param {ControlFlowPolicy} policy
 * @param {ControlFlowPolicyResult} result
 */
export function renderControlFlowReport(policy, result) {
  const { summary } = result;
  const rows = policy.units.map((unit) => {
    const files = result.filesByUnit.get(unit.id)?.length ?? 0;
    return `| ${unit.id} | ${files} | ${unit.evidence.testFiles.length} |`;
  });

  return [
    "## Control-flow policy",
    "",
    `- Classified production files: ${summary.classifiedFiles}/${summary.totalFiles} (${summary.classifiedPercentage}%)`,
    `- Units declaring current evidence: ${summary.compliantUnits}/${summary.totalUnits} (${summary.compliantUnitPercentage}%)`,
    `- Policy: ${result.errors.length === 0 ? "passing" : `failing (${result.errors.length} errors)`}`,
    "",
    "| Capability unit | Files | Evidence tests |",
    "| --- | ---: | ---: |",
    ...rows,
    "",
  ].join("\n");
}

/**
 * @param {string} source
 * @returns {ControlFlowPolicy}
 */
export function parseControlFlowPolicy(source) {
  /** @type {unknown} */
  const value = JSON.parse(source);

  if (!isRecord(value) || !Array.isArray(value.units)) {
    throw new TypeError("Control-flow policy must contain units.");
  }

  const units = value.units.map((unit, index) => {
    if (!isRecord(unit) || typeof unit.id !== "string" || !isRecord(unit.evidence)) {
      throw new TypeError(`units[${index}] must contain id and evidence fields.`);
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(unit.id)) {
      throw new TypeError(`units[${index}].id must be a kebab-case identifier.`);
    }

    /** @type {ControlFlowUnit} */
    const parsed = {
      evidence: {
        definitionVersion: readNumber(
          unit.evidence.definitionVersion,
          `units[${index}].evidence.definitionVersion`,
        ),
        testFiles: readStringArray(unit.evidence.testFiles, `units[${index}].evidence.testFiles`),
      },
      id: unit.id,
    };

    if (unit.files !== undefined) {
      parsed.files = readRepositoryPaths(unit.files, `units[${index}].files`, {
        directory: false,
      });
    }
    if (unit.pathPrefixes !== undefined) {
      parsed.pathPrefixes = readRepositoryPaths(unit.pathPrefixes, `units[${index}].pathPrefixes`, {
        directory: true,
      });
    }

    return parsed;
  });

  return {
    definitionOfMigrated: readStringArray(value.definitionOfMigrated, "definitionOfMigrated"),
    definitionVersion: readNumber(value.definitionVersion, "definitionVersion"),
    schemaVersion: readNumber(value.schemaVersion, "schemaVersion"),
    units,
  };
}

/**
 * @param {URL} [url]
 * @returns {ControlFlowPolicy}
 */
export function loadControlFlowPolicy(url = policyUrl) {
  return parseControlFlowPolicy(readFileSync(url, "utf8"));
}

function run() {
  const acceptedArguments = new Set(["--check", "--report"]);
  const argument = process.argv[2] ?? "--check";

  if (!acceptedArguments.has(argument) || process.argv.length > 3) {
    console.error("Usage: node scripts/control-flow-policy.mjs [--check|--report]");
    process.exit(2);
  }

  const policy = loadControlFlowPolicy();
  const files = discoverControlFlowFiles();
  const result = evaluateControlFlowPolicy(policy, files);
  result.errors.push(...verifyControlFlowEvidence(policy));
  const report = renderControlFlowReport(policy, result);

  console.log(report);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  if (result.errors.length > 0) {
    console.error(result.errors.map((error) => `- ${error}`).join("\n"));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
