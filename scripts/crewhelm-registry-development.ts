import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryDirectory = path.join(repositoryRoot, "apps", "registry");
const stateDirectory = path.join(repositoryRoot, ".wrangler", "registry-local");
const origin = "http://127.0.0.1:8788";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Local Registry seed returned an invalid payload.");
  }
  return Object.fromEntries(Object.entries(value));
}

function run(arguments_: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", arguments_, {
      cwd: registryDirectory,
      env: { ...process.env, CI: "true" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Registry setup failed (${signal ?? `exit ${String(code)}`}).`));
    });
  });
}

async function waitUntilReady(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Local Registry did not become ready.");
}

await run([
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "REGISTRY_DB",
  "--local",
  "--config",
  "wrangler.local.jsonc",
  "--persist-to",
  stateDirectory,
]);

const worker = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    "wrangler.local.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--persist-to",
    stateDirectory,
  ],
  { cwd: registryDirectory, stdio: "inherit" },
);

const stopped = new Promise<number>((resolve, reject) => {
  worker.once("error", reject);
  worker.once("exit", (code) => {
    resolve(code ?? 1);
  });
});
const stop = () => worker.kill("SIGINT");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await waitUntilReady();
  const response = await fetch(`${origin}/development/seed`, { method: "POST" });
  if (!response.ok) throw new Error(`Local Registry seed failed (${String(response.status)}).`);
  const seed = object(await response.json());
  if (seed.seeded !== 10 || seed.namespace !== "crewhelm-labs") {
    throw new Error("Local Registry did not reconcile the expected ten Recipes.");
  }
  console.log("Seeded 10 Recipes in crewhelm-labs.");
  console.log(`Registry ready: ${origin}/api/registry/v1/recipes/search?q=decision`);
  process.exitCode = await stopped;
} catch (error) {
  stop();
  await stopped;
  throw error;
}
