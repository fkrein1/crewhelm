import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const siteDirectory = fileURLToPath(new URL("../apps/site/", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(command, args, cwd = siteDirectory) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "astro", "build"]);
run(process.execPath, ["scripts/validate-site-output.mjs", "apps/site/dist"], repositoryDirectory);
run("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", "worker-dist"]);
