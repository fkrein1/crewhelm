import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const workspaceBuildArguments = Object.freeze([
  "--filter=!crewhelm-monorepo",
  "--workspace-concurrency=1",
  "--if-present",
  "run",
  "build",
]);

function run() {
  const packageManager = process.env.npm_execpath;

  if (!packageManager) {
    throw new Error("Run workspace builds through pnpm.");
  }

  const result = spawnSync(process.execPath, [packageManager, ...workspaceBuildArguments], {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
