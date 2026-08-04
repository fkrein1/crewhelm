import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const explicitEnvironmentIndex = process.argv.indexOf("--env");
const explicitEnvironment =
  explicitEnvironmentIndex === -1 ? undefined : process.argv[explicitEnvironmentIndex + 1];
const environment =
  explicitEnvironment ??
  process.env.CLOUDFLARE_ENV ??
  (process.env.WORKERS_CI_BRANCH && process.env.WORKERS_CI_BRANCH !== "main"
    ? "preview"
    : "production");

if (environment !== "preview" && environment !== "production") {
  throw new Error(`Unsupported site environment: ${environment}`);
}

const siteDirectory = fileURLToPath(new URL("../apps/site/", import.meta.url));
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {Record<string, string>} [extraEnvironment]
 */
function run(command, args, cwd = siteDirectory, extraEnvironment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "astro", "build"], siteDirectory, { CLOUDFLARE_ENV: environment });
run(process.execPath, ["scripts/validate-site-output.mjs", "apps/site/dist"], repositoryDirectory);
run("pnpm", [
  "exec",
  "wrangler",
  "deploy",
  "--dry-run",
  "--env",
  environment,
  "--outdir",
  "worker-dist",
]);
