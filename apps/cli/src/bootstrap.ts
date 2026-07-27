import { randomBytes, randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import * as z from "zod";

import {
  diagnoseDeployment,
  doctorReportSchema,
  type DoctorDependencies,
  type DoctorReport,
} from "./doctor.js";
import { type RunWrangler, type WranglerResult, WranglerExecutionError } from "./wrangler.js";

const REQUIRED_SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID",
] as const;
const GITHUB_SECRET_ENVIRONMENT = {
  clientId: "CREWHELM_GITHUB_CLIENT_ID",
  clientSecret: "CREWHELM_GITHUB_CLIENT_SECRET",
  ownerUserId: "CREWHELM_OWNER_GITHUB_USER_ID",
} as const;
const EXPECTED_DEPLOYMENT_FILES = [
  "index.js",
  "index.js.map",
  "migrations",
  "wrangler-template.json",
] as const;
const EXPECTED_MIGRATIONS = ["0001_better_auth.sql", "0002_control_write_scope.sql"] as const;
const MAX_ASSET_BYTES = 10 * 1_048_576;
const MAX_MIGRATION_BYTES = 1_048_576;
const WORKER_NOT_FOUND_CODE = /\[code:\s*10007\]/u;
const TABLE_INVENTORY_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name";
const MIGRATION_INVENTORY_SQL = "SELECT name FROM d1_migrations ORDER BY id";
const ALLOWED_AUTH_TABLES = new Set([
  "_cf_KV",
  "account",
  "d1_migrations",
  "jwks",
  "mcpClientRegistration",
  "mcpTokenRevocation",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
  "session",
  "sqlite_sequence",
  "user",
  "verification",
]);
const PLATFORM_TABLES = new Set(["_cf_KV", "sqlite_sequence"]);

const deploymentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const accountIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const databaseIdSchema = z.uuid();
const d1DatabaseSchema = z.looseObject({
  name: z.string(),
  uuid: databaseIdSchema,
});
const d1ListSchema = z.array(d1DatabaseSchema).max(10_000);
const githubSecretsSchema = z.strictObject({
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().min(1).max(1_024),
  ownerUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const whoamiSchema = z.looseObject({
  accounts: z
    .array(
      z.looseObject({
        id: accountIdSchema,
      }),
    )
    .min(1)
    .max(100),
  loggedIn: z.literal(true),
});
const deploymentSchema = z.looseObject({
  annotations: z.record(z.string(), z.unknown()).optional(),
  id: z.uuid(),
});
const deploymentListSchema = z.array(deploymentSchema).max(100);
const queryResultSchema = z.tuple([
  z.looseObject({
    results: z.array(z.looseObject({ name: z.string() })).max(100),
    success: z.literal(true),
  }),
]);
const deploymentTemplateSchema = z.strictObject({
  compatibility_date: z.literal("2026-07-22"),
  compatibility_flags: z.tuple([z.literal("nodejs_compat")]),
  d1_databases: z.tuple([
    z.strictObject({
      binding: z.literal("AUTH_DB"),
      database_id: databaseIdSchema,
      database_name: z.string(),
      migrations_dir: z.literal("./migrations"),
    }),
  ]),
  durable_objects: z.strictObject({
    bindings: z.tuple([
      z.strictObject({
        class_name: z.literal("OwnerControlPlane"),
        name: z.literal("OWNER_CONTROL_PLANE"),
      }),
    ]),
  }),
  exports: z.strictObject({
    OwnerControlPlane: z.strictObject({
      storage: z.literal("sqlite"),
      type: z.literal("durable-object"),
    }),
  }),
  main: z.literal("./index.js"),
  name: z.literal("crewhelm"),
  ratelimits: z.tuple([
    z.strictObject({
      name: z.literal("AUTH_RATE_LIMIT"),
      namespace_id: z.literal("10001"),
      simple: z.strictObject({
        limit: z.literal(10),
        period: z.literal(60),
      }),
    }),
    z.strictObject({
      name: z.literal("MCP_RATE_LIMIT"),
      namespace_id: z.literal("10002"),
      simple: z.strictObject({
        limit: z.literal(60),
        period: z.literal(60),
      }),
    }),
  ]),
  triggers: z.strictObject({
    crons: z.tuple([z.literal("17 * * * *")]),
  }),
  vars: z.strictObject({
    PUBLIC_ORIGIN: z.url(),
  }),
});

export const bootstrapOptionsSchema = z.strictObject({
  accountId: accountIdSchema.optional(),
  databaseId: databaseIdSchema.optional(),
  databaseName: deploymentNameSchema,
  origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
  timeoutMs: z.number().int().min(100).max(30_000),
  workerName: deploymentNameSchema,
});

const bootstrapFailureStageSchema = z.enum([
  "assets",
  "authentication",
  "worker",
  "configuration",
  "database",
  "migrations",
  "deployment",
]);

export const bootstrapFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.literal(false),
  stage: bootstrapFailureStageSchema,
  message: z.string(),
});

