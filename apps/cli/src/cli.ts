import * as z from "zod";

import {
  diagnoseAuthenticatedDeployment,
  type AuthenticatedDoctorReport,
} from "./authenticated-doctor.js";
import { agentSmokeReportSchema, runAgentSmoke, type AgentSmokeReport } from "./agent-smoke.js";
import {
  bootstrapDeployment,
  BootstrapError,
  bootstrapOptionsSchema,
  createBootstrapFailure,
  type BootstrapDependencies,
  type BootstrapFailure,
  type BootstrapOptions,
  type BootstrapReport,
  type ExistingInstallationCoordinates,
} from "./bootstrap.js";
import {
  diagnoseDeployment,
  DoctorInputError,
  parseDeploymentOrigin,
  type DoctorReport,
} from "./doctor.js";
import {
  installationSchema,
  readInstallation,
  writeInstallation,
  type Installation,
} from "./installation.js";

export const CLI_HELP = `Crewhelm CLI

Usage:
  crewhelm up [--endpoint <origin>] [--installation <path>] [--setup-github] [--account-id <id>] [--worker-name <name>] [--database-name <name>] [--database-id <uuid>] [--ai-budget-usd <dollars>] [--timeout-ms <milliseconds>] [--json]
  crewhelm doctor --endpoint <origin> [--authenticated] [--timeout-ms <milliseconds>] [--json]
  crewhelm smoke agent --endpoint <origin> --confirm-production [--run-timeout-ms <milliseconds>] [--timeout-ms <milliseconds>] [--json]
  crewhelm --help

The up command creates or safely upgrades one Crewhelm installation, preserving deployed secrets
and an existing AI Gateway route unless you explicitly change its budget. It saves non-secret
installation metadata locally so later upgrades need no repeated flags.
If metadata is missing for an existing Worker, up verifies and recovers its exact non-secret
coordinates before applying migrations or deploying.
Fresh installations create a private, zero-repository-permission GitHub App in your browser and
prompt for the Composio project key without echoing it. Interactive setup also recommends an
optional Cloudflare AI Gateway hard spend limit; you choose the daily USD amount or skip it.
Use --setup-github to rotate the GitHub App.
For unattended setup, provide CREWHELM_GITHUB_CLIENT_ID, CREWHELM_GITHUB_CLIENT_SECRET,
CREWHELM_OWNER_GITHUB_USER_ID, and CREWHELM_COMPOSIO_API_KEY.
Set CREWHELM_CLOUDFLARE_API_TOKEN to a scoped account token with AI Gateway Edit when the
Wrangler OAuth credential cannot manage Gateways.
The doctor command validates bounded health and MCP OAuth discovery responses.
Use --authenticated to open the browser, verify temporary view-only owner access and fleet status,
and verify diagnostic-token revocation before exit.
The smoke agent command is an explicit mutating production rehearsal. It requests temporary Full
control, runs one zero-grant disposable Agent, disables it, and verifies token revocation.
--timeout-ms applies to each diagnostic request.
Up requires HTTPS. Doctor permits HTTP only for exact loopback hosts.
`;

const cliCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("help"),
  }),
  z.strictObject({
    accountId: bootstrapOptionsSchema.shape.accountId,
    aiDailySpendUsd: bootstrapOptionsSchema.shape.aiDailySpendUsd,
    databaseId: bootstrapOptionsSchema.shape.databaseId,
    databaseName: bootstrapOptionsSchema.shape.databaseName.optional(),
    installationPath: z.string().min(1).max(4_096),
    json: z.boolean(),
    kind: z.literal("up"),
    origin: bootstrapOptionsSchema.shape.origin.optional(),
    setupGitHub: z.boolean(),
    timeoutMs: bootstrapOptionsSchema.shape.timeoutMs,
    workerName: bootstrapOptionsSchema.shape.workerName.optional(),
  }),
  z.strictObject({
    authenticated: z.boolean(),
    json: z.boolean(),
    kind: z.literal("doctor"),
    origin: z.instanceof(URL),
    timeoutMs: z.number().int().min(100).max(30_000),
  }),
  z.strictObject({
    confirmProduction: z.literal(true),
    json: z.boolean(),
    kind: z.literal("agent-smoke"),
    origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
    runTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1_000),
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
  const agentSmoke = arguments_[0] === "smoke" && arguments_[1] === "agent";

  if (
    arguments_.length === 0 ||
    arguments_[0] === "--help" ||
    arguments_[0] === "-h" ||
    ((arguments_[0] === "up" || arguments_[0] === "doctor" || agentSmoke) &&
      arguments_.includes("--help"))
  ) {
    return { kind: "help" };
  }

  if (arguments_[0] !== "up" && arguments_[0] !== "doctor" && !agentSmoke) {
    throw new CliUsageError("Unknown command.");
  }

  const kind = agentSmoke ? "agent-smoke" : arguments_[0];
  let accountId: string | undefined;
  let authenticated = false;
  let aiDailySpendUsd: number | undefined;
  let confirmProduction = false;
  let databaseId: string | undefined;
  let databaseName: string | undefined;
  let endpoint: string | undefined;
  let installationPath = "crewhelm.installation.json";
  let json = false;
  let runTimeoutMs = 2 * 60 * 1_000;
  let setupGitHub = false;
  let timeoutMs: number = 5_000;
  let workerName: string | undefined;
  const seenFlags = new Set<string>();

  for (let index = agentSmoke ? 2 : 1; index < arguments_.length; index += 1) {
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

    if (flag === "--authenticated" && kind === "doctor") {
      authenticated = true;
      continue;
    }

    if (flag === "--confirm-production" && kind === "agent-smoke") {
      confirmProduction = true;
      continue;
    }

    if (flag === "--endpoint") {
      endpoint = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--setup-github" && kind === "up") {
      setupGitHub = true;
      continue;
    }

    if (flag === "--account-id" && kind === "up") {
      accountId = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--ai-budget-usd" && kind === "up") {
      aiDailySpendUsd = Number(requireFlagValue(arguments_, index, flag));
      index += 1;
      continue;
    }

    if (flag === "--database-id" && kind === "up") {
      databaseId = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--database-name" && kind === "up") {
      databaseName = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--installation" && kind === "up") {
      installationPath = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    if (flag === "--timeout-ms") {
      const value = requireFlagValue(arguments_, index, flag);
      timeoutMs = Number(value);
      index += 1;
      continue;
    }

    if (flag === "--run-timeout-ms" && kind === "agent-smoke") {
      runTimeoutMs = Number(requireFlagValue(arguments_, index, flag));
      index += 1;
      continue;
    }

    if (flag === "--worker-name" && kind === "up") {
      workerName = requireFlagValue(arguments_, index, flag);
      index += 1;
      continue;
    }

    throw new CliUsageError("Unknown flag.");
  }

  if (!endpoint && (kind === "doctor" || kind === "agent-smoke")) {
    throw new CliUsageError(`${kind} requires --endpoint.`);
  }

  if (kind === "agent-smoke" && !confirmProduction) {
    throw new CliUsageError("smoke agent requires --confirm-production.");
  }

  let origin: URL | undefined;

  if (endpoint) {
    try {
      origin = parseDeploymentOrigin(endpoint);
    } catch (error) {
      if (error instanceof DoctorInputError) {
        throw new CliUsageError(error.message);
      }

      throw error;
    }

    if ((kind === "up" || kind === "agent-smoke") && origin.protocol !== "https:") {
      throw new CliUsageError(
        `${kind === "agent-smoke" ? "smoke agent" : kind} requires an HTTPS endpoint.`,
      );
    }
  }

  const command =
    kind === "up"
      ? cliCommandSchema.safeParse({
          accountId,
          aiDailySpendUsd,
          databaseId,
          databaseName,
          installationPath,
          json,
          kind,
          origin,
          setupGitHub,
          timeoutMs,
          workerName,
        })
      : kind === "doctor"
        ? cliCommandSchema.safeParse({
            authenticated,
            json,
            kind,
            origin,
            timeoutMs,
          })
        : cliCommandSchema.safeParse({
            confirmProduction,
            json,
            kind,
            origin,
            runTimeoutMs,
            timeoutMs,
          });

  if (!command.success) {
    throw new CliUsageError("One or more command values were invalid or outside their bounds.");
  }

  return command.data;
}

export interface CliDependencies extends BootstrapDependencies {
  openUrl?: (url: URL) => Promise<void>;
  promptText?: (message: string) => Promise<string>;
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

function formatAuthenticatedDoctorReport(report: AuthenticatedDoctorReport): string {
  const authenticatedChecks = report.checks
    .map((check) => {
      const prefix = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP";
      return `${prefix} ${check.name} ${check.endpoint}\n${check.message}\n`;
    })
    .join("");

  return `${formatDoctorReport(report.public)}${authenticatedChecks}`;
}

function formatAgentSmokeReport(report: AgentSmokeReport): string {
  const smokeChecks = report.checks
    .map((check) => {
      const prefix = check.status === "pass" ? "PASS" : check.status === "fail" ? "FAIL" : "SKIP";
      return `${prefix} ${check.name} ${check.endpoint}\n${check.message}\n`;
    })
    .join("");
  const fixture =
    report.agentId && report.runId
      ? `Agent ${report.agentId}; run ${report.runId}; terminal status ${report.runStatus ?? "unknown"}.\n`
      : "";
  const capacity =
    report.activeAgentsBefore !== undefined && report.activeAgentsAfter !== undefined
      ? `Active Agents ${report.activeAgentsBefore} -> ${report.activeAgentsAfter} after cleanup.\n`
      : "";

  return `${formatDoctorReport(report.public)}${smokeChecks}${fixture}${capacity}`;
}

function formatBootstrapReport(report: BootstrapReport): string {
  const databaseVerb = report.database.action === "created" ? "Created" : "Reused";
  const deploymentVerb =
    report.deployment.action === "created"
      ? "Created"
      : report.deployment.action === "updated"
        ? "Updated"
        : "Verified";

  const gateway = report.aiGateway.enabled
    ? `AI Gateway ${report.aiGateway.id} is the fleet's hard dollar limit.\n`
    : "AI Gateway skipped; this installation has no hard dollar limit.\n";

  return `Using Cloudflare account ${report.account.id}.\n${databaseVerb} D1 database ${report.database.name} (${report.database.id}).\n${gateway}${deploymentVerb} Worker ${report.deployment.workerName} at ${report.deployment.origin}.\n${formatDoctorReport(report.doctor)}`;
}

function formatBootstrapFailure(failure: BootstrapFailure): string {
  return `FAIL up-${failure.stage}\n${failure.message}\n`;
}

async function resolveUpOptions(
  command: Extract<CliCommand, { kind: "up" }>,
  dependencies: CliDependencies,
): Promise<{ options: BootstrapOptions; recoverExisting: boolean }> {
  let previous: Installation | undefined;

  try {
    previous = await readInstallation(command.installationPath);
  } catch {
    throw new CliUsageError("Installation metadata could not be loaded.");
  }

  let origin = command.origin;

  if (!origin && previous) {
    origin = parseDeploymentOrigin(previous.origin);
  }

  if (!origin && dependencies.promptText) {
    let endpoint: string;

    try {
      endpoint = await dependencies.promptText(
        "Crewhelm Worker URL (for example https://crewhelm.example.workers.dev): ",
      );
    } catch {
      throw new CliUsageError("Worker URL input did not complete.");
    }

    try {
      origin = parseDeploymentOrigin(endpoint);
    } catch (error) {
      if (error instanceof DoctorInputError) {
        throw new CliUsageError(error.message);
      }

      throw error;
    }
  }

  if (!origin || origin.protocol !== "https:") {
    throw new CliUsageError("up requires an HTTPS endpoint on the first run.");
  }

  let aiDailySpendUsd = command.aiDailySpendUsd;

  if (previous === undefined && aiDailySpendUsd === undefined && dependencies.promptText) {
    let answer: string;

    try {
      answer = await dependencies.promptText(
        "Enable a Cloudflare AI Gateway hard spend limit? Recommended [Y/n]: ",
      );
    } catch {
      throw new CliUsageError("AI Gateway choice did not complete.");
    }

    if (answer === "" || /^(?:y|yes)$/iu.test(answer)) {
      let dailyLimit: string;

      try {
        dailyLimit = await dependencies.promptText("Daily hard spend limit in USD: ");
      } catch {
        throw new CliUsageError("AI Gateway spend limit input did not complete.");
      }

      aiDailySpendUsd = Number(dailyLimit);
    } else if (!/^(?:n|no|s|skip)$/iu.test(answer)) {
      throw new CliUsageError("Choose yes to configure AI Gateway or no to skip it.");
    }
  }

  const resolved = bootstrapOptionsSchema.safeParse({
    accountId: command.accountId ?? previous?.accountId,
    aiDailySpendUsd,
    aiGatewayId: previous?.aiGatewayId,
    databaseId: command.databaseId ?? previous?.databaseId,
    databaseName: command.databaseName ?? previous?.databaseName ?? "crewhelm-auth",
    origin,
    setupGitHub: command.setupGitHub,
    timeoutMs: command.timeoutMs,
    workerName: command.workerName ?? previous?.workerName ?? "crewhelm",
  });

  if (!resolved.success) {
    throw new CliUsageError(
      "The daily spend limit must be between 0.01 and 1000 USD; other installation settings must also be valid.",
    );
  }

  return { options: resolved.data, recoverExisting: previous === undefined };
}

async function saveInstallationCoordinates(
  path: string,
  installation: ExistingInstallationCoordinates,
): Promise<void> {
  await writeInstallation(
    path,
    installationSchema.parse({
      schemaVersion: 1,
      ...installation,
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function saveInstallation(path: string, report: BootstrapReport): Promise<void> {
  await saveInstallationCoordinates(path, {
    accountId: report.account.id,
    ...(report.aiGateway.enabled ? { aiGatewayId: report.aiGateway.id } : {}),
    databaseId: report.database.id,
    databaseName: report.database.name,
    origin: report.deployment.origin,
    workerName: report.deployment.workerName,
  });
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

  if (command.kind === "up") {
    try {
      const { options, recoverExisting } = await resolveUpOptions(command, dependencies);
      const bootstrapDependencies: BootstrapDependencies = recoverExisting
        ? {
            ...dependencies,
            recoverExistingInstallation: {
              ...(command.databaseId === undefined
                ? {}
                : { expectedDatabaseId: command.databaseId }),
              ...(command.databaseName === undefined
                ? {}
                : { expectedDatabaseName: command.databaseName }),
              persist: (installation) =>
                saveInstallationCoordinates(command.installationPath, installation),
            },
          }
        : dependencies;
      const report = await bootstrapDeployment(options, bootstrapDependencies);

      if (report.ok) {
        try {
          await saveInstallation(command.installationPath, report);
        } catch {
          throw new BootstrapError(
            "configuration",
            "Deployment succeeded, but local installation metadata could not be saved.",
          );
        }
      }
      dependencies.writeOutput(
        command.json ? `${JSON.stringify(report)}\n` : formatBootstrapReport(report),
      );
      return report.ok ? 0 : 1;
    } catch (error) {
      if (error instanceof CliUsageError) {
        dependencies.writeError(`Error: ${error.message}\n\n${CLI_HELP}`);
        return 2;
      }

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

  if (command.kind === "agent-smoke") {
    const report = agentSmokeReportSchema.parse(
      await runAgentSmoke(command, {
        fetch: dependencies.fetch,
        openUrl:
          dependencies.openUrl ??
          (async () => {
            throw new Error("Browser unavailable.");
          }),
      }),
    );
    dependencies.writeOutput(
      command.json ? `${JSON.stringify(report)}\n` : formatAgentSmokeReport(report),
    );
    return report.ok ? 0 : 1;
  }

  if (command.authenticated) {
    const report = await diagnoseAuthenticatedDeployment(command, {
      fetch: dependencies.fetch,
      openUrl:
        dependencies.openUrl ??
        (async () => {
          throw new Error("Browser unavailable.");
        }),
    });
    dependencies.writeOutput(
      command.json ? `${JSON.stringify(report)}\n` : formatAuthenticatedDoctorReport(report),
    );
    return report.ok ? 0 : 1;
  }

  const report = await diagnoseDeployment(command, dependencies);
  dependencies.writeOutput(
    command.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report),
  );
  return report.ok ? 0 : 1;
}
