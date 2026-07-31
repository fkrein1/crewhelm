import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { validateToolchain } from "./toolchain-policy.mjs";

export const verificationChecks = Object.freeze([
  "format:check",
  "lint",
  "typecheck",
  "test",
  "build",
  "release:check",
]);

function run() {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const expectedNodeVersion = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
  const packageManager = process.env.npm_execpath;
  const errors = validateToolchain({
    actualNodeVersion: process.versions.node,
    expectedNodeVersion,
    expectedPackageManager: manifest.packageManager,
    packageManagerExecutable: packageManager,
    userAgent: process.env.npm_config_user_agent,
  });

  if (errors.length > 0) {
    console.error(`Toolchain policy failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exit(1);
  }

  if (!packageManager) {
    throw new Error("The validated package-manager executable is unavailable.");
  }

  for (const check of verificationChecks) {
    const result = spawnSync(process.execPath, [packageManager, "run", check], {
      env: process.env,
      stdio: "inherit",
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
