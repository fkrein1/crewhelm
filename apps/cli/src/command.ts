import { Command, CommanderError, type OutputConfiguration } from "commander";
import { connectionIdSchema } from "@crewhelm/contracts";
import * as z from "zod";

import { bootstrapOptionsSchema } from "./bootstrap.js";
import { DoctorInputError, parseDeploymentOrigin } from "./doctor.js";
import { installationRehearsalOptionsSchema } from "./rehearsal/public/installation.js";
import { createCliTextStyle, type CliTextStyle } from "./presentation.js";
import { upgradeRehearsalOptionsSchema } from "./rehearsal/public/upgrade.js";
import { CREWHELM_CLI_VERSION } from "./version.js";

export const browserModeSchema = z.enum(["system", "codex", "none"]);
export type BrowserMode = z.infer<typeof browserModeSchema>;

function formatRootHelp(style: CliTextStyle): string {
  return `
${style.accentStrong("Examples:")}
  ${style.accent("$ crewhelm up")}
  ${style.accent("$ crewhelm doctor --endpoint https://crewhelm.example")}
  ${style.accent("$ crewhelm rehearse agent --help")}
  ${style.accent("$ crewhelm rehearse integration --help")}
  ${style.accent("$ crewhelm rehearse installation --help")}
  ${style.accent("$ crewhelm rehearse upgrade --help")}

${style.muted("Run crewhelm <command> --help for command-specific options and safety notes.")}
`;
}

function formatUpHelp(style: CliTextStyle): string {
  return `
${style.accentStrong("Examples:")}
  ${style.accent("$ crewhelm up")}
  ${style.accent("$ crewhelm up --endpoint https://crewhelm.example --ai-budget-usd 5")}
  ${style.accent("$ crewhelm up --sandbox")} ${style.muted("# requires Cloudflare Workers Paid")}
  ${style.accent("$ crewhelm up --no-sandbox")} ${style.muted("# keep or return to the Free-compatible core")}
  ${style.accent("$ crewhelm up --browser codex")}

${style.accentStrong("Automation:")}
  Set these variables to run without prompts:
    ${style.warning("CREWHELM_GITHUB_CLIENT_ID")}
    ${style.warning("CREWHELM_GITHUB_CLIENT_SECRET")}
    ${style.warning("CREWHELM_OWNER_GITHUB_USER_ID")}
    ${style.warning("CREWHELM_COMPOSIO_API_KEY")}

  Optional capabilities:
    ${style.warning("CREWHELM_BRAVE_SEARCH_API_KEY")} ${style.muted("# enables Agent web search; controlled fetch needs no paid Worker feature")}

  When Wrangler OAuth cannot manage AI Gateway, also set:
    ${style.warning("CREWHELM_CLOUDFLARE_API_TOKEN")}

${style.accentStrong("Safety:")}
  Preserves deployed secrets and recovers missing installation metadata before mutation.
  Requires an HTTPS endpoint. ${style.accent("--json")} disables prompts and browser setup.
`;
}

function formatDoctorHelp(style: CliTextStyle): string {
  return `
${style.accentStrong("Examples:")}
  ${style.accent("$ crewhelm doctor --endpoint https://crewhelm.example")}
  ${style.accent("$ crewhelm doctor --installation crewhelm.testing.installation.json")}
  ${style.accent("$ crewhelm doctor --installation crewhelm.testing.installation.json --authenticated --browser codex")}

${style.accentStrong("Access:")}
  ${style.accent("--authenticated")} opens the browser for temporary view-only owner access.
  The temporary diagnostic token is revoked before exit.

${style.accentStrong("Network:")}
  HTTPS is required except for exact loopback hosts.
  Installation metadata is authoritative; a supplied endpoint must match it exactly.
`;
}

function formatAgentRehearsalHelp(style: CliTextStyle): string {
  return `
${style.warningStrong("Production rehearsal:")}
  Creates and runs one zero-grant disposable Agent, then disables it.
  Requests temporary Full control and verifies token revocation before exit.
  Requires ${style.warning("--confirm-production")} and an HTTPS endpoint.
`;
}

function formatStandingIntegrationRehearsalHelp(style: CliTextStyle): string {
  return `
${style.warningStrong("Production rehearsal:")}
  Creates one draft to the reserved, non-deliverable example.invalid domain.
  ${style.accent("--trigger schedule")} waits for one autonomous scheduled dispatch; manual is default.
  Requires an exact authorized Gmail connection and retains the draft for verification.
  Pauses any schedule, revokes the grant, disables the Agent, and revokes temporary Full control.
  Requires ${style.warning("--confirm-production")} and an HTTPS endpoint.
`;
}