export const bootstrapReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  account: z.strictObject({
    id: accountIdSchema,
  }),
  database: z.strictObject({
    action: z.enum(["created", "reused"]),
    id: databaseIdSchema,
    name: z.string(),
  }),
  deployment: z.strictObject({
    action: z.enum(["created", "updated"]),
    origin: z.url(),
    workerName: z.string(),
  }),
  doctor: doctorReportSchema,
});

export type BootstrapFailure = z.infer<typeof bootstrapFailureSchema>;
export type BootstrapOptions = z.infer<typeof bootstrapOptionsSchema>;
export type BootstrapReport = z.infer<typeof bootstrapReportSchema>;
type BootstrapFailureStage = z.infer<typeof bootstrapFailureStageSchema>;
type DeploymentTemplate = z.infer<typeof deploymentTemplateSchema>;
type GitHubSecrets = z.infer<typeof githubSecretsSchema>;

interface DeploymentAssets {
  migrations: readonly string[];
  template: DeploymentTemplate;
}

interface CloudflareContext {
  accountConfigPath: string;
  cwd: string;
  dependencies: BootstrapDependencies;
}

interface WorkerInventory {
  deployments: z.infer<typeof deploymentListSchema>;
  exists: boolean;
}

export interface BootstrapDependencies extends DoctorDependencies {
  deploymentAssetsDirectory: string;
  readEnvironment: (name: string) => string | undefined;
  runWrangler: RunWrangler;
}

export class BootstrapError extends Error {
  override readonly name = "BootstrapError";

  constructor(
    readonly stage: BootstrapFailureStage,
    message: string,
  ) {
    super(message);
  }
}

function commandFailed(stage: BootstrapFailureStage, message: string): BootstrapError {
  return new BootstrapError(stage, message);
}

async function createPrivateWorkspace(): Promise<string> {
  let directory: string | undefined;

  try {
    directory = await mkdtemp(resolve(tmpdir(), "crewhelm-bootstrap-"));
    await chmod(directory, 0o700);
    return directory;
  } catch {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }

    throw commandFailed("configuration", "Private bootstrap workspace could not be created.");
  }
}

async function removePrivateWorkspace(directory: string): Promise<void> {
  try {
    await rm(directory, { force: true, recursive: true });
  } catch {
    throw commandFailed("configuration", "Private bootstrap files could not be removed.");
  }
}

async function runCloudflare(
  context: Pick<CloudflareContext, "cwd" | "dependencies">,
  arguments_: readonly string[],
  stage: BootstrapFailureStage,
): Promise<WranglerResult> {
  try {
    return await context.dependencies.runWrangler(arguments_, { cwd: context.cwd });
  } catch (error) {
    if (error instanceof WranglerExecutionError) {
      throw commandFailed(stage, error.message);
    }

    throw error;
  }
}

function requireCompleted(
  result: WranglerResult,
  stage: BootstrapFailureStage,
  message: string,
): void {
  if (result.outcome !== "completed") {
    throw commandFailed(stage, message);
  }
}

