import { Chalk, type ChalkInstance } from "chalk";
import { Command, CommanderError, type OutputConfiguration } from "commander";
import { connectionIdSchema } from "@crewhelm/contracts";
import * as z from "zod";

import { bootstrapOptionsSchema } from "./bootstrap.js";
import { DoctorInputError, parseDeploymentOrigin } from "./doctor.js";

function formatRootHelp(style: ChalkInstance): string {
  return `
${style.cyan.bold("Examples:")}
  ${style.cyan("$ crewhelm up")}
  ${style.cyan("$ crewhelm doctor --endpoint https://crewhelm.example")}
  ${style.cyan("$ crewhelm smoke agent --help")}
  ${style.cyan("$ crewhelm smoke integration --help")}

${style.dim("Run crewhelm <command> --help for command-specific options and safety notes.")}
`;
}

function formatUpHelp(style: ChalkInstance): string {
  return `
${style.cyan.bold("Examples:")}
  ${style.cyan("$ crewhelm up")}
  ${style.cyan("$ crewhelm up --endpoint https://crewhelm.example --ai-budget-usd 5")}

${style.cyan.bold("Automation:")}
  Set these variables to run without prompts:
    ${style.yellow("CREWHELM_GITHUB_CLIENT_ID")}
    ${style.yellow("CREWHELM_GITHUB_CLIENT_SECRET")}
    ${style.yellow("CREWHELM_OWNER_GITHUB_USER_ID")}
    ${style.yellow("CREWHELM_COMPOSIO_API_KEY")}

  When Wrangler OAuth cannot manage AI Gateway, also set:
    ${style.yellow("CREWHELM_CLOUDFLARE_API_TOKEN")}

${style.cyan.bold("Safety:")}
  Preserves deployed secrets and recovers missing installation metadata before mutation.
  Requires an HTTPS endpoint. ${style.cyan("--json")} disables prompts and browser setup.
`;
}

function formatDoctorHelp(style: ChalkInstance): string {
  return `
${style.cyan.bold("Examples:")}
  ${style.cyan("$ crewhelm doctor --endpoint https://crewhelm.example")}
  ${style.cyan("$ crewhelm doctor --endpoint https://crewhelm.example --authenticated")}

${style.cyan.bold("Access:")}
  ${style.cyan("--authenticated")} opens the browser for temporary view-only owner access.
  The temporary diagnostic token is revoked before exit.

${style.cyan.bold("Network:")}
  HTTPS is required except for exact loopback hosts.
`;
}

function formatAgentSmokeHelp(style: ChalkInstance): string {
  return `
${style.yellow.bold("Production rehearsal:")}
  Creates and runs one zero-grant disposable Agent, then disables it.
  Requests temporary Full control and verifies token revocation before exit.
  Requires ${style.yellow("--confirm-production")} and an HTTPS endpoint.
`;
}

function formatStandingIntegrationSmokeHelp(style: ChalkInstance): string {
  return `
${style.yellow.bold("Production rehearsal:")}
  Creates one draft to the reserved, non-deliverable example.invalid domain.
  Requires an exact authorized Gmail connection and retains the draft for verification.
  Revokes the grant, disables the Agent, and revokes temporary Full control before exit.
  Requires ${style.yellow("--confirm-production")} and an HTTPS endpoint.
`;
}

const cliCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("help"),
    text: z.string(),
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
    connectionId: connectionIdSchema,
    json: z.boolean(),
    kind: z.literal("standing-integration-smoke"),
    origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
    runTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1_000),
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

interface UpCommandOptions {
  accountId?: string;
  aiBudgetUsd?: string;
  databaseId?: string;
  databaseName?: string;
  endpoint?: string;
  installation: string;
  json?: boolean;
  setupGithub?: boolean;
  timeoutMs: string;
  workerName?: string;
}

interface DoctorCommandOptions {
  authenticated?: boolean;
  endpoint: string;
  json?: boolean;
  timeoutMs: string;
}

interface AgentSmokeCommandOptions {
  confirmProduction: boolean;
  endpoint: string;
  json?: boolean;
  runTimeoutMs: string;
  timeoutMs: string;
}