function formatInstallationRehearsalHelp(style: CliTextStyle): string {
  return `
${style.warningStrong("Fresh-install rehearsal:")}
  Creates an isolated Worker and D1 database, runs the Agent lifecycle rehearsal, then deletes them.
  ${style.accent("--ai-budget-usd")} also creates and deletes an isolated AI Gateway.
  Existing resources are rejected; exact cleanup coordinates remain in the bounded receipt.
  Supplied GitHub App credentials must allow this Worker's callback origin.
  Requires ${style.warning("--confirm-production")} and crewhelm-rehearsal-* resource names.
`;
}

function formatUpgradeRehearsalHelp(style: CliTextStyle): string {
  return `
${style.warningStrong("Supported-upgrade rehearsal:")}
  Upgrades one existing pinned fixture to this CLI's packaged Worker.
  Verifies owner access, Agents, connections, schedules, fleet policy, secrets, and migrations.
  Repeats the upgrade to prove an idempotent no-op and retains exact recovery state on failure.
  Requires ${style.warning("--confirm-production")}, the baseline fingerprint, and existing metadata.
`;
}

const cliCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("help"),
    text: z.string(),
  }),
  z.strictObject({
    json: z.boolean(),
    kind: z.literal("version"),
  }),
  z.strictObject({
    accountId: bootstrapOptionsSchema.shape.accountId,
    aiDailySpendUsd: bootstrapOptionsSchema.shape.aiDailySpendUsd,
    browser: browserModeSchema,
    databaseId: bootstrapOptionsSchema.shape.databaseId,
    databaseName: bootstrapOptionsSchema.shape.databaseName.optional(),
    installationPath: z.string().min(1).max(4_096),
    json: z.boolean(),
    kind: z.literal("up"),
    origin: bootstrapOptionsSchema.shape.origin.optional(),
    sandboxEnabled: bootstrapOptionsSchema.shape.sandboxEnabled,
    setupGitHub: z.boolean(),
    timeoutMs: bootstrapOptionsSchema.shape.timeoutMs,
    workerName: bootstrapOptionsSchema.shape.workerName.optional(),
  }),
  z.strictObject({
    authenticated: z.boolean(),
    browser: browserModeSchema,
    installationPath: z.string().min(1).max(4_096).optional(),
    json: z.boolean(),
    kind: z.literal("doctor"),
    origin: z.instanceof(URL).optional(),
    timeoutMs: z.number().int().min(100).max(30_000),
  }),
  z.strictObject({
    browser: browserModeSchema,
    confirmProduction: z.literal(true),
    connectionId: connectionIdSchema,
    installationProvided: z.boolean(),
    installationPath: z.string().min(1).max(4_096),
    json: z.boolean(),
    kind: z.literal("standing-integration-rehearsal"),
    origin: z
      .instanceof(URL)
      .refine((origin) => origin.protocol === "https:")
      .optional(),
    runTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1_000),
    timeoutMs: z.number().int().min(100).max(30_000),
    trigger: z.enum(["manual", "schedule"]),
  }),
  z.strictObject({
    browser: browserModeSchema,
    confirmProduction: z.literal(true),
    installationProvided: z.boolean(),
    installationPath: z.string().min(1).max(4_096),
    json: z.boolean(),
    kind: z.literal("agent-rehearsal"),
    origin: z
      .instanceof(URL)
      .refine((origin) => origin.protocol === "https:")
      .optional(),
    runTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1_000),
    timeoutMs: z.number().int().min(100).max(30_000),
  }),
  z.strictObject({
    accountId: installationRehearsalOptionsSchema.shape.accountId,
    aiDailySpendUsd: installationRehearsalOptionsSchema.shape.aiDailySpendUsd,
    browser: browserModeSchema,
    cleanupOnly: z.boolean(),
    confirmProduction: z.literal(true),
    databaseName: installationRehearsalOptionsSchema.shape.databaseName,
    json: z.boolean(),
    kind: z.literal("installation-rehearsal"),
    origin: installationRehearsalOptionsSchema.shape.origin,
    receiptPath: installationRehearsalOptionsSchema.shape.receiptPath,
    runTimeoutMs: installationRehearsalOptionsSchema.shape.runTimeoutMs,
    timeoutMs: installationRehearsalOptionsSchema.shape.timeoutMs,
    workerName: installationRehearsalOptionsSchema.shape.workerName,
  }),
  z.strictObject({
    baselineFingerprint: upgradeRehearsalOptionsSchema.shape.baselineFingerprint,
    browser: browserModeSchema,
    confirmProduction: z.literal(true),
    installationProvided: z.boolean(),
    installationPath: upgradeRehearsalOptionsSchema.shape.installationPath,
    json: z.boolean(),
    kind: z.literal("upgrade-rehearsal"),
    origin: upgradeRehearsalOptionsSchema.shape.origin.optional(),
    receiptPath: upgradeRehearsalOptionsSchema.shape.receiptPath,
    timeoutMs: upgradeRehearsalOptionsSchema.shape.timeoutMs,
  }),
]);