async function loadDeploymentAssets(
  dependencies: BootstrapDependencies,
): Promise<DeploymentAssets> {
  try {
    const entries = await readdir(dependencies.deploymentAssetsDirectory, {
      withFileTypes: true,
    });
    const entryNames = entries.map((entry) => entry.name).toSorted();

    if (entryNames.join("\n") !== EXPECTED_DEPLOYMENT_FILES.toSorted().join("\n")) {
      throw new Error("Unexpected deployment asset inventory.");
    }

    for (const name of ["index.js", "index.js.map", "wrangler-template.json"]) {
      const file = await lstat(resolve(dependencies.deploymentAssetsDirectory, name));

      if (!file.isFile() || file.size > MAX_ASSET_BYTES) {
        throw new Error("Unexpected deployment asset.");
      }
    }

    const migrationDirectory = resolve(dependencies.deploymentAssetsDirectory, "migrations");
    const migrationDirectoryStat = await lstat(migrationDirectory);
    const migrationEntries = await readdir(migrationDirectory, { withFileTypes: true });
    const migrationNames = migrationEntries.map((entry) => entry.name).toSorted();

    if (
      !migrationDirectoryStat.isDirectory() ||
      migrationNames.join("\n") !== EXPECTED_MIGRATIONS.toSorted().join("\n")
    ) {
      throw new Error("Unexpected migration inventory.");
    }

    for (const entry of migrationEntries) {
      const migration = await lstat(resolve(migrationDirectory, entry.name));

      if (!entry.isFile() || !migration.isFile() || migration.size > MAX_MIGRATION_BYTES) {
        throw new Error("Unexpected migration asset.");
      }
    }

    const template = deploymentTemplateSchema.parse(
      JSON.parse(
        await readFile(
          resolve(dependencies.deploymentAssetsDirectory, "wrangler-template.json"),
          "utf8",
        ),
      ),
    );
    return { migrations: migrationNames, template };
  } catch {
    throw commandFailed("assets", "Packaged deployment assets are invalid.");
  }
}

async function authenticate(
  options: BootstrapOptions,
  cwd: string,
  configPath: string,
  dependencies: BootstrapDependencies,
) {
  const result = await runCloudflare(
    { cwd, dependencies },
    ["whoami", "--json", "--config", configPath],
    "authentication",
  );
  requireCompleted(
    result,
    "authentication",
    "Cloudflare authentication outcome could not be confirmed.",
  );

  if (result.exitCode !== 0) {
    throw commandFailed("authentication", "Authenticate Wrangler with Cloudflare and retry.");
  }

  let identity: z.infer<typeof whoamiSchema>;

  try {
    identity = whoamiSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw commandFailed("authentication", "Cloudflare account inventory was invalid.");
  }

  if (options.accountId) {
    const selected = identity.accounts.find((account) => account.id === options.accountId);

    if (!selected) {
      throw commandFailed(
        "configuration",
        "The requested Cloudflare account is not available to this Wrangler identity.",
      );
    }

    return selected;
  }

  if (identity.accounts.length !== 1 || !identity.accounts[0]) {
    throw commandFailed(
      "configuration",
      "More than one Cloudflare account is available; select one with --account-id.",
    );
  }

  return identity.accounts[0];
}

async function writeAccountConfig(cwd: string, accountId?: string): Promise<string> {
  const path = resolve(cwd, "account.json");

  try {
    const config = accountId ? { account_id: accountId } : {};
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return path;
  } catch {
    throw commandFailed("configuration", "Cloudflare account context could not be staged.");
  }
}

async function readWorkerInventory(
  workerName: string,
  context: CloudflareContext,
): Promise<WorkerInventory> {
  const result = await runCloudflare(
    context,
    ["deployments", "list", "--name", workerName, "--json", "--config", context.accountConfigPath],
    "worker",
  );
  requireCompleted(result, "worker", "Worker inventory outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    if (WORKER_NOT_FOUND_CODE.test(result.stderr)) {
      return { deployments: [], exists: false };
    }

    throw commandFailed("worker", "Worker inventory could not be read.");
  }

  try {
    return {
      deployments: deploymentListSchema.parse(JSON.parse(result.stdout)),
      exists: true,
    };
  } catch {
    throw commandFailed("worker", "Worker inventory returned an invalid response.");
  }
}

