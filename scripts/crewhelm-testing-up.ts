import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, appendFile, chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";

import { readInstallation, writeInstallation } from "../apps/cli/src/installation.js";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryDirectory = path.join(repositoryRoot, "apps", "registry");
const installationPath = path.join(repositoryRoot, "crewhelm.testing.installation.json");
const registryOrigin = "https://crewhelm-registry-dev.fkrein.workers.dev/";
const jsonOutput = process.argv.slice(2).includes("--json");

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload.`);
  }
  return Object.fromEntries(Object.entries(value));
}

if (process.argv.slice(2).some((argument) => argument !== "--json") || process.argv.length > 3) {
  throw new Error(`Unknown testing setup argument: ${process.argv.slice(2).join(" ")}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function mainWorktreeRoot(): Promise<string> {
  const { stdout } = await executeFile("git", ["rev-parse", "--git-common-dir"], {
    cwd: repositoryRoot,
  });
  return path.dirname(path.resolve(repositoryRoot, stdout.trim()));
}

async function prepareWorktreeContext(): Promise<string> {
  const mainRoot = await mainWorktreeRoot();
  if (!(await exists(installationPath))) {
    const source = path.join(mainRoot, "crewhelm.testing.installation.json");
    const installation = await readInstallation(source);
    if (installation === undefined) {
      throw new Error("The main worktree has no testing installation metadata.");
    }
    await writeInstallation(installationPath, installation);
  }

  const mainEnvironment = path.join(mainRoot, ".env.test.local");
  if (await exists(mainEnvironment)) process.loadEnvFile(mainEnvironment);
  return mainEnvironment;
}

async function setupCredential(environmentPath: string): Promise<string> {
  const configured = process.env.TESTING_SETUP_SECRET;
  if (configured !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(configured)) {
      throw new Error("TESTING_SETUP_SECRET must be a 43-character base64url value.");
    }
    return configured;
  }

  const credential = randomBytes(32).toString("base64url");
  const needsLeadingNewline =
    (await exists(environmentPath)) && !(await readFile(environmentPath, "utf8")).endsWith("\n");
  await appendFile(
    environmentPath,
    `${needsLeadingNewline ? "\n" : ""}TESTING_SETUP_SECRET=${credential}\n`,
    { mode: 0o600 },
  );
  await chmod(environmentPath, 0o600);
  process.env.TESTING_SETUP_SECRET = credential;
  return credential;
}