export type CliCommand = z.infer<typeof cliCommandSchema>;

interface UpCommandOptions {
  accountId?: string;
  aiBudgetUsd?: string;
  browser: string;
  databaseId?: string;
  databaseName?: string;
  endpoint?: string;
  installation: string;
  json?: boolean;
  sandbox?: boolean;
  setupGithub?: boolean;
  timeoutMs: string;
  workerName?: string;
}

interface DoctorCommandOptions {
  authenticated?: boolean;
  browser: string;
  endpoint?: string;
  installation?: string;
  json?: boolean;
  timeoutMs: string;
}

interface AgentRehearsalCommandOptions {
  browser: string;
  confirmProduction: boolean;
  endpoint?: string;
  installation?: string;
  json?: boolean;
  runTimeoutMs: string;
  timeoutMs: string;
}

interface StandingIntegrationRehearsalCommandOptions extends AgentRehearsalCommandOptions {
  connectionId: string;
  trigger: string;
}

interface InstallationRehearsalCommandOptions {
  accountId?: string;
  aiBudgetUsd?: string;
  browser: string;
  cleanupOnly?: boolean;
  confirmProduction: boolean;
  databaseName: string;
  endpoint: string;
  json?: boolean;
  receipt?: string;
  runTimeoutMs: string;
  timeoutMs: string;
  workerName: string;
}

