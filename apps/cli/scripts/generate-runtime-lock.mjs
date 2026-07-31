import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(
  await readFile(resolve(packageDirectory, "package.json"), "utf8"),
);
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "crewhelm-runtime-lock-"));
const runtimeManifest = {
  name: packageManifest.name,
  version: packageManifest.version,
  license: packageManifest.license,
  type: packageManifest.type,
  bin: packageManifest.bin,
  dependencies: packageManifest.dependencies,
  engines: packageManifest.engines,
};

try {
  await writeFile(
    resolve(temporaryDirectory, "package.json"),
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    { mode: 0o600 },
  );

  const install = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--package-lock-only", "--omit=dev", "--workspaces=false"],
    {
      cwd: temporaryDirectory,
      env: process.env,
      stdio: "inherit",
    },
  );

  if (install.error) {
    throw install.error;
  }

  if (install.status !== 0) {
    process.exit(install.status ?? 1);
  }

  const lock = JSON.parse(await readFile(resolve(temporaryDirectory, "package-lock.json"), "utf8"));
  await writeFile(
    resolve(packageDirectory, "npm-shrinkwrap.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    { mode: 0o644 },
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