function run(
  command: string,
  arguments_: string[],
  options: { cwd?: string; input?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, CI: "true" },
      stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? `exit ${String(code)}`}).`));
    });
    if (options.input !== undefined) child.stdin?.end(`${options.input}\n`);
  });
}

async function capture(
  command: string,
  arguments_: string[],
  cwd = repositoryRoot,
): Promise<string> {
  const { stdout } = await executeFile(command, arguments_, {
    cwd,
    env: { ...process.env, CI: "true" },
    maxBuffer: 16 * 1_024 * 1_024,
  });
  return stdout;
}

async function registryFingerprint(): Promise<string> {
  const inventory = await capture("rg", [
    "--files",
    "apps/registry/src",
    "apps/registry/migrations",
    "packages/contracts/src",
  ]);
  const files = [
    ...inventory.trim().split("\n").filter(Boolean),
    "apps/registry/package.json",
    "apps/registry/wrangler.jsonc",
    "apps/registry/wrangler.testing.jsonc",
  ].toSorted();
  const digest = createHash("sha256");
  for (const file of files) {
    const filePath = path.join(repositoryRoot, file);
    digest.update(file).update("\0");
    digest.update(await readFile(filePath));
  }
  return digest.digest("hex");
}

const testingEnvironmentPath = await prepareWorktreeContext();
const setupSecret = await setupCredential(testingEnvironmentPath);
delete process.env.TESTING_SETUP_SECRET;
await run("pnpm", ["build"]);
await run("pnpm", ["release:check"]);

const registryDigest = await registryFingerprint();
await run(
  "pnpm",
  [
    "exec",
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "REGISTRY_DB",
    "--remote",
    "--config",
    "wrangler.testing.jsonc",
  ],
  { cwd: registryDirectory },
);
await run(
  "pnpm",
  [
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.testing.jsonc",
    "--var",
    `REGISTRY_DEPLOYMENT_FINGERPRINT:${registryDigest}`,
  ],
  { cwd: registryDirectory },
);

async function requestSeed(attempts: number): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetch(new URL("development/seed", registryOrigin), {
      headers: { authorization: `Bearer ${setupSecret}` },
      method: "POST",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status !== 403 || attempt === attempts - 1) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (response === undefined) throw new Error("Testing Registry seed was not attempted.");
  return response;
}

let seedResponse = await requestSeed(5);
if (seedResponse.status === 403) {
  await run(
    "pnpm",
    [
      "exec",
      "wrangler",
      "secret",
      "put",
      "TESTING_SETUP_SECRET",
      "--config",
      "wrangler.testing.jsonc",
    ],
    { cwd: registryDirectory, input: setupSecret },
  );
  seedResponse = await requestSeed(60);
}
if (!seedResponse.ok) {
  throw new Error(`Testing Registry seed failed (${String(seedResponse.status)}).`);
}
const seed = object(await seedResponse.json(), "Testing Registry seed");
if (seed.seeded !== 10 || seed.namespace !== "crewhelm-labs") {
  throw new Error("Testing Registry did not reconcile the expected ten Recipes.");
}

const cliOutput = await capture("node", [
  "apps/cli/dist/crewhelm.js",
  "up",
  "--installation",
  "crewhelm.testing.installation.json",
  "--recipe-registry-origin",
  registryOrigin,
  "--browser",
  "none",
  "--testing-installation",
  "--json",
]);
const deployment = object(JSON.parse(cliOutput) as unknown, "Testing MCP deployment");
const deploymentCoordinate = object(deployment.deployment, "Testing MCP coordinate");
const doctor = object(deployment.doctor, "Testing MCP diagnosis");
if (
  deployment.ok !== true ||
  doctor.ok !== true ||
  deploymentCoordinate.workerName !== "crewhelm-testing"
) {
  throw new Error("Testing MCP deployment did not reconcile cleanly.");
}

const installation = await readInstallation(installationPath);
if (
  installation?.recipeRegistryOrigin !== registryOrigin ||
  installation.testingInstallation !== true
) {
  throw new Error("Testing installation is not pinned to the testing Registry.");
}
const health = await fetch(new URL("health", registryOrigin), {
  signal: AbortSignal.timeout(10_000),
});
const healthBody = object(await health.json(), "Testing Registry health");
if (
  !health.ok ||
  healthBody.status !== "ok" ||
  healthBody.deploymentFingerprint !== registryDigest
) {
  throw new Error("Testing Registry deployment fingerprint did not reconcile.");
}
const search = await fetch(
  new URL("api/registry/v1/recipes/search?q=decision+memo&limit=10", registryOrigin),
  { signal: AbortSignal.timeout(10_000) },
);
if (!search.ok) throw new Error("Testing Registry search diagnosis failed.");

const report = {
  mcp: { origin: installation.origin, status: "ready", workerName: installation.workerName },
  ok: true,
  registry: {
    deploymentFingerprint: registryDigest,
    origin: registryOrigin,
    seededRecipes: 10,
    status: "ready",
  },
  schemaVersion: 1,
};
if (jsonOutput) console.log(JSON.stringify(report));
else {
  console.log("Crewhelm testing installation is ready.");
  console.log(`  MCP:      ${report.mcp.origin}`);
  console.log(
    `  Registry: ${report.registry.origin} (${String(report.registry.seededRecipes)} Recipes)`,
  );
}