interface UpgradeRehearsalCommandOptions {
  browser: string;
  confirmProduction: boolean;
  endpoint?: string;
  fromFingerprint: string;
  installation?: string;
  json?: boolean;
  receipt: string;
  timeoutMs: string;
}

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function parseOrigin(
  endpoint: string | undefined,
  kind:
    | "up"
    | "doctor"
    | "agent-rehearsal"
    | "installation-rehearsal"
    | "standing-integration-rehearsal"
    | "upgrade-rehearsal",
) {
  if (endpoint === undefined) {
    return undefined;
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

  if (
    (kind === "up" ||
      kind === "agent-rehearsal" ||
      kind === "installation-rehearsal" ||
      kind === "standing-integration-rehearsal" ||
      kind === "upgrade-rehearsal") &&
    origin.protocol !== "https:"
  ) {
    throw new CliUsageError(
      `${
        kind === "agent-rehearsal"
          ? "rehearse agent"
          : kind === "installation-rehearsal"
            ? "rehearse installation"
            : kind === "standing-integration-rehearsal"
              ? "rehearse integration"
              : kind === "upgrade-rehearsal"
                ? "rehearse upgrade"
                : kind
      } requires an HTTPS endpoint.`,
    );
  }

  return origin;
}

function parseBrowserMode(value: string): BrowserMode {
  const browser = browserModeSchema.safeParse(value);

  if (!browser.success) {
    throw new CliUsageError("Browser must be system, codex, or none.");
  }

  return browser.data;
}

function validatedCommand(candidate: unknown): Exclude<CliCommand, { kind: "help" }> {
  const command = cliCommandSchema.safeParse(candidate);

  if (!command.success || command.data.kind === "help") {
    throw new CliUsageError("One or more command values were invalid or outside their bounds.");
  }

  return command.data;
}

function createCliProgram(
  onCommand?: (command: Exclude<CliCommand, { kind: "help" }>) => void,
  output?: OutputConfiguration,
  color = false,
) {
  const style = createCliTextStyle(color);
  const program = new Command()
    .name("crewhelm")
    .description("Deploy and diagnose a personal Crewhelm control plane.")
    .version(CREWHELM_CLI_VERSION)
    .option("--no-color", "disable terminal colors")
    .helpCommand(true)
    .configureHelp({
      styleArgumentTerm: style.warning,
      styleCommandDescription: style.muted,
      styleCommandText: style.strong,
      styleDescriptionText: style.muted,
      styleOptionDescription: style.muted,
      styleOptionTerm: style.accent,
      styleSubcommandDescription: style.muted,
      styleSubcommandTerm: style.accent,
      styleTitle: style.accentStrong,
      styleUsage: style.strong,
    })
    .addHelpText("after", formatRootHelp(style));

  if (output) {
    program.exitOverride();
    program.configureOutput(output);
  }

  program
    .command("version")
    .summary("show CLI and packaged Worker identity")
    .description("Show the CLI version and optionally its packaged Worker identity.")
    .option("--json", "write one machine-readable JSON result")
    .action((options: { json?: boolean }) => {
      onCommand?.(
        validatedCommand({
          json: options.json === true,
          kind: "version",
        }),
      );
    });

  program
    .command("up")
    .summary("create or safely upgrade an installation")
    .description("Create or safely upgrade one Crewhelm installation.")
    .option("--endpoint <origin>", "HTTPS origin for the Crewhelm Worker")
    .option("--installation <path>", "installation metadata path", "crewhelm.installation.json")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--setup-github", "create or rotate the private GitHub App")
    .option("--account-id <id>", "Cloudflare account identifier")
    .option("--worker-name <name>", "Cloudflare Worker name")
    .option("--database-name <name>", "D1 database name")
    .option("--database-id <uuid>", "existing D1 database identifier")
    .option("--ai-budget-usd <dollars>", "daily AI Gateway hard spend limit")
    .option("--sandbox", "enable bounded Agent code execution (requires Workers Paid)")
    .option("--no-sandbox", "disable bounded Agent code execution")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatUpHelp(style))
    .action((options: UpCommandOptions) => {
      onCommand?.(
        validatedCommand({
          accountId: options.accountId,
          aiDailySpendUsd:
            options.aiBudgetUsd === undefined ? undefined : Number(options.aiBudgetUsd),
          browser: parseBrowserMode(options.browser),
          databaseId: options.databaseId,
          databaseName: options.databaseName,
          installationPath: options.installation,
          json: options.json === true,
          kind: "up",
          origin: parseOrigin(options.endpoint, "up"),
          sandboxEnabled: options.sandbox,
          setupGitHub: options.setupGithub === true,
          timeoutMs: Number(options.timeoutMs),
          workerName: options.workerName,
        }),
      );
    });

  program
    .command("doctor")
    .summary("validate deployment health and OAuth discovery")
    .description("Validate bounded health, MCP discovery, and optional owner access.")
    .option("--endpoint <origin>", "Crewhelm deployment origin")
    .option("--installation <path>", "authoritative installation metadata path")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--authenticated", "verify temporary view-only owner access")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatDoctorHelp(style))
    .action((options: DoctorCommandOptions) => {
      onCommand?.(
        validatedCommand({
          authenticated: options.authenticated === true,
          browser: parseBrowserMode(options.browser),
          installationPath: options.installation,
          json: options.json === true,
          kind: "doctor",
          origin: parseOrigin(options.endpoint, "doctor"),
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  const rehearse = program
    .command("rehearse")
    .summary("run explicit production rehearsals")
    .description("Run explicit, mutating production rehearsals.");

  rehearse
    .command("agent")
    .summary("rehearse one disposable Agent lifecycle")
    .description("Create, run, disable, and verify one zero-grant disposable Agent.")
    .option("--endpoint <origin>", "HTTPS Crewhelm deployment origin")
    .requiredOption("--confirm-production", "confirm the mutating production rehearsal")
    .option("--installation <path>", "authoritative installation metadata path")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--run-timeout-ms <milliseconds>", "maximum Agent run duration", "120000")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatAgentRehearsalHelp(style))
    .action((options: AgentRehearsalCommandOptions) => {
      onCommand?.(
        validatedCommand({
          browser: parseBrowserMode(options.browser),
          confirmProduction: options.confirmProduction,
          installationPath: options.installation ?? "crewhelm.installation.json",
          installationProvided: options.installation !== undefined,
          json: options.json === true,
          kind: "agent-rehearsal",
          origin: parseOrigin(options.endpoint, "agent-rehearsal"),
          runTimeoutMs: Number(options.runTimeoutMs),
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  rehearse
    .command("upgrade")
    .summary("rehearse one supported installation upgrade")
    .description("Upgrade and verify one existing pinned Crewhelm installation fixture.")
    .option("--endpoint <origin>", "HTTPS origin for the fixture Worker")
    .requiredOption("--from-fingerprint <sha256>", "exact pinned baseline build fingerprint")
    .requiredOption("--confirm-production", "confirm the mutating production rehearsal")
    .option("--installation <path>", "authoritative installation metadata path")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--receipt <path>", "recovery receipt path", "crewhelm.upgrade-receipt.json")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatUpgradeRehearsalHelp(style))
    .action((options: UpgradeRehearsalCommandOptions) => {
      onCommand?.(
        validatedCommand({
          baselineFingerprint: options.fromFingerprint,
          browser: parseBrowserMode(options.browser),
          confirmProduction: options.confirmProduction,
          installationPath: options.installation ?? "crewhelm.installation.json",
          installationProvided: options.installation !== undefined,
          json: options.json === true,
          kind: "upgrade-rehearsal",
          origin: parseOrigin(options.endpoint, "upgrade-rehearsal"),
          receiptPath: options.receipt,
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  rehearse
    .command("integration")
    .summary("rehearse one standing Gmail draft action")
    .description(
      "Create one non-deliverable Gmail draft through an exact, one-call standing capability grant.",
    )
    .option("--endpoint <origin>", "HTTPS Crewhelm deployment origin")
    .requiredOption("--connection-id <id>", "exact authorized Crewhelm Gmail connection")
    .requiredOption("--confirm-production", "confirm the mutating production rehearsal")
    .option("--installation <path>", "authoritative installation metadata path")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--trigger <trigger>", "manual or schedule", "manual")
    .option("--run-timeout-ms <milliseconds>", "maximum trigger and Agent run duration", "180000")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatStandingIntegrationRehearsalHelp(style))
    .action((options: StandingIntegrationRehearsalCommandOptions) => {
      onCommand?.(
        validatedCommand({
          browser: parseBrowserMode(options.browser),
          confirmProduction: options.confirmProduction,
          connectionId: options.connectionId,
          installationPath: options.installation ?? "crewhelm.installation.json",
          installationProvided: options.installation !== undefined,
          json: options.json === true,
          kind: "standing-integration-rehearsal",
          origin: parseOrigin(options.endpoint, "standing-integration-rehearsal"),
          runTimeoutMs: Number(options.runTimeoutMs),
          timeoutMs: Number(options.timeoutMs),
          trigger: options.trigger,
        }),
      );
    });

  rehearse
    .command("installation")
    .summary("rehearse one isolated fresh installation")
    .description("Create, exercise, and exactly remove one fresh Crewhelm installation.")
    .requiredOption("--endpoint <origin>", "HTTPS origin for the rehearsal Worker")
    .requiredOption("--worker-name <name>", "unused crewhelm-rehearsal-* Worker name")
    .requiredOption("--database-name <name>", "unused crewhelm-rehearsal-* D1 database name")
    .requiredOption("--confirm-production", "confirm Cloudflare resource creation and deletion")
    .option("--browser <browser>", "system, codex, or none", "system")
    .option("--account-id <id>", "Cloudflare account identifier")
    .option("--ai-budget-usd <dollars>", "create an AI Gateway with this daily hard limit")
    .option("--receipt <path>", "recovery receipt path")
    .option("--cleanup-only", "retry exact cleanup from an existing receipt")
    .option("--run-timeout-ms <milliseconds>", "maximum Agent run duration", "120000")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatInstallationRehearsalHelp(style))
    .action((options: InstallationRehearsalCommandOptions) => {
      onCommand?.(
        validatedCommand({
          accountId: options.accountId,
          aiDailySpendUsd:
            options.aiBudgetUsd === undefined ? undefined : Number(options.aiBudgetUsd),
          browser: parseBrowserMode(options.browser),
          cleanupOnly: options.cleanupOnly === true,
          confirmProduction: options.confirmProduction,
          databaseName: options.databaseName,
          json: options.json === true,
          kind: "installation-rehearsal",
          origin: parseOrigin(options.endpoint, "installation-rehearsal"),
          // Keep the established path so an interrupted pre-rename cleanup remains discoverable.
          receiptPath: options.receipt ?? "crewhelm.smoke-receipt.json",
          runTimeoutMs: Number(options.runTimeoutMs),
          timeoutMs: Number(options.timeoutMs),
          workerName: options.workerName,
        }),
      );
    });

  return program;
}

function rootHelpInformation(color: boolean): string {
  const style = createCliTextStyle(color);
  return `${createCliProgram(undefined, undefined, color).helpInformation()}${formatRootHelp(style)}`;
}

export const CLI_HELP = rootHelpInformation(false);

function rejectDuplicateFlags(arguments_: readonly string[]): void {
  const seenFlags = new Set<string>();

  for (const argument of arguments_) {
    if (!argument.startsWith("--") || argument === "--") {
      continue;
    }

    const flag = argument.split("=", 1)[0]!;

    if (seenFlags.has(flag)) {
      throw new CliUsageError("A flag was provided more than once.");
    }

    seenFlags.add(flag);
  }
}

function commanderMessage(error: CommanderError): string {
  if (error.code === "commander.unknownCommand") {
    return "Unknown command.";
  }

  if (error.code === "commander.unknownOption") {
    return "Unknown flag.";
  }

  if (error.code === "commander.excessArguments") {
    return "Unexpected positional argument.";
  }

  const message = error.message.replace(/^error:\s*/iu, "").trim();
  return message.length === 0 ? "The command line was invalid." : message;
}

function hasFlag(arguments_: readonly string[], flag: string): boolean {
  return arguments_.some((argument) => argument === flag || argument.startsWith(`${flag}=`));
}

export function parseCli(
  arguments_: readonly string[],
  options: { color?: boolean } = {},
): CliCommand {
  rejectDuplicateFlags(arguments_);

  if (arguments_.length === 0) {
    return { kind: "help", text: rootHelpInformation(options.color === true) };
  }

  const helpRequested = hasFlag(arguments_, "--help") || arguments_.includes("-h");
  const agentRehearsal = arguments_[0] === "rehearse" && arguments_[1] === "agent";
  const integrationRehearsal = arguments_[0] === "rehearse" && arguments_[1] === "integration";
  const installationRehearsal = arguments_[0] === "rehearse" && arguments_[1] === "installation";
  const upgradeRehearsal = arguments_[0] === "rehearse" && arguments_[1] === "upgrade";

  if (
    !helpRequested &&
    (agentRehearsal || integrationRehearsal || installationRehearsal || upgradeRehearsal) &&
    !hasFlag(arguments_, "--confirm-production")
  ) {
    throw new CliUsageError(
      `${
        integrationRehearsal
          ? "rehearse integration"
          : installationRehearsal
            ? "rehearse installation"
            : upgradeRehearsal
              ? "rehearse upgrade"
              : "rehearse agent"
      } requires --confirm-production.`,
    );
  }

  if (!helpRequested && installationRehearsal && !hasFlag(arguments_, "--endpoint")) {
    throw new CliUsageError("rehearse installation requires --endpoint.");
  }

  if (
    !helpRequested &&
    (arguments_[0] === "doctor" || agentRehearsal || integrationRehearsal || upgradeRehearsal) &&
    !hasFlag(arguments_, "--endpoint") &&
    !hasFlag(arguments_, "--installation")
  ) {
    throw new CliUsageError(
      `${
        agentRehearsal
          ? "rehearse agent"
          : integrationRehearsal
            ? "rehearse integration"
            : upgradeRehearsal
              ? "rehearse upgrade"
              : "doctor"
      } requires --endpoint or --installation.`,
    );
  }

  let command: Exclude<CliCommand, { kind: "help" }> | undefined;
  let helpText = "";
  const program = createCliProgram(
    (parsed) => {
      command = parsed;
    },
    {
      getOutHasColors: () => options.color === true,
      writeErr: () => {},
      writeOut: (text) => {
        helpText += text;
      },
    },
    options.color === true,
  );

  try {
    program.parse(arguments_, { from: "user" });
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error;
    }

    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        return { kind: "help", text: helpText || CLI_HELP };
      }

      if (error.code === "commander.version") {
        return { json: false, kind: "version" };
      }

      throw new CliUsageError(commanderMessage(error));
    }

    throw error;
  }

  if (command === undefined) {
    throw new CliUsageError("Unknown command.");
  }

  return command;
}