interface StandingIntegrationSmokeCommandOptions extends AgentSmokeCommandOptions {
  connectionId: string;
}

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function parseOrigin(
  endpoint: string | undefined,
  kind: "up" | "doctor" | "agent-smoke" | "standing-integration-smoke",
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
    (kind === "up" || kind === "agent-smoke" || kind === "standing-integration-smoke") &&
    origin.protocol !== "https:"
  ) {
    throw new CliUsageError(
      `${
        kind === "agent-smoke"
          ? "smoke agent"
          : kind === "standing-integration-smoke"
            ? "smoke integration"
            : kind
      } requires an HTTPS endpoint.`,
    );
  }

  return origin;
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
  const style = new Chalk({ level: color ? 1 : 0 });
  const program = new Command()
    .name("crewhelm")
    .description("Deploy and diagnose a personal Crewhelm control plane.")
    .option("--no-color", "disable terminal colors")
    .helpCommand(true)
    .configureHelp({
      styleArgumentTerm: style.yellow,
      styleCommandDescription: style.dim,
      styleCommandText: style.bold,
      styleDescriptionText: style.dim,
      styleOptionDescription: style.dim,
      styleOptionTerm: style.cyan,
      styleSubcommandDescription: style.dim,
      styleSubcommandTerm: style.cyan,
      styleTitle: style.cyan.bold,
      styleUsage: style.bold,
    })
    .addHelpText("after", formatRootHelp(style));

  if (output) {
    program.exitOverride();
    program.configureOutput(output);
  }

  program
    .command("up")
    .summary("create or safely upgrade an installation")
    .description("Create or safely upgrade one Crewhelm installation.")
    .option("--endpoint <origin>", "HTTPS origin for the Crewhelm Worker")
    .option("--installation <path>", "installation metadata path", "crewhelm.installation.json")
    .option("--setup-github", "create or rotate the private GitHub App")
    .option("--account-id <id>", "Cloudflare account identifier")
    .option("--worker-name <name>", "Cloudflare Worker name")
    .option("--database-name <name>", "D1 database name")
    .option("--database-id <uuid>", "existing D1 database identifier")
    .option("--ai-budget-usd <dollars>", "daily AI Gateway hard spend limit")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatUpHelp(style))
    .action((options: UpCommandOptions) => {
      onCommand?.(
        validatedCommand({
          accountId: options.accountId,
          aiDailySpendUsd:
            options.aiBudgetUsd === undefined ? undefined : Number(options.aiBudgetUsd),
          databaseId: options.databaseId,
          databaseName: options.databaseName,
          installationPath: options.installation,
          json: options.json === true,
          kind: "up",
          origin: parseOrigin(options.endpoint, "up"),
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
    .requiredOption("--endpoint <origin>", "Crewhelm deployment origin")
    .option("--authenticated", "verify temporary view-only owner access")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatDoctorHelp(style))
    .action((options: DoctorCommandOptions) => {
      onCommand?.(
        validatedCommand({
          authenticated: options.authenticated === true,
          json: options.json === true,
          kind: "doctor",
          origin: parseOrigin(options.endpoint, "doctor"),
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  const smoke = program
    .command("smoke")
    .summary("run explicit production rehearsals")
    .description("Run explicit, mutating production rehearsals.");

  smoke
    .command("agent")
    .summary("rehearse one disposable Agent lifecycle")
    .description("Create, run, disable, and verify one zero-grant disposable Agent.")
    .requiredOption("--endpoint <origin>", "HTTPS Crewhelm deployment origin")
    .requiredOption("--confirm-production", "confirm the mutating production rehearsal")
    .option("--run-timeout-ms <milliseconds>", "maximum Agent run duration", "120000")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatAgentSmokeHelp(style))
    .action((options: AgentSmokeCommandOptions) => {
      onCommand?.(
        validatedCommand({
          confirmProduction: options.confirmProduction,
          json: options.json === true,
          kind: "agent-smoke",
          origin: parseOrigin(options.endpoint, "agent-smoke"),
          runTimeoutMs: Number(options.runTimeoutMs),
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  smoke
    .command("integration")
    .summary("rehearse one standing Gmail draft action")
    .description(
      "Create one non-deliverable Gmail draft through an exact, one-call standing capability grant.",
    )
    .requiredOption("--endpoint <origin>", "HTTPS Crewhelm deployment origin")
    .requiredOption("--connection-id <id>", "exact authorized Crewhelm Gmail connection")
    .requiredOption("--confirm-production", "confirm the mutating production rehearsal")
    .option("--run-timeout-ms <milliseconds>", "maximum Agent run duration", "120000")
    .option("--timeout-ms <milliseconds>", "timeout for each diagnostic request", "5000")
    .option("--json", "write one machine-readable JSON result")
    .addHelpText("after", formatStandingIntegrationSmokeHelp(style))
    .action((options: StandingIntegrationSmokeCommandOptions) => {
      onCommand?.(
        validatedCommand({
          confirmProduction: options.confirmProduction,
          connectionId: options.connectionId,
          json: options.json === true,
          kind: "standing-integration-smoke",
          origin: parseOrigin(options.endpoint, "standing-integration-smoke"),
          runTimeoutMs: Number(options.runTimeoutMs),
          timeoutMs: Number(options.timeoutMs),
        }),
      );
    });

  return program;
}

function rootHelpInformation(color: boolean): string {
  const style = new Chalk({ level: color ? 1 : 0 });
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
  const agentSmoke = arguments_[0] === "smoke" && arguments_[1] === "agent";
  const integrationSmoke = arguments_[0] === "smoke" && arguments_[1] === "integration";

  if (
    !helpRequested &&
    (agentSmoke || integrationSmoke) &&
    !hasFlag(arguments_, "--confirm-production")
  ) {
    throw new CliUsageError(
      `${integrationSmoke ? "smoke integration" : "smoke agent"} requires --confirm-production.`,
    );
  }

  if (
    !helpRequested &&
    (arguments_[0] === "doctor" || agentSmoke || integrationSmoke) &&
    !hasFlag(arguments_, "--endpoint")
  ) {
    throw new CliUsageError(
      `${
        agentSmoke ? "agent-smoke" : integrationSmoke ? "standing-integration-smoke" : "doctor"
      } requires --endpoint.`,
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

      throw new CliUsageError(commanderMessage(error));
    }

    throw error;
  }

  if (command === undefined) {
    throw new CliUsageError("Unknown command.");
  }

  return command;
}
