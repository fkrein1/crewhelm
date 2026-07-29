#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import { createGitHubApp } from "./github-app.js";
import { openInDefaultBrowser, promptSecret, promptText } from "./interactive.js";
import { createWranglerRunner } from "./wrangler.js";

const interactive = process.stdin.isTTY && process.stdout.isTTY;
const dependencies = {
  color: interactive && process.env.NO_COLOR === undefined,
  deploymentAssetsDirectory: fileURLToPath(new URL("./deployment", import.meta.url)),
  fetch: globalThis.fetch,
  interactive,
  openUrl: openInDefaultBrowser,
  ...(interactive ? { promptSecret, promptText } : {}),
  readEnvironment: (name: string) => process.env[name],
  runWrangler: createWranglerRunner(process.env),
  writeError: (text: string) => process.stderr.write(text),
  writeOutput: (text: string) => process.stdout.write(text),
};

process.exitCode = await runCli(process.argv.slice(2), {
  ...dependencies,
  ...(interactive
    ? {
        createGitHubApp: (options: { origin: URL; workerName: string }) =>
          createGitHubApp(options, {
            fetch: dependencies.fetch,
            openUrl: dependencies.openUrl,
            writeOutput: dependencies.writeOutput,
          }),
        openCloudflareApiTokens: () =>
          openInDefaultBrowser(new URL("https://dash.cloudflare.com/profile/api-tokens")),
      }
    : {}),
});
