import {
  diagnoseAuthenticatedDeployment,
  type AuthenticatedDoctorReport,
} from "./authenticated-doctor.js";
import { agentSmokeReportSchema, runAgentSmoke, type AgentSmokeReport } from "./agent-smoke.js";
import {
  bootstrapDeployment,
  bootstrapUpgradeDeployment,
  BootstrapError,
  bootstrapOptionsSchema,
  createBootstrapFailure,
  inspectInstallationInfrastructure,
  readPackagedDeploymentFingerprint,
  readPackagedMigrationInventory,
  type BootstrapDependencies,
  type BootstrapFailure,
  type BootstrapOptions,
  type BootstrapProgress,
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
import {
  createInstallationSmokeFailure,
  installationSmokeReportSchema,
  runInstallationSmoke,
  type InstallationSmokeReport,
} from "./installation-smoke.js";
import { createCliPresentation, type CliPresentation } from "./presentation.js";
import {
  runStandingIntegrationSmoke,
  standingIntegrationSmokeReportSchema,
  type StandingIntegrationSmokeReport,
} from "./standing-integration-smoke.js";
import {
  createUpgradeSmokeFailure,
  runUpgradeSmoke,
  upgradeSmokeReportSchema,
  type UpgradeSmokeReport,
} from "./upgrade-smoke.js";

export { CLI_HELP, parseCli } from "./command.js";

export interface CliDependencies extends BootstrapDependencies {
  color?: boolean;
  deploymentFingerprint?: string;
  interactive?: boolean;
  liveProgress?: boolean;
  openUrl?: (url: URL) => Promise<void>;
  promptText?: (message: string) => Promise<string>;
  writeError: (text: string) => void;
  writeOutput: (text: string) => void;
}

const BOOTSTRAP_ACTIVITY_LABELS = {
  assets: "Preparation",
  authentication: "Cloudflare",
  configuration: "Configuration",
  database: "Storage",
  deployment: "Deployment",
  gateway: "AI spending",
  migrations: "Storage",
  worker: "Worker",
} as const satisfies Record<BootstrapProgress["stage"], string>;

const UPGRADE_SMOKE_ACTIVITY_LABELS = {
  baseline: "Baseline",
  deployment: "Upgrade",
  retry: "Retry",
  verification: "Verification",
} as const;

function formatDoctorReport(report: DoctorReport, presentation: CliPresentation): string {
  const checks = report.checks
    .map((check) => {
      const prefix = presentation.status(check.status);
      return `${prefix} ${check.name} ${presentation.muted(check.endpoint)}\n${check.message}\n`;
    })
    .join("");
  const deployment = report.deployment;
  const deploymentStatus = deployment.alignment === "aligned" ? "pass" : "fail";
  const deploymentMessage =
    deployment.alignment === "aligned"
      ? `Worker matches packaged build ${deployment.worker?.fingerprint.slice(0, 12)}.`
      : deployment.alignment === "cli_outdated"
        ? "Worker requires a newer Crewhelm CLI; refusing to replace it."
        : deployment.alignment === "different"
          ? "Worker runs a different compatible build. Run crewhelm up to align it explicitly."
          : deployment.alignment === "worker_outdated"
            ? "Worker predates this CLI deployment protocol. Run crewhelm up to upgrade it."
            : deployment.alignment === "unverified"
              ? "Packaged build identity was not provided for comparison."
              : "Worker build identity could not be read.";

  return `${checks}${presentation.status(deploymentStatus)} deployment-alignment\n${deploymentMessage}\n`;
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

function formatInstallationSmokeReport(
  report: InstallationSmokeReport,
  presentation: CliPresentation,
): string {
  const deployment =
    report.deployment === undefined
      ? ""
      : !("stage" in report.deployment)
        ? `Created isolated Worker ${report.deployment.deployment.workerName} and D1 ${report.deployment.database.name}.\n`
        : `${presentation.status("fail")} installation-${report.deployment.stage}\n${report.deployment.message}\n`;
  const agent =
    report.agent === undefined
      ? ""
      : report.agent.ok
        ? "Disposable Agent lifecycle completed.\n"
        : "Disposable Agent lifecycle did not complete.\n";
  const cleanup = report.cleanup.resources
    .map((resource) => {
      const name = resource.kind === "gateway" ? resource.id : resource.name;
      return `${presentation.status(resource.status === "unresolved" ? "fail" : "pass")} cleanup-${resource.kind} ${name}: ${resource.status}\n`;
    })
    .join("");
  const outcome = report.ok
    ? presentation.accent("Fresh-install rehearsal passed.")
    : `${presentation.status("fail")} Fresh-install rehearsal needs attention.`;

  return `${outcome}\n${deployment}${agent}${cleanup}Recovery receipt: ${report.receiptPath}\n`;
}

function formatUpgradeSmokeReport(
  report: UpgradeSmokeReport,
  presentation: CliPresentation,
): string {
  return [
    presentation.accent("Supported-upgrade rehearsal passed."),
    `  Worker      ${report.coordinates.workerName}`,
    `  Package     ${report.baselineFingerprint.slice(0, 12)} -> ${report.currentFingerprint.slice(0, 12)}`,
    `  Migrations  ${report.before.infrastructure.migrations.count} -> ${report.after.infrastructure.migrations.count}`,
    `  Agents      ${report.after.owner.agents.count}`,
    `  Revisions   ${report.after.owner.agentRevisions.count}`,
    `  Connections ${report.after.owner.connections.count}`,
    `  Schedules   ${report.after.owner.schedules.count}`,
    `  Retry       ${report.deployment.retryAction}`,
    `Recovery receipt: ${report.receiptPath}`,
    "",
  ].join("\n");
}

function formatBootstrapReport(report: BootstrapReport, presentation: CliPresentation): string {
  const databaseState = report.database.action === "created" ? "Created" : "Reused";
  const deploymentState =
    report.deployment.action === "created"
      ? "Created"
      : report.deployment.action === "updated"
        ? "Updated"
        : "Current";

  const gateway = report.aiGateway.enabled
    ? report.aiGateway.id
    : presentation.warning("Not configured — no hard dollar limit");

  const outcome = report.ok
    ? `${presentation.status("pass")} ${presentation.strong("Crewhelm is ready")}`
    : `${presentation.status("fail")} ${presentation.strong("Deployment checks failed")}`;

  return [
    outcome,
    "",
    presentation.heading("Installation"),
    `  Worker    ${report.deployment.workerName} ${presentation.muted(`(${deploymentState})`)}`,
    `  Endpoint  ${report.deployment.origin}`,
    `  Database  ${report.database.name} ${presentation.muted(`(${databaseState})`)}`,
    `  Gateway   ${gateway}`,
    `  Account   ${presentation.muted(report.account.id)}`,
    "",
    presentation.heading("Verification"),
    formatDoctorReport(report.doctor, presentation).trimEnd(),
    "",
  ].join("\n");
}

function formatBootstrapFailure(failure: BootstrapFailure, presentation: CliPresentation): string {
  return [
    `${presentation.status("fail")} ${presentation.strong("Setup stopped")}`,
    `${presentation.muted("Stage")}  ${BOOTSTRAP_ACTIVITY_LABELS[failure.stage]}`,
    "",
    failure.message,
    "",
  ].join("\n");
}

function formatBootstrapTarget(
  options: BootstrapOptions,
  recoverExisting: boolean,
  presentation: CliPresentation,
): string {
  const gateway =
    options.aiDailySpendUsd === undefined
      ? presentation.warning("No hard dollar limit")
      : `$${options.aiDailySpendUsd} daily limit`;

  return [
    presentation.heading("Installation target"),
    "",
    `  Action    ${recoverExisting ? "Create or recover" : "Update existing"}`,
    `  Worker    ${options.workerName}`,
    `  Endpoint  ${options.origin.origin}`,
    `  Database  ${options.databaseName}`,
    `  Gateway   ${gateway}`,
    "",
  ].join("\n");
}

async function resolveUpOptions(
  command: Extract<CliCommand, { kind: "up" }>,
  dependencies: CliDependencies,
  presentation: CliPresentation,
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

    dependencies.writeOutput(
      [
        presentation.heading("AI spending protection"),
        "",
        "Set a hard daily model-spending limit through Cloudflare AI Gateway.",
        "",
        `${presentation.accent("1.")} Configure a spending limit ${presentation.muted("(recommended)")}`,
        `${presentation.warning("2.")} Continue without a spending limit`,
        "",
      ].join("\n"),
    );

    try {
      answer = await dependencies.promptText(presentation.strong("Choose [1]: "));
    } catch {
      throw new CliUsageError("AI Gateway choice did not complete.");
    }

    if (answer === "" || /^(?:1|y|yes)$/iu.test(answer)) {
      let dailyLimit: string;

      try {
        dailyLimit = await dependencies.promptText(presentation.strong("Daily limit in USD: "));
      } catch {
        throw new CliUsageError("AI Gateway spend limit input did not complete.");
      }

      aiDailySpendUsd = Number(dailyLimit);
    } else if (!/^(?:2|n|no|s|skip)$/iu.test(answer)) {
      throw new CliUsageError("Choose 1 to configure AI Gateway or 2 to skip it.");
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

async function expectedDeploymentFingerprint(dependencies: CliDependencies): Promise<string> {
  return (
    dependencies.deploymentFingerprint ?? (await readPackagedDeploymentFingerprint(dependencies))
  );
}

type SmokeCommand = Extract<CliCommand, { kind: "agent-smoke" | "standing-integration-smoke" }>;

async function offerDeploymentAlignment(
  command: SmokeCommand,
  report: DoctorReport,
  dependencies: CliDependencies,
): Promise<"declined" | "failed" | "not_offered" | "updated"> {
  if (
    command.json ||
    dependencies.interactive !== true ||
    dependencies.promptText === undefined ||
    !report.checks.every((check) => check.status === "pass") ||
    !["different", "worker_outdated"].includes(report.deployment.alignment)
  ) {
    return "not_offered";
  }

  const prompt =
    report.deployment.alignment === "worker_outdated"
      ? "Worker is older than this CLI. Deploy the matching Worker now? [y/N]: "
      : "Worker runs a different compatible build. Deploy this CLI's bundled Worker now? [y/N]: ";
  let answer: string;

  try {
    answer = await dependencies.promptText(prompt);
  } catch {
    return "declined";
  }

  if (!/^(?:y|yes)$/iu.test(answer)) {
    return "declined";
  }

  const result = await runCli(
    ["up", "--endpoint", command.origin.origin, "--installation", command.installationPath],
    dependencies,
  );
  return result === 0 ? "updated" : "failed";
}

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<number> {
  const color = dependencies.color === true && !arguments_.includes("--no-color");
  const presentation = createCliPresentation({
    color,
    interactive: dependencies.interactive === true,
    ...(dependencies.liveProgress === undefined ? {} : { liveProgress: dependencies.liveProgress }),
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
      delete executionDependencies.requestCloudflareGatewayAuthorization;
      delete executionDependencies.promptSecret;
      delete executionDependencies.promptText;
      delete executionDependencies.reportProgress;
    } else {
      presentation.banner();
      const reportProgress = executionDependencies.reportProgress;
      executionDependencies.reportProgress = (progress) => {
        reportProgress?.(progress);
        presentation.progress({
          label: BOOTSTRAP_ACTIVITY_LABELS[progress.stage],
          message: progress.message,
        });
      };

      const createGitHubApp = executionDependencies.createGitHubApp;

      if (createGitHubApp) {
        executionDependencies.createGitHubApp = async (options) => {
          presentation.waiting(
            "GitHub identity",
            "Complete the private GitHub App setup in your browser. Crewhelm will continue automatically.",
          );
          const credentials = await createGitHubApp(options);
          presentation.result("pass", "GitHub App connected");
          return credentials;
        };
      }

      const requestGatewayAuthorization =
        executionDependencies.requestCloudflareGatewayAuthorization;

      if (requestGatewayAuthorization) {
        executionDependencies.requestCloudflareGatewayAuthorization = async (request) => {
          presentation.stopProgress();
          const authorization = await requestGatewayAuthorization(request);

          if (authorization.action === "token") {
            presentation.progress({
              label: "AI spending",
              message: "Verifying AI Gateway access",
            });
          }

          return authorization;
        };
      }

      const promptSecret = executionDependencies.promptSecret;

      if (promptSecret) {
        executionDependencies.promptSecret = async (message) => {
          presentation.stopProgress();

          if (message.startsWith("Composio")) {
            presentation.waiting(
              "Integration access",
              "Paste the Composio project API key. Input is hidden.",
            );
          }

          return promptSecret(message);
        };
      }
    }

    try {
      const { options, recoverExisting } = await resolveUpOptions(
        command,
        executionDependencies,
        presentation,
      );

      if (!command.json) {
        dependencies.writeOutput(formatBootstrapTarget(options, recoverExisting, presentation));
      }

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
      presentation.stopProgress();
      dependencies.writeOutput(
        command.json ? `${JSON.stringify(report)}\n` : formatBootstrapReport(report, presentation),
      );
      return report.ok ? 0 : 1;
    } catch (error) {
      presentation.stopProgress();

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
    } finally {
      presentation.stopProgress();
    }
  }

  if (command.kind === "agent-smoke") {
    const deploymentFingerprint = await expectedDeploymentFingerprint(dependencies);
    let report = agentSmokeReportSchema.parse(
      await runAgentSmoke(command, {
        expectedDeploymentFingerprint: deploymentFingerprint,
        fetch: dependencies.fetch,
        openUrl:
          dependencies.openUrl ??
          (async () => {
            throw new Error("Browser unavailable.");
          }),
      }),
    );
    const alignment = await offerDeploymentAlignment(command, report.public, dependencies);

    if (alignment === "failed") {
      return 1;
    }

    if (alignment === "updated") {
      report = agentSmokeReportSchema.parse(
        await runAgentSmoke(command, {
          expectedDeploymentFingerprint: deploymentFingerprint,
          fetch: dependencies.fetch,
          openUrl:
            dependencies.openUrl ??
            (async () => {
              throw new Error("Browser unavailable.");
            }),
        }),
      );
    }
    dependencies.writeOutput(
      command.json ? `${JSON.stringify(report)}\n` : formatAgentSmokeReport(report, presentation),
    );
    return report.ok ? 0 : 1;
  }

  if (command.kind === "installation-smoke") {
    try {
      const report = installationSmokeReportSchema.parse(
        await runInstallationSmoke(
          {
            ...(command.accountId === undefined ? {} : { accountId: command.accountId }),
            ...(command.aiDailySpendUsd === undefined
              ? {}
              : { aiDailySpendUsd: command.aiDailySpendUsd }),
            cleanupOnly: command.cleanupOnly,
            databaseName: command.databaseName,
            origin: command.origin,
            receiptPath: command.receiptPath,
            runTimeoutMs: command.runTimeoutMs,
            timeoutMs: command.timeoutMs,
            workerName: command.workerName,
          },
          {
            ...dependencies,
            openUrl:
              dependencies.openUrl ??
              (async () => {
                throw new Error("Browser unavailable.");
              }),
          },
        ),
      );
      dependencies.writeOutput(
        command.json
          ? `${JSON.stringify(report)}\n`
          : formatInstallationSmokeReport(report, presentation),
      );
      return report.ok ? 0 : 1;
    } catch (error) {
      dependencies.writeError(
        command.json
          ? `${JSON.stringify(
              createInstallationSmokeFailure(command.receiptPath, command.cleanupOnly),
            )}\n`
          : `Error: ${error instanceof Error ? error.message : "Installation rehearsal failed."}\n`,
      );
      return 1;
    }
  }

  if (command.kind === "upgrade-smoke") {
    const openUrl =
      dependencies.openUrl ??
      (async () => {
        throw new Error("Browser unavailable.");
      });

    if (!command.json) {
      presentation.banner();
    }

    try {
      const report = upgradeSmokeReportSchema.parse(
        await runUpgradeSmoke(
          {
            baselineFingerprint: command.baselineFingerprint,
            installationPath: command.installationPath,
            origin: command.origin,
            receiptPath: command.receiptPath,
            timeoutMs: command.timeoutMs,
          },
          {
            ...dependencies,
            bootstrap: (options, expectedFingerprint) =>
              bootstrapUpgradeDeployment(options, dependencies, [expectedFingerprint]),
            diagnose: (expectedFingerprint) =>
              diagnoseDeployment(command, {
                expectedDeploymentFingerprint: expectedFingerprint,
                fetch: dependencies.fetch,
              }),
            inspectInfrastructure: (coordinates) =>
              inspectInstallationInfrastructure(coordinates, dependencies),
            openUrl: async (url) => {
              if (!command.json) {
                presentation.stopProgress();
                presentation.waiting(
                  "Owner verification",
                  "Approve temporary View access in the browser. Crewhelm revokes it after the snapshot.",
                );
              }
              await openUrl(url);
            },
            readCurrentFingerprint: () => expectedDeploymentFingerprint(dependencies),
            readCurrentMigrations: () => readPackagedMigrationInventory(dependencies),
            reportUpgradeProgress: (progress) => {
              if (!command.json) {
                presentation.progress({
                  label: UPGRADE_SMOKE_ACTIVITY_LABELS[progress.stage],
                  message: progress.message,
                });
              }
            },
          },
        ),
      );
      presentation.stopProgress();
      dependencies.writeOutput(
        command.json
          ? `${JSON.stringify(report)}\n`
          : formatUpgradeSmokeReport(report, presentation),
      );
      return 0;
    } catch (error) {
      presentation.stopProgress();
      dependencies.writeError(
        command.json
          ? `${JSON.stringify(createUpgradeSmokeFailure(command.receiptPath, error))}\n`
          : `Error: ${error instanceof Error ? error.message : "Upgrade rehearsal failed."}\n`,
      );
      return 1;
    } finally {
      presentation.stopProgress();
    }
  }

  if (command.kind === "standing-integration-smoke") {
    const deploymentFingerprint = await expectedDeploymentFingerprint(dependencies);
    let report = standingIntegrationSmokeReportSchema.parse(
      await runStandingIntegrationSmoke(command, {
        expectedDeploymentFingerprint: deploymentFingerprint,
        fetch: dependencies.fetch,
        openUrl:
          dependencies.openUrl ??
          (async () => {
            throw new Error("Browser unavailable.");
          }),
      }),
    );
    const alignment = await offerDeploymentAlignment(command, report.public, dependencies);

    if (alignment === "failed") {
      return 1;
    }

    if (alignment === "updated") {
      report = standingIntegrationSmokeReportSchema.parse(
        await runStandingIntegrationSmoke(command, {
          expectedDeploymentFingerprint: deploymentFingerprint,
          fetch: dependencies.fetch,
          openUrl:
            dependencies.openUrl ??
            (async () => {
              throw new Error("Browser unavailable.");
            }),
        }),
      );
    }
    dependencies.writeOutput(
      command.json
        ? `${JSON.stringify(report)}\n`
        : formatStandingIntegrationSmokeReport(report, presentation),
    );
    return report.ok ? 0 : 1;
  }

  if (command.authenticated) {
    const deploymentFingerprint = await expectedDeploymentFingerprint(dependencies);
    const report = await diagnoseAuthenticatedDeployment(command, {
      expectedDeploymentFingerprint: deploymentFingerprint,
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

  const deploymentFingerprint = await expectedDeploymentFingerprint(dependencies);
  const report = await diagnoseDeployment(command, {
    expectedDeploymentFingerprint: deploymentFingerprint,
    fetch: dependencies.fetch,
  });
  dependencies.writeOutput(
    command.json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report, presentation),
  );
  return report.ok ? 0 : 1;
}
