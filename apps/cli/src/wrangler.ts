import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { Readable } from "node:stream";

const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const WRANGLER_TIMEOUT_MS = 300_000;
const TERMINATION_GRACE_MS = 5_000;
const ALLOWED_ENVIRONMENT_NAMES = [
  "APPDATA",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_EMAIL",
  "HOME",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CONFIG_HOME",
] as const;

export interface WranglerResult {
  exitCode: number;
  outcome: "completed" | "unknown";
  stderr: string;
  stdout: string;
}

export interface WranglerRunOptions {
  cwd: string;
}

export type RunWrangler = (
  arguments_: readonly string[],
  options: WranglerRunOptions,
) => Promise<WranglerResult>;

export class WranglerExecutionError extends Error {
  override readonly name = "WranglerExecutionError";
}

interface WranglerRunnerOptions {
  executablePath?: string;
  terminationGraceMs?: number;
  timeoutMs?: number;
}

function createChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {
    CI: "true",
    PATH: dirname(process.execPath),
    WRANGLER_SEND_METRICS: "false",
  };

  for (const name of ALLOWED_ENVIRONMENT_NAMES) {
    if (environment[name] !== undefined) {
      childEnvironment[name] = environment[name];
    }
  }

  return childEnvironment;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentSize: number): number {
  const nextSize = currentSize + chunk.byteLength;

  if (nextSize > MAX_COMMAND_OUTPUT_BYTES) {
    throw new WranglerExecutionError("Cloudflare command output exceeded the safety limit.");
  }

  chunks.push(chunk);
  return nextSize;
}

export function createWranglerRunner(
  environment: NodeJS.ProcessEnv,
  options: WranglerRunnerOptions = {},
): RunWrangler {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("wrangler/package.json");
  const executablePath = options.executablePath ?? resolve(dirname(packagePath), "bin/wrangler.js");
  const childEnvironment = createChildEnvironment(environment);
  const timeoutMs = options.timeoutMs ?? WRANGLER_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? TERMINATION_GRACE_MS;

  return (arguments_, runOptions) =>
    new Promise<WranglerResult>((resolveResult, reject) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;

      try {
        child = spawn(process.execPath, [executablePath, ...arguments_], {
          cwd: runOptions.cwd,
          env: childEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        reject(new WranglerExecutionError("Cloudflare command could not be started."));
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutSize = 0;
      let stderrSize = 0;
      let settled = false;
      let unknownOutcome = false;
      let escalation: NodeJS.Timeout | undefined;
      let terminationDeadline: NodeJS.Timeout | undefined;
      const finishWithError = (error: WranglerExecutionError) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(terminationDeadline);
        reject(error);
      };
      const terminate = (error: WranglerExecutionError) => {
        if (settled || unknownOutcome) {
          return;
        }

        unknownOutcome = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
        terminationDeadline = setTimeout(
          () =>
            finishWithError(
              new WranglerExecutionError(
                `${error.message} Process termination could not be confirmed; do not retry yet.`,
              ),
            ),
          terminationGraceMs * 2,
        );
      };
      const timeout = setTimeout(
        () => terminate(new WranglerExecutionError("Cloudflare command timed out.")),
        timeoutMs,
      );

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          stdoutSize = appendBounded(stdout, chunk, stdoutSize);
        } catch (error) {
          terminate(
            error instanceof WranglerExecutionError
              ? error
              : new WranglerExecutionError("Cloudflare command output could not be read."),
          );
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try {
          stderrSize = appendBounded(stderr, chunk, stderrSize);
        } catch (error) {
          terminate(
            error instanceof WranglerExecutionError
              ? error
              : new WranglerExecutionError("Cloudflare command output could not be read."),
          );
        }
      });
      child.on("error", () => {
        finishWithError(new WranglerExecutionError("Cloudflare command could not be started."));
      });
      child.on("close", (exitCode) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        clearTimeout(escalation);
        clearTimeout(terminationDeadline);
        resolveResult({
          exitCode: exitCode ?? 1,
          outcome: unknownOutcome ? "unknown" : "completed",
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
    });
}
