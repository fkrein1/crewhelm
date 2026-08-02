import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policyUrl = new URL("./control-flow-policy.json", import.meta.url);

/**
 * @typedef {object} ControlFlowUnit
 * @property {string} id
 * @property {string} status
 * @property {string[]} [files]
 * @property {string[]} [pathPrefixes]
 * @property {{definitionVersion: number, testFiles: string[]}} [evidence]
 */

/**
 * @typedef {object} ControlFlowPolicy
 * @property {number} schemaVersion
 * @property {number} definitionVersion
 * @property {string[]} definitionOfMigrated
 * @property {string[]} sourceRoots
 * @property {string[]} excludedFiles
 * @property {string[]} excludedFileSuffixes
 * @property {{migratedFiles: number, migratedUnits: number, totalFiles: number, totalUnits: number}} recordedProgress
 * @property {ControlFlowUnit[]} units
 */

/**
 * @typedef {object} ControlFlowPolicyResult
 * @property {string[]} errors
 * @property {Map<string, string[]>} filesByUnit
 * @property {{migratedFiles: number, migratedFilePercentage: number, migratedUnits: number, migratedUnitPercentage: number, totalFiles: number, totalUnits: number}} summary
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
    if (seen.has(value)) {
      repeated.add(value);
    }
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
 * @param {string[]} errors
 * @param {string} label
 * @param {number} actual
 * @param {number} recorded
 */
function verifyRecordedProgress(errors, label, actual, recorded) {
  if (actual !== recorded) {
    errors.push(`${label} changed: policy records ${recorded}, repository has ${actual}.`);
  }
}

/**
 * Compare completed unit identities with the base branch so progress cannot be rewritten downward.
 *
 * @param {ControlFlowPolicy} policy
 * @param {ControlFlowPolicy} basePolicy
 * @param {string[]} files
 * @param {string[]} baseFiles
 * @param {Set<string>} [existingFiles]
 * @returns {string[]}
 */
export function compareControlFlowProgress(
  policy,
  basePolicy,
  files,
  baseFiles,
  existingFiles = new Set(files),
) {
  const errors = [];
  const currentFiles = new Set(files);
  const baseResult = evaluateControlFlowPolicy(basePolicy, baseFiles);

  if (policy.definitionVersion < basePolicy.definitionVersion) {
    errors.push("Migration definition version decreased.");
  }

  if (
    JSON.stringify(policy.definitionOfMigrated) !==
      JSON.stringify(basePolicy.definitionOfMigrated) &&
    policy.definitionVersion <= basePolicy.definitionVersion
  ) {
    errors.push("Migration definition changed without increasing its version.");
  }

  for (const baseUnit of basePolicy.units) {
    if (baseUnit.status !== "migrated") {
      continue;
    }

    for (const file of baseResult.filesByUnit.get(baseUnit.id) ?? []) {
      if (!existingFiles.has(file)) {
        continue;
      }

      const matchingUnits = policy.units.filter((unit) => matchesUnit(file, unit));
      if (
        !currentFiles.has(file) ||
        matchingUnits.length !== 1 ||
        matchingUnits[0]?.status !== "migrated"
      ) {
        errors.push(`Previously migrated file is no longer migrated: ${file}.`);
      }
    }
  }

  return errors;
}

/**
 * Discover production TypeScript files covered by the migration policy.
 *
 * @param {object} policy
 * @param {string[]} policy.sourceRoots
 * @param {string[]} policy.excludedFiles
 * @param {string[]} policy.excludedFileSuffixes
 * @param {string} [root]
 * @returns {string[]}
 */
export function discoverControlFlowFiles(policy, root = repositoryRoot) {
  /** @type {string[]} */
  const discovered = [];
  const excludedFiles = new Set(policy.excludedFiles);

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
        !policy.excludedFileSuffixes.some((suffix) => repositoryPath.endsWith(suffix))
      ) {
        discovered.push(repositoryPath);
      }
    }
  }

  for (const sourceRoot of policy.sourceRoots) {
    visit(resolve(root, sourceRoot));
  }

  return discovered.toSorted((left, right) => left.localeCompare(right));
}

/**
 * @param {ControlFlowPolicy} policy
 * @param {string} reference
 * @returns {string[]}
 */
function discoverControlFlowFilesAtReference(policy, reference) {
  const tree = spawnSync(
    "git",
    ["ls-tree", "-r", "--name-only", reference, "--", ...policy.sourceRoots],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (tree.status !== 0) {
    throw new Error(`Could not inventory control-flow files at ${reference}.`);
  }

  const excludedFiles = new Set(policy.excludedFiles);
  return tree.stdout
    .split("\n")
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        !excludedFiles.has(file) &&
        !policy.excludedFileSuffixes.some((suffix) => file.endsWith(suffix)),
    )
    .toSorted((left, right) => left.localeCompare(right));
}

