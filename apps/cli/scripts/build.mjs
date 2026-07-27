import { spawnSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { experimental_readRawConfig } from "wrangler";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const workerDirectory = resolve(repositoryDirectory, "apps/worker");
const workerConfigPath = resolve(workerDirectory, "wrangler.jsonc");
const outputDirectory = resolve(packageDirectory, "dist");
const deploymentDirectory = resolve(outputDirectory, "deployment");
const require = createRequire(import.meta.url);
const wranglerPackagePath = require.resolve("wrangler/package.json");
const wranglerBinPath = resolve(dirname(wranglerPackagePath), "bin/wrangler.js");
const workerBuildEnvironment = {
  CI: "true",
  PATH: dirname(process.execPath),
  WRANGLER_SEND_METRICS: "false",
};

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(deploymentDirectory, { recursive: true });

const workerBuild = spawnSync(
  process.execPath,
  [
    wranglerBinPath,
    "deploy",
    "--config",
    workerConfigPath,
    "--dry-run",
    "--outdir",
    deploymentDirectory,
  ],
  {
    cwd: deploymentDirectory,
    env: workerBuildEnvironment,
    stdio: "inherit",
  },
);

if (workerBuild.error) {
  throw workerBuild.error;
}

if (workerBuild.status !== 0) {
  process.exit(workerBuild.status ?? 1);
}

await rm(resolve(deploymentDirectory, "README.md"), { force: true });

const { rawConfig } = experimental_readRawConfig({ config: workerConfigPath });
delete rawConfig.$schema;
rawConfig.main = "./index.js";
rawConfig.d1_databases = rawConfig.d1_databases?.map((database) => ({
  ...database,
  migrations_dir: "./migrations",
}));

await writeFile(
  resolve(deploymentDirectory, "wrangler-template.json"),
  `${JSON.stringify(rawConfig, null, 2)}\n`,
  { mode: 0o600 },
);
await cp(resolve(workerDirectory, "migrations"), resolve(deploymentDirectory, "migrations"), {
  recursive: true,
});

await build({
  bundle: true,
  entryPoints: [resolve(packageDirectory, "src/index.ts")],
  format: "esm",
  outfile: resolve(outputDirectory, "crewhelm.js"),
  platform: "node",
  target: "node24",
});