function readGitHubSecrets(
  workerExists: boolean,
  dependencies: BootstrapDependencies,
): GitHubSecrets | undefined {
  const candidate = {
    clientId: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.clientId),
    clientSecret: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.clientSecret),
    ownerUserId: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.ownerUserId),
  };
  const suppliedCount = Object.values(candidate).filter((value) => value !== undefined).length;

  if (workerExists && suppliedCount === 0) {
    return undefined;
  }

  if (suppliedCount !== 3) {
    throw commandFailed(
      "configuration",
      `Set ${Object.values(GITHUB_SECRET_ENVIRONMENT).join(", ")} together.`,
    );
  }

  const parsed = githubSecretsSchema.safeParse(candidate);

  if (!parsed.success) {
    throw commandFailed("configuration", "GitHub OAuth bootstrap settings are invalid.");
  }

  return parsed.data;
}

async function listDatabases(context: CloudflareContext) {
  const result = await runCloudflare(
    context,
    ["d1", "list", "--json", "--config", context.accountConfigPath],
    "database",
  );
  requireCompleted(result, "database", "D1 inventory outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    throw commandFailed("database", "D1 inventory could not be read.");
  }

  try {
    return d1ListSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw commandFailed("database", "D1 inventory returned an invalid response.");
  }
}

async function executeInventory(
  databaseId: string,
  sql: string,
  context: CloudflareContext,
): Promise<string[]> {
  const result = await runCloudflare(
    context,
    [
      "d1",
      "execute",
      databaseId,
      "--remote",
      "--command",
      sql,
      "--json",
      "--config",
      context.accountConfigPath,
    ],
    "database",
  );
  requireCompleted(result, "database", "D1 provenance check outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    throw commandFailed("database", "D1 provenance could not be verified.");
  }

  try {
    return queryResultSchema.parse(JSON.parse(result.stdout))[0].results.map((row) => row.name);
  } catch {
    throw commandFailed("database", "D1 provenance check returned an invalid response.");
  }
}

async function readAppliedMigrations(
  databaseId: string,
  context: CloudflareContext,
): Promise<string[]> {
  return executeInventory(databaseId, MIGRATION_INVENTORY_SQL, context);
}

async function validateDatabaseForReuse(
  databaseId: string,
  migrations: readonly string[],
  context: CloudflareContext,
): Promise<void> {
  const tables = await executeInventory(databaseId, TABLE_INVENTORY_SQL, context);

  if (tables.some((table) => !ALLOWED_AUTH_TABLES.has(table))) {
    throw commandFailed("database", "The selected D1 database contains non-Crewhelm tables.");
  }

  const applicationTables = tables.filter((table) => !PLATFORM_TABLES.has(table));

  if (
    applicationTables.length === 0 ||
    (applicationTables.length === 1 && applicationTables[0] === "d1_migrations")
  ) {
    if (
      applicationTables[0] === "d1_migrations" &&
      (await readAppliedMigrations(databaseId, context)).length > 0
    ) {
      throw commandFailed(
        "database",
        "The selected D1 database has migration history but no Crewhelm schema.",
      );
    }

    return;
  }

  if (!tables.includes("d1_migrations")) {
    throw commandFailed("database", "The selected D1 database has no Crewhelm provenance.");
  }

  if (
    tables.length !== ALLOWED_AUTH_TABLES.size ||
    [...ALLOWED_AUTH_TABLES].some((table) => !tables.includes(table))
  ) {
    throw commandFailed("database", "The selected Crewhelm D1 schema is incomplete.");
  }

  const applied = await readAppliedMigrations(databaseId, context);

  if (applied.length === 0 || applied.some((migration) => !migrations.includes(migration))) {
    throw commandFailed(
      "database",
      "The selected D1 database migration history is not compatible with this Crewhelm build.",
    );
  }
}