/**
 * Evaluate classification completeness and recorded migration progress.
 *
 * @param {ControlFlowPolicy} policy
 * @param {string[]} files
 */
export function evaluateControlFlowPolicy(policy, files) {
  const errors = [];
  const unitIds = policy.units.map((unit) => unit.id);

  if (policy.schemaVersion !== 1) {
    errors.push(`Unsupported policy schema version: ${policy.schemaVersion}.`);
  }

  for (const id of duplicates(unitIds)) {
    errors.push(`Capability unit id is duplicated: ${id}.`);
  }

  /** @type {Map<string, string[]>} */
  const filesByUnit = new Map(policy.units.map((unit) => [unit.id, []]));

  for (const unit of policy.units) {
    if (unit.status !== "legacy" && unit.status !== "migrated") {
      errors.push(`Capability unit ${unit.id} has invalid status: ${unit.status}.`);
    }

    if (unit.status === "migrated") {
      if (!unit.evidence) {
        errors.push(`Migrated capability unit lacks evidence: ${unit.id}.`);
      } else {
        if (unit.evidence.definitionVersion !== policy.definitionVersion) {
          errors.push(`Migrated capability unit uses stale criteria: ${unit.id}.`);
        }
        if (unit.evidence.testFiles.length === 0) {
          errors.push(`Migrated capability unit has no evidence tests: ${unit.id}.`);
        }
      }
    }

    const selectors = [...(unit.files ?? []), ...(unit.pathPrefixes ?? [])];
    if (selectors.length === 0) {
      errors.push(`Capability unit ${unit.id} has no file selectors.`);
    }

    for (const selector of duplicates(selectors)) {
      errors.push(`Capability unit ${unit.id} repeats selector: ${selector}.`);
    }
  }

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

    const [matchingUnit] = matchingUnits;
    if (matchingUnit) {
      filesByUnit.get(matchingUnit.id)?.push(file);
    }
  }

  for (const unit of policy.units) {
    if (filesByUnit.get(unit.id)?.length === 0) {
      errors.push(`Capability unit has no production files: ${unit.id}.`);
    }
  }

  const migratedUnits = policy.units.filter((unit) => unit.status === "migrated");
  const migratedFiles = migratedUnits.reduce(
    (count, unit) => count + (filesByUnit.get(unit.id)?.length ?? 0),
    0,
  );
  const migratedFilePercentage = percentage(migratedFiles, files.length);
  const migratedUnitPercentage = percentage(migratedUnits.length, policy.units.length);

  verifyRecordedProgress(
    errors,
    "Migrated unit count",
    migratedUnits.length,
    policy.recordedProgress.migratedUnits,
  );
  verifyRecordedProgress(
    errors,
    "Migrated file count",
    migratedFiles,
    policy.recordedProgress.migratedFiles,
  );
  verifyRecordedProgress(
    errors,
    "Total unit count",
    policy.units.length,
    policy.recordedProgress.totalUnits,
  );
  verifyRecordedProgress(
    errors,
    "Total file count",
    files.length,
    policy.recordedProgress.totalFiles,
  );

  return {
    errors,
    filesByUnit,
    summary: {
      migratedFiles,
      migratedFilePercentage,
      migratedUnits: migratedUnits.length,
      migratedUnitPercentage,
      totalFiles: files.length,
      totalUnits: policy.units.length,
    },
  };
}

/**
 * @param {ControlFlowPolicy} policy
 * @param {string} [root]
 * @param {Set<string>} [knownRepositoryFiles]
 * @returns {string[]}
 */
