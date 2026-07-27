import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const workerRoot = fileURLToPath(new URL("../", import.meta.url));
const journalUrl = new URL("../control-plane-migrations/meta/_journal.json", import.meta.url);
const manifestUrl = new URL("../control-plane-migrations/index.ts", import.meta.url);

function migrationEntries() {
  const journal = JSON.parse(readFileSync(journalUrl, "utf8"));

  if (
    journal?.dialect !== "sqlite" ||
    !Array.isArray(journal.entries) ||
    journal.entries.some(
      (entry, index) =>
        entry?.idx !== index ||
        typeof entry.tag !== "string" ||
        !/^\d{4}_[a-z0-9_]+$/.test(entry.tag),
    )
  ) {
    throw new Error("Invalid control-plane migration journal.");
  }

  return journal.entries;
}

export function bundleControlPlaneMigrations() {
  const entries = migrationEntries();
  const imports = entries
    .map((entry) => `import migration${entry.idx} from "./${entry.tag}.sql";`)
    .join("\n");
  const migrations = entries
    .map(
      (entry) => `  {
    name: "${entry.tag}",
    sql: migration${entry.idx},
    version: ${entry.idx + 1},
  },`,
    )
    .join("\n");

  writeFileSync(
    manifestUrl,
    `${imports}

export const controlPlaneMigrations = [
${migrations}
] as const;

export const CONTROL_PLANE_SCHEMA_VERSION = controlPlaneMigrations.length;
`,
  );
}

function generate() {
  const packageManager = process.env.npm_execpath;

  if (!packageManager) {
    throw new Error("Run migration generation through pnpm.");
  }

  const result = spawnSync(
    process.execPath,
    [
      packageManager,
      "exec",
      "drizzle-kit",
      "generate",
      "--config",
      "drizzle.control-plane.config.ts",
    ],
    {
      cwd: workerRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  bundleControlPlaneMigrations();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generate();
}