async function ensureDatabase(
  options: BootstrapOptions,
  migrations: readonly string[],
  context: CloudflareContext,
) {
  const existing = (await listDatabases(context)).filter(
    (database) => database.name === options.databaseName,
  );

  if (existing.length > 1) {
    throw commandFailed("database", "More than one D1 database matched the requested name.");
  }

  if (existing[0]) {
    if (!options.databaseId) {
      throw commandFailed(
        "configuration",
        `D1 database ${options.databaseName} already exists. Confirm reuse with --database-id ${existing[0].uuid}.`,
      );
    }

    if (existing[0].uuid !== options.databaseId) {
      throw commandFailed(
        "configuration",
        "The requested D1 database name and ID do not identify the same database.",
      );
    }

    await validateDatabaseForReuse(existing[0].uuid, migrations, context);
    return { action: "reused" as const, database: existing[0] };
  }

  if (options.databaseId) {
    throw commandFailed(
      "configuration",
      "The requested D1 database ID does not match an existing database with that name.",
    );
  }

  const created = await runCloudflare(
    context,
    ["d1", "create", options.databaseName, "--config", context.accountConfigPath],
    "database",
  );
  const reconciled = (await listDatabases(context)).filter(
    (database) => database.name === options.databaseName,
  );

  if (created.outcome !== "completed" || created.exitCode !== 0) {
    if (reconciled.length === 1 && reconciled[0]) {
      throw commandFailed(
        "database",
        `D1 creation outcome was not clean. Inspect it, then confirm reuse with --database-id ${reconciled[0].uuid}.`,
      );
    }

    throw commandFailed("database", "D1 database could not be created.");
  }

  if (reconciled.length !== 1 || !reconciled[0]) {
    throw commandFailed("database", "Created D1 database could not be reconciled.");
  }

  return { action: "created" as const, database: reconciled[0] };
}

