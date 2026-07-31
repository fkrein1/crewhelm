#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import { openInCodexBrowser } from "./codex-browser.js";
import { openInDefaultBrowser, promptSecret, promptText } from "./interactive.js";
import { createWranglerRunner } from "./wrangler.js";

const cliArguments = process.argv.slice(2);
const interactive = process.stdin.isTTY && process.stdout.isTTY;
const color =
  interactive && process.env.NO_COLOR === undefined && !cliArguments.includes("--no-color");
const dependencies = {
  color,
  deploymentAssetsDirectory: fileURLToPath(new URL("./deployment", import.meta.url)),
  fetch: globalThis.fetch,
  interactive,
  liveProgress: interactive && process.stderr.isTTY,
  openCodexUrl: (url: URL) =>
    openInCodexBrowser(url, { writeError: (text) => process.stderr.write(text) }),
  openUrl: openInDefaultBrowser,
  ...(interactive ? { promptSecret, promptText } : {}),
  readEnvironment: (name: string) => process.env[name],
  runWrangler: createWranglerRunner(process.env),
  writeError: (text: string) => process.stderr.write(text),
  writeOutput: (text: string) => process.stdout.write(text),
};

process.exitCode = await runCli(cliArguments, dependencies);
