#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import { requestCloudflareGatewayAuthorization } from "./cloudflare-gateway-authorization.js";
import { createGitHubApp } from "./github-app.js";
import { openInDefaultBrowser, promptSecret, promptText } from "./interactive.js";
import { createCliTextStyle } from "./presentation.js";
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
  openUrl: openInDefaultBrowser,
  ...(interactive ? { promptSecret, promptText } : {}),
  readEnvironment: (name: string) => process.env[name],
  runWrangler: createWranglerRunner(process.env),
  writeError: (text: string) => process.stderr.write(text),
  writeOutput: (text: string) => process.stdout.write(text),
};

process.exitCode = await runCli(cliArguments, {
  ...dependencies,
  ...(interactive
    ? {
        createGitHubApp: (options: { origin: URL; workerName: string }) =>
          createGitHubApp(options, {
            fetch: dependencies.fetch,
            openUrl: dependencies.openUrl,
            writeOutput: dependencies.writeOutput,
          }),
        requestCloudflareGatewayAuthorization: (request: {
          accountId: string;
          canSkip: boolean;
          dailySpendUsd: number;
          workerName: string;
        }) =>
          requestCloudflareGatewayAuthorization(request, {
            openUrl: openInDefaultBrowser,
            promptSecret,
            promptText,
            style: createCliTextStyle(color),
            writeOutput: dependencies.writeOutput,
          }),
      }
    : {}),
});