async function stageDeployment(
  options: BootstrapOptions,
  accountId: string,
  database: { name: string; uuid: string },
  assets: DeploymentAssets,
  context: CloudflareContext,
): Promise<string> {
  try {
    const workerPath = resolve(context.dependencies.deploymentAssetsDirectory, "index.js");
    const sourceMapPath = resolve(context.dependencies.deploymentAssetsDirectory, "index.js.map");
    const migrationPath = resolve(context.dependencies.deploymentAssetsDirectory, "migrations");
    const configPath = resolve(context.cwd, "wrangler.json");

    await cp(workerPath, resolve(context.cwd, "index.js"));
    await cp(sourceMapPath, resolve(context.cwd, "index.js.map"));
    await cp(migrationPath, resolve(context.cwd, "migrations"), { recursive: true });

    const config = {
      account_id: accountId,
      compatibility_date: assets.template.compatibility_date,
      compatibility_flags: assets.template.compatibility_flags,
      d1_databases: [
        {
          binding: "AUTH_DB",
          database_id: database.uuid,
          database_name: database.name,
          migrations_dir: "./migrations",
        },
      ],
      durable_objects: assets.template.durable_objects,
      exports: assets.template.exports,
      main: "./index.js",
      name: options.workerName,
      ratelimits: assets.template.ratelimits,
      secrets: {
        required: REQUIRED_SECRET_NAMES,
      },
      triggers: assets.template.triggers,
      vars: {
        PUBLIC_ORIGIN: options.origin.origin,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return configPath;
  } catch {
    throw commandFailed("assets", "Packaged deployment assets could not be staged.");
  }
}

async function writeSecretsFile(
  cwd: string,
  github: GitHubSecrets | undefined,
  workerExists: boolean,
): Promise<string | undefined> {
  if (!github) {
    return undefined;
  }

  const secrets: Record<string, string> = {
    GITHUB_CLIENT_ID: github.clientId,
    GITHUB_CLIENT_SECRET: github.clientSecret,
    OWNER_GITHUB_USER_ID: github.ownerUserId,
  };

  if (!workerExists) {
    secrets.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
  }

  const path = resolve(cwd, "secrets.json");

  try {
    await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
    return path;
  } catch {
    throw commandFailed("configuration", "OAuth secrets could not be staged.");
  }
}

async function migrationsAreCurrent(
  databaseId: string,
  migrations: readonly string[],
  context: CloudflareContext,
): Promise<boolean> {
  try {
    const applied = await readAppliedMigrations(databaseId, context);
    return migrations.every((migration) => applied.includes(migration));
  } catch (error) {
    if (error instanceof BootstrapError) {
      return false;
    }

    throw error;
  }
}

function hasDeploymentMessage(inventory: WorkerInventory, message: string): boolean {
  return inventory.deployments.some(
    (deployment) => deployment.annotations?.["workers/message"] === message,
  );
}

export function createBootstrapFailure(error: BootstrapError): BootstrapFailure {
  return bootstrapFailureSchema.parse({
    schemaVersion: 1,
    ok: false,
    stage: error.stage,
    message: error.message,
  });
}

export async function bootstrapDeployment(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
): Promise<BootstrapReport> {
  const assets = await loadDeploymentAssets(dependencies);
  const cwd = await createPrivateWorkspace();

  try {
    const neutralConfigPath = await writeAccountConfig(cwd);
    const account = await authenticate(options, cwd, neutralConfigPath, dependencies);
    const accountConfigPath = await writeAccountConfig(cwd, account.id);
    const context = { accountConfigPath, cwd, dependencies };
    const workerInventory = await readWorkerInventory(options.workerName, context);
    const githubSecrets = readGitHubSecrets(workerInventory.exists, dependencies);
    const { action: databaseAction, database } = await ensureDatabase(
      options,
      assets.migrations,
      context,
    );
    const configPath = await stageDeployment(options, account.id, database, assets, context);
    const migration = await runCloudflare(
      context,
      ["d1", "migrations", "apply", "AUTH_DB", "--remote", "--config", configPath],
      "migrations",
    );

    if (
      (migration.outcome !== "completed" || migration.exitCode !== 0) &&
      !(await migrationsAreCurrent(database.uuid, assets.migrations, context))
    ) {
      throw commandFailed(
        "migrations",
        "D1 migrations did not finish cleanly. The database is preserved for a safe retry.",
      );
    }

    const secretsPath = await writeSecretsFile(cwd, githubSecrets, workerInventory.exists);
    const deploymentMessage = `Crewhelm bootstrap ${randomUUID()}`;
    const deployArguments = [
      "deploy",
      "--config",
      configPath,
      "--name",
      options.workerName,
      "--no-bundle",
      "--strict",
      "--upload-source-maps",
      "--message",
      deploymentMessage,
    ];

    if (secretsPath) {
      deployArguments.push("--secrets-file", secretsPath);
    }

    const deployment = await runCloudflare(context, deployArguments, "deployment");

    if (deployment.outcome !== "completed" || deployment.exitCode !== 0) {
      const reconciled = await readWorkerInventory(options.workerName, context);

      if (!hasDeploymentMessage(reconciled, deploymentMessage)) {
        throw commandFailed(
          "deployment",
          "Worker deployment outcome could not be confirmed. Inspect Cloudflare before retrying.",
        );
      }

      const triggerReconciliation = await runCloudflare(context, deployArguments, "deployment");

      if (triggerReconciliation.outcome !== "completed" || triggerReconciliation.exitCode !== 0) {
        throw commandFailed(
          "deployment",
          "Worker code was deployed, but route or schedule reconciliation failed.",
        );
      }
    }

    const doctor: DoctorReport = await diagnoseDeployment(options, dependencies);

    return bootstrapReportSchema.parse({
      schemaVersion: 1,
      ok: doctor.ok,
      account: {
        id: account.id,
      },
      database: {
        action: databaseAction,
        id: database.uuid,
        name: database.name,
      },
      deployment: {
        action: workerInventory.exists ? "updated" : "created",
        origin: options.origin.origin,
        workerName: options.workerName,
      },
      doctor,
    });
  } finally {
    await removePrivateWorkspace(cwd);
  }
}
