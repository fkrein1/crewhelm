import * as z from "zod";

import {
  bootstrapDeployment,
  BootstrapError,
  bootstrapOptionsSchema,
  createBootstrapFailure,
  type BootstrapDependencies,
  type BootstrapFailure,
  type BootstrapReport,
} from "./bootstrap.js";
import {
  diagnoseDeployment,
  DoctorInputError,
  parseDeploymentOrigin,
  type DoctorReport,
} from "./doctor.js";

export const CLI_HELP = `Crewhelm bootstrap CLI

Usage:
  crewhelm bootstrap --endpoint <origin> [--account-id <id>] [--worker-name <name>] [--database-name <name>] [--database-id <uuid>] [--ai-budget-usd <dollars>] [--timeout-ms <milliseconds>] [--json]
  crewhelm doctor --endpoint <origin> [--timeout-ms <milliseconds>] [--json]
  crewhelm --help

The bootstrap command creates or reuses D1, deploys the packaged Worker, and diagnoses it.
New deployments read GitHub OAuth settings from CREWHELM_GITHUB_CLIENT_ID,
CREWHELM_GITHUB_CLIENT_SECRET, and CREWHELM_OWNER_GITHUB_USER_ID, plus the Composio project key
from CREWHELM_COMPOSIO_API_KEY.
Set CREWHELM_CLOUDFLARE_API_TOKEN to a scoped account token with AI Gateway Read and Edit when the
Wrangler OAuth credential cannot manage Gateways.
The doctor command validates bounded health and MCP OAuth discovery responses.
--timeout-ms applies to each diagnostic request.
Bootstrap requires HTTPS. Doctor permits HTTP only for exact loopback hosts.
`;

const cliCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("help"),
  }),
  z.strictObject({
    accountId: bootstrapOptionsSchema.shape.accountId,
    aiDailySpendUsd: bootstrapOptionsSchema.shape.aiDailySpendUsd,
    databaseId: bootstrapOptionsSchema.shape.databaseId,
    databaseName: bootstrapOptionsSchema.shape.databaseName,
    json: z.boolean(),
    kind: z.literal("bootstrap"),
    origin: bootstrapOptionsSchema.shape.origin,
    timeoutMs: bootstrapOptionsSchema.shape.timeoutMs,
    workerName: bootstrapOptionsSchema.shape.workerName,
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
    ((arguments_[0] === "bootstrap" || arguments_[0] === "doctor") && arguments_.includes("--help"))
  ) {
    return { kind: "help" };
  }

  if (arguments_[0] !== "bootstrap" && arguments_[0] !== "doctor") {
    throw new CliUsageError("Unknown command.");
  }

  const kind = arguments_[0];
  let accountId: string | undefined;
  let aiDailySpendUsd: number | undefined;
  let databaseId: string | undefined;
  let databaseName = "crewhelm-auth";
  let endpoint: string | undefined;
  let json = false;
  let timeoutMs: number = 5_000;
  let workerName = "crewhelm";
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

    if (flag === "--account-id" && kind === "bootstrap") {
      accountId = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--ai-budget-usd" && kind === "bootstrap") {
      aiDailySpendUsd = Number(requireFlagValue(arguments_, index, flag));
      index += 1;
      continue;
    }

    if (flag === "--database-id" && kind === "bootstrap") {
      databaseId = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--database-name" && kind === "bootstrap") {
      databaseName = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--timeout-ms") {
      const value = requireFlagValue(arguments_, index, flag);
      timeoutMs = Number(value);
      index += 1;
      continue;
    }

    if (flag === "--worker-name" && kind === "bootstrap") {
      workerName = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    throw new CliUsageError("Unknown flag.");
  }

  if (!endpoint) {
    throw new CliUsageError(`${kind} requires --endpoint.`);
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

  if (kind === "bootstrap" && origin.protocol !== "https:") {
    throw new CliUsageError("bootstrap requires an HTTPS endpoint.");
  }

  const command =
    kind === "bootstrap"
      ? cliCommandSchema.safeParse({
          accountId,
          aiDailySpendUsd,
          databaseId,
          databaseName,
          json,
          kind,
          origin,
          timeoutMs,
          workerName,
        })
      : cliCommandSchema.safeParse({
          json,
          kind,
          origin,
          timeoutMs,
        });

  if (!command.success) {
    throw new CliUsageError(
      "A timeout, account ID, database ID, or deployment name was invalid. Names use lowercase letters, numbers, and hyphens.",
    );
  }

  return command.data;
}

export interface CliDependencies extends BootstrapDependencies {
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

function formatDoctorReport(report: DoctorReport): string {
  return report.checks
    .map((check) => {
      const prefix = check.status === "pass" ? "PASS" : "FAIL";
      return `${prefix} ${check.name} ${check.endpoint}\n${check.message}\n`;
    })
    .join("");
}

function formatBootstrapReport(report: BootstrapReport): string {
  const databaseVerb = report.database.action === "created" ? "Created" : "Reused";
  const deploymentVerb = report.deployment.action === "created" ? "Created" : "Updated";

  return `Using Cloudflare account ${report.account.id}.\n${databaseVerb} D1 database ${report.database.name} (${report.database.id}).\n${deploymentVerb} Worker ${report.deployment.workerName} at ${report.deployment.origin}.\n${formatDoctorReport(report.doctor)}`;
}

function formatBootstrapFailure(failure: BootstrapFailure): string {
  return `FAIL bootstrap-${failure.stage}\n${failure.message}\n`;
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

  if (command.kind === "bootstrap") {
    try {
      const report = await bootstrapDeployment(command, dependencies);
      dependencies.writeOutput(
        command.json ? `${JSON.stringify(report)}\n` : formatBootstrapReport(report),
      );
      return report.ok ? 0 : 1;
    } catch (error) {
      if (error instanceof BootstrapError) {
        const failure = createBootstrapFailure(error);
        dependencies.writeError(
          command.json ? `${JSON.stringify(failure)}\n` : formatBootstrapFailure(failure),
        );
        return 1;
      }

      throw error;
    }
  }

  const report = await diagnoseDeployment(command, dependencies);
  dependencies.writeOutput(
    command.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report),
  );
  return report.ok ? 0 : 1;
}
