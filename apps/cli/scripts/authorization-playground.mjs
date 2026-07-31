import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const portFlagIndex = process.argv.indexOf("--port");
const requestedPort = portFlagIndex === -1 ? 4_173 : Number(process.argv[portFlagIndex + 1]);

if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65_535) {
  throw new Error("Authorization playground port must be an integer from 1 through 65535.");
}

const outputDirectory = await mkdtemp(join(tmpdir(), "crewhelm-authorization-playground-"));
const outputPath = join(outputDirectory, "server.mjs");

process.once("exit", () => {
  rmSync(outputDirectory, { force: true, recursive: true });
});

await build({
  bundle: true,
  format: "esm",
  stdin: {
    contents: `
import { startAuthorizationPlayground } from "./apps/cli/src/authorization-playground.ts";
import {
  CLI_AUTHORIZATION_PLAYGROUND_PAGES,
  CLI_AUTHORIZATION_PLAYGROUND_STYLES,
} from "./apps/cli/src/authorization-playground-pages.ts";
import {
  WORKER_AUTHORIZATION_PLAYGROUND_ACTIONS_SCRIPT,
  WORKER_AUTHORIZATION_PLAYGROUND_PAGES,
  WORKER_AUTHORIZATION_PLAYGROUND_STYLES,
} from "./apps/worker/src/http/authorization-playground-pages.ts";

export function startPlayground(port) {
  if (CLI_AUTHORIZATION_PLAYGROUND_STYLES !== WORKER_AUTHORIZATION_PLAYGROUND_STYLES) {
    throw new Error("Authorization page styles are not synchronized.");
  }

  return startAuthorizationPlayground({
    actionsScript: WORKER_AUTHORIZATION_PLAYGROUND_ACTIONS_SCRIPT,
    pages: [...WORKER_AUTHORIZATION_PLAYGROUND_PAGES, ...CLI_AUTHORIZATION_PLAYGROUND_PAGES],
    port,
    styles: WORKER_AUTHORIZATION_PLAYGROUND_STYLES,
  });
}
`,
    loader: "ts",
    resolveDir: repositoryDirectory,
    sourcefile: "authorization-playground-entry.ts",
  },
  outfile: outputPath,
  platform: "node",
  target: "node24",
});

const { startPlayground } = await import(pathToFileURL(outputPath).href);
const playground = await startPlayground(requestedPort);
let stopping = false;

process.stdout.write(`Crewhelm authorization playground: ${playground.url.href}\n`);
process.stdout.write("Press Ctrl+C to stop.\n");

async function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  await playground.close();
  await rm(outputDirectory, { force: true, recursive: true });
}

process.once("SIGINT", () => {
  void stop().then(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().then(() => process.exit(0));
});
