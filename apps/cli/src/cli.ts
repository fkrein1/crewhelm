import * as z from "zod";

import {
  diagnoseDeployment,
  DoctorInputError,
  parseDeploymentOrigin,
  type DoctorDependencies,
  type DoctorReport,
} from "./doctor.js";

export const CLI_HELP = `Crewhelm bootstrap CLI

Usage:
  crewhelm doctor --endpoint <origin> [--timeout-ms <milliseconds>] [--json]
  crewhelm --help

The doctor command validates bounded health and MCP OAuth discovery responses.
--timeout-ms applies to each request.
HTTPS is required except for exact loopback hosts.
`;

const cliCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("help"),
  }),
  z.strictObject({
    json: z.boolean(),
    kind: z.literal("doctor"),
    origin: z.instanceof(URL),
    timeoutMs: z.number().int().min(100).max(30_000),
  }),
]);

export type CliCommand = z.infer<typeof cliCommandSchema>;

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function requireFlagValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];

  if (!value || value.startsWith("--")) {
    throw new CliUsageError(`${flag} requires a value.`);
  }

  return value;
}

export function parseCli(arguments_: readonly string[]): CliCommand {
  if (
    arguments_.length === 0 ||
    arguments_[0] === "--help" ||
    arguments_[0] === "-h" ||
    (arguments_[0] === "doctor" && arguments_.includes("--help"))
  ) {
    return { kind: "help" };
  }

  if (arguments_[0] !== "doctor") {
    throw new CliUsageError("Unknown command.");
  }

  let endpoint: string | undefined;
  let json = false;
  let timeoutMs: number = 5_000;
  const seenFlags = new Set<string>();

  for (let index = 1; index < arguments_.length; index += 1) {
    const flag = arguments_[index];

    if (!flag?.startsWith("--")) {
      throw new CliUsageError("Unexpected positional argument.");
    }

    if (seenFlags.has(flag)) {
      throw new CliUsageError("A flag was provided more than once.");
    }

    seenFlags.add(flag);

    if (flag === "--json") {
      json = true;
      continue;
    }

    if (flag === "--endpoint") {
      endpoint = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--timeout-ms") {
      const value = requireFlagValue(arguments_, index, flag);
      timeoutMs = Number(value);
      index += 1;
      continue;
    }

    throw new CliUsageError("Unknown flag.");
  }

  if (!endpoint) {
    throw new CliUsageError("doctor requires --endpoint.");
  }

  let origin: URL;

  try {
    origin = parseDeploymentOrigin(endpoint);
  } catch (error) {
    if (error instanceof DoctorInputError) {
      throw new CliUsageError(error.message);
    }

    throw error;
  }

  const command = cliCommandSchema.safeParse({
    json,
    kind: "doctor",
    origin,
    timeoutMs,
  });

  if (!command.success) {
    throw new CliUsageError("--timeout-ms must be an integer from 100 through 30000.");
  }

  return command.data;
}

export interface CliDependencies extends DoctorDependencies {
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

function formatHumanReport(report: DoctorReport): string {
  return report.checks
    .map((check) => {
      const prefix = check.status === "pass" ? "PASS" : "FAIL";
      return `${prefix} ${check.name} ${check.endpoint}\n${check.message}\n`;
    })
    .join("");
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  let command: CliCommand;

  try {
    command = parseCli(arguments_);
  } catch (error) {
    if (error instanceof CliUsageError) {
      dependencies.writeError(`Error: ${error.message}\n\n${CLI_HELP}`);
      return 2;
    }

    throw error;
  }

  if (command.kind === "help") {
    dependencies.writeOutput(CLI_HELP);
    return 0;
  }

  const report = await diagnoseDeployment(command, dependencies);
  dependencies.writeOutput(
    command.json ? `${JSON.stringify(report)}\n` : formatHumanReport(report),
  );
  return report.ok ? 0 : 1;
}
