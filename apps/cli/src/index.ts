#!/usr/bin/env node

import { runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), {
  fetch: globalThis.fetch,
  writeError: (text) => process.stderr.write(text),
  writeOutput: (text) => process.stdout.write(text),
});