export function verifyControlFlowEvidence(policy, root = repositoryRoot, knownRepositoryFiles) {
  const errors = [];
  let repositoryFiles = knownRepositoryFiles;

  if (!repositoryFiles) {
    const inventory = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
    });

    if (inventory.status !== 0) {
      throw new Error("Could not inventory repository files for migration evidence.");
    }

    repositoryFiles = new Set(inventory.stdout.split("\n"));
  }

  for (const unit of policy.units) {
    for (const testFile of duplicates(unit.evidence?.testFiles ?? [])) {
      errors.push(`Evidence test for ${unit.id} is duplicated: ${testFile}.`);
    }

    for (const testFile of unit.evidence?.testFiles ?? []) {
      const absolutePath = resolve(root, testFile);
      const insideRepository = absolutePath.startsWith(`${resolve(root)}${sep}`);
      const includedByVitest =
        /^(?:packages|test)\/.*\.test\.ts$/.test(testFile) ||
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
    const count = result.filesByUnit.get(unit.id)?.length ?? 0;
    return `| ${unit.id} | ${unit.status} | ${count} |`;
  });

  return [
    "## Control-flow migration",
    "",
    `- Capability units: ${summary.migratedUnits}/${summary.totalUnits} (${summary.migratedUnitPercentage}%)`,
    `- Production files: ${summary.migratedFiles}/${summary.totalFiles} (${summary.migratedFilePercentage}%)`,
    `- Policy: ${result.errors.length === 0 ? "passing" : `failing (${result.errors.length} errors)`}`,
    "",
    "| Capability unit | Status | Files |",
    "| --- | --- | ---: |",
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

  if (!isRecord(value) || !isRecord(value.recordedProgress) || !Array.isArray(value.units)) {
    throw new TypeError("Control-flow policy must contain recordedProgress and units.");
  }

  const units = value.units.map((unit, index) => {
    if (!isRecord(unit) || typeof unit.id !== "string" || typeof unit.status !== "string") {
      throw new TypeError(`units[${index}] must contain string id and status fields.`);
    }

    /** @type {ControlFlowUnit} */
    const parsed = { id: unit.id, status: unit.status };

    if (unit.files !== undefined) {
      parsed.files = readStringArray(unit.files, `units[${index}].files`);
    }
    if (unit.pathPrefixes !== undefined) {
      parsed.pathPrefixes = readStringArray(unit.pathPrefixes, `units[${index}].pathPrefixes`);
    }
    if (unit.evidence !== undefined) {
      if (!isRecord(unit.evidence)) {
        throw new TypeError(`units[${index}].evidence must be an object.`);
      }
      parsed.evidence = {
        definitionVersion: readNumber(
          unit.evidence.definitionVersion,
          `units[${index}].evidence.definitionVersion`,
        ),
        testFiles: readStringArray(unit.evidence.testFiles, `units[${index}].evidence.testFiles`),
      };
    }

    return parsed;
  });

  return {
    definitionOfMigrated: readStringArray(value.definitionOfMigrated, "definitionOfMigrated"),
    definitionVersion: readNumber(value.definitionVersion, "definitionVersion"),
    excludedFiles: readStringArray(value.excludedFiles, "excludedFiles"),
    excludedFileSuffixes: readStringArray(value.excludedFileSuffixes, "excludedFileSuffixes"),
    recordedProgress: {
      migratedFiles: readNumber(
        value.recordedProgress.migratedFiles,
        "recordedProgress.migratedFiles",
      ),
      migratedUnits: readNumber(
        value.recordedProgress.migratedUnits,
        "recordedProgress.migratedUnits",
      ),
      totalFiles: readNumber(value.recordedProgress.totalFiles, "recordedProgress.totalFiles"),
      totalUnits: readNumber(value.recordedProgress.totalUnits, "recordedProgress.totalUnits"),
    },
    schemaVersion: readNumber(value.schemaVersion, "schemaVersion"),
    sourceRoots: readStringArray(value.sourceRoots, "sourceRoots"),
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

/**
 * @param {string} reference
 * @returns {{files: string[], policy: ControlFlowPolicy} | undefined}
 */
function loadBaseControlFlowPolicy(reference) {
  const commit = spawnSync("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  if (commit.status !== 0) {
    throw new Error(`Control-flow base reference is unavailable: ${reference}.`);
  }

  const policy = spawnSync("git", ["show", `${reference}:scripts/control-flow-policy.json`], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  if (policy.status !== 0) {
    return undefined;
  }

  const parsedPolicy = parseControlFlowPolicy(policy.stdout);
  return {
    files: discoverControlFlowFilesAtReference(parsedPolicy, reference),
    policy: parsedPolicy,
  };
}

function run() {
  const acceptedArguments = new Set(["--check", "--report"]);
  const argument = process.argv[2] ?? "--check";

  if (!acceptedArguments.has(argument) || process.argv.length > 3) {
    console.error("Usage: node scripts/control-flow-policy.mjs [--check|--report]");
    process.exit(2);
  }

  const policy = loadControlFlowPolicy();
  const files = discoverControlFlowFiles(policy);
  const result = evaluateControlFlowPolicy(policy, files);
  result.errors.push(...verifyControlFlowEvidence(policy));
  const baseReference = process.env.CONTROL_FLOW_BASE_REF;

  if (baseReference && !/^0+$/.test(baseReference)) {
    const base = loadBaseControlFlowPolicy(baseReference);
    if (base) {
      const existingFiles = new Set(
        base.files.filter((file) => existsSync(resolve(repositoryRoot, file))),
      );
      result.errors.push(
        ...compareControlFlowProgress(policy, base.policy, files, base.files, existingFiles),
      );
    }
  }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
