#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import { createWranglerRunner } from "./wrangler.js";

process.exitCode = await runCli(process.argv.slice(2), {
  deploymentAssetsDirectory: fileURLToPath(new URL("./deployment", import.meta.url)),
  fetch: globalThis.fetch,
  readEnvironment: (name) => process.env[name],
  runWrangler: createWranglerRunner(process.env),
  writeError: (text) => process.stderr.write(text),
  writeOutput: (text) => process.stdout.write(text),
});
