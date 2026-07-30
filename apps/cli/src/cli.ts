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
import { CLI_HELP, CliUsageError, parseCli, type CliCommand } from "./command.js";
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
import { createCliPresentation, type CliPresentation } from "./presentation.js";
import {
  runStandingIntegrationSmoke,
  standingIntegrationSmokeReportSchema,
  type StandingIntegrationSmokeReport,
} from "./standing-integration-smoke.js";

export { CLI_HELP, parseCli } from "./command.js";

export interface CliDependencies extends BootstrapDependencies {
  color?: boolean;
  interactive?: boolean;
  openUrl?: (url: URL) => Promise<void>;
  promptText?: (message: string) => Promise<string>;
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

function formatDoctorReport(report: DoctorReport, presentation: CliPresentation): string {
  return report.checks
    .map((check) => {
      const prefix = presentation.status(check.status);
      return `${prefix} ${check.name} ${presentation.muted(check.endpoint)}\n${check.message}\n`;
    })
    .join("");
}

function formatAuthenticatedDoctorReport(
  report: AuthenticatedDoctorReport,
  presentation: CliPresentation,
): string {
  const authenticatedChecks = report.checks
    .map((check) => {
      const prefix = presentation.status(check.status);
      return `${prefix} ${check.name} ${presentation.muted(check.endpoint)}\n${check.message}\n`;
    })
    .join("");

  return `${formatDoctorReport(report.public, presentation)}${authenticatedChecks}`;
}

function formatAgentSmokeReport(report: AgentSmokeReport, presentation: CliPresentation): string {
  const smokeChecks = report.checks
    .map((check) => {
      const prefix = presentation.status(check.status);
      return `${prefix} ${check.name} ${presentation.muted(check.endpoint)}\n${check.message}\n`;
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

  return `${formatDoctorReport(report.public, presentation)}${smokeChecks}${fixture}${capacity}`;
}

function formatStandingIntegrationSmokeReport(
  report: StandingIntegrationSmokeReport,
  presentation: CliPresentation,
): string {
  const smokeChecks = report.checks
    .map((check) => {
      const prefix = presentation.status(check.status);
      return `${prefix} ${check.name} ${presentation.muted(check.endpoint)}\n${check.message}\n`;
    })
    .join("");
  const fixture =
    report.agentId && report.runId
      ? `Agent ${report.agentId}; ${report.trigger} run ${report.runId}; terminal status ${report.runStatus ?? "unknown"}.\n`
      : "";
  const connection = report.connection
    ? `Connection ${report.connection.accountLabel ?? report.connection.providerConnectionId} (${report.connection.integrationSlug ?? "unknown integration"}).\n`
    : "";
  const draft =
    report.retainedDraft && report.fixtureSubject
      ? `Retained non-deliverable Gmail draft: ${report.fixtureSubject}\n`
      : "";
  const cleanup =
    report.activeAgentsBefore !== undefined && report.activeAgentsAfter !== undefined
      ? `Active Agents ${report.activeAgentsBefore} -> ${report.activeAgentsAfter} after cleanup.\n`
      : "";
  const schedule =
    report.scheduleRevision !== undefined
      ? `Schedule revision ${report.scheduleRevision}; ${report.schedulePaused ? "paused after first dispatch" : "cleanup unverified"}.\n`
      : "";

  return `${formatDoctorReport(report.public, presentation)}${smokeChecks}${connection}${fixture}${schedule}${draft}${cleanup}`;
}

function formatBootstrapReport(report: BootstrapReport, presentation: CliPresentation): string {
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

  const outcome = report.ok
    ? presentation.accent("Crewhelm is ready.")
    : `${presentation.status("fail")} Deployment checks failed.`;

  return `${outcome}\nUsing Cloudflare account ${report.account.id}.\n${databaseVerb} D1 database ${report.database.name} (${report.database.id}).\n${gateway}${deploymentVerb} Worker ${report.deployment.workerName} at ${report.deployment.origin}.\n${formatDoctorReport(report.doctor, presentation)}`;
}

function formatBootstrapFailure(failure: BootstrapFailure, presentation: CliPresentation): string {
  return `${presentation.status("fail")} up-${failure.stage}\n${failure.message}\n`;
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
  const color = dependencies.color === true && !arguments_.includes("--no-color");
  const presentation = createCliPresentation({
    color,
    interactive: dependencies.interactive === true,
    writeError: dependencies.writeError,
    writeOutput: dependencies.writeOutput,
  });
  let command: CliCommand;

  try {
    command = parseCli(arguments_, { color });
  } catch (error) {
    if (error instanceof CliUsageError) {
      dependencies.writeError(`Error: ${error.message}\n\n${CLI_HELP}`);
      return 2;
    }

    throw error;
  }

  if (command.kind === "help") {
    if (arguments_.every((argument) => argument.startsWith("-"))) {
      presentation.banner();
    }
    dependencies.writeOutput(command.text);
    return 0;
  }

  if (command.kind === "up") {
    const executionDependencies: CliDependencies = { ...dependencies };

    if (command.json) {
      delete executionDependencies.createGitHubApp;
      delete executionDependencies.openCloudflareApiTokens;
      delete executionDependencies.promptSecret;
      delete executionDependencies.promptText;
      delete executionDependencies.reportProgress;
    } else {
      presentation.banner();
      const reportProgress = executionDependencies.reportProgress;
      executionDependencies.reportProgress = (progress) => {
        reportProgress?.(progress);
        presentation.progress(progress.message);
      };
    }

    try {
      const { options, recoverExisting } = await resolveUpOptions(command, executionDependencies);
      const bootstrapDependencies: BootstrapDependencies = recoverExisting
        ? {
            ...executionDependencies,
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
        : executionDependencies;
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
        command.json ? `${JSON.stringify(report)}\n` : formatBootstrapReport(report, presentation),
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
          command.json
            ? `${JSON.stringify(failure)}\n`
            : formatBootstrapFailure(failure, presentation),
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
      command.json ? `${JSON.stringify(report)}\n` : formatAgentSmokeReport(report, presentation),
    );
    return report.ok ? 0 : 1;
  }

  if (command.kind === "standing-integration-smoke") {
    const report = standingIntegrationSmokeReportSchema.parse(
      await runStandingIntegrationSmoke(command, {
        fetch: dependencies.fetch,
        openUrl:
          dependencies.openUrl ??
          (async () => {
            throw new Error("Browser unavailable.");
          }),
      }),
    );
    dependencies.writeOutput(
      command.json
        ? `${JSON.stringify(report)}\n`
        : formatStandingIntegrationSmokeReport(report, presentation),
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
      command.json
        ? `${JSON.stringify(report)}\n`
        : formatAuthenticatedDoctorReport(report, presentation),
    );
    return report.ok ? 0 : 1;
  }

  const report = await diagnoseDeployment(command, dependencies);
  dependencies.writeOutput(
    command.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report, presentation),
  );
  return report.ok ? 0 : 1;
}
