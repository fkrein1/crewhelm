import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { deploymentFingerprintSchema } from "@crewhelm/contracts";
import * as z from "zod";

import type { CloudflareGatewayAuthorization } from "./cloudflare-gateway-authorization.js";
import {
  diagnoseDeployment,
  diagnoseDeploymentAlignment,
  doctorReportSchema,
  type DoctorDependencies,
  type DoctorReport,
} from "./doctor.js";
import { type RunWrangler, type WranglerResult, WranglerExecutionError } from "./wrangler.js";

const REQUIRED_SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "COMPOSIO_API_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID",
] as const;
type RequiredSecretName = (typeof REQUIRED_SECRET_NAMES)[number];
const CLOUDFLARE_API_TOKEN_ENVIRONMENT = "CREWHELM_CLOUDFLARE_API_TOKEN";
const CLOUDFLARE_GATEWAY_DENIED_MESSAGE = `Cloudflare denied AI Gateway management. Set ${CLOUDFLARE_API_TOKEN_ENVIRONMENT} to an account API token with AI Gateway Edit.`;
const COMPOSIO_API_KEY_ENVIRONMENT = "CREWHELM_COMPOSIO_API_KEY";
const GITHUB_SECRET_ENVIRONMENT = {
  clientId: "CREWHELM_GITHUB_CLIENT_ID",
  clientSecret: "CREWHELM_GITHUB_CLIENT_SECRET",
  ownerUserId: "CREWHELM_OWNER_GITHUB_USER_ID",
} as const;
const INSTALLATION_SECRET_ENVIRONMENTS = new Set([
  COMPOSIO_API_KEY_ENVIRONMENT,
  ...Object.values(GITHUB_SECRET_ENVIRONMENT),
]);
const SECRET_ENVIRONMENT_BY_NAME: Partial<Record<RequiredSecretName, string>> = {
  COMPOSIO_API_KEY: COMPOSIO_API_KEY_ENVIRONMENT,
  GITHUB_CLIENT_ID: GITHUB_SECRET_ENVIRONMENT.clientId,
  GITHUB_CLIENT_SECRET: GITHUB_SECRET_ENVIRONMENT.clientSecret,
  OWNER_GITHUB_USER_ID: GITHUB_SECRET_ENVIRONMENT.ownerUserId,
} as const;
const EXPECTED_DEPLOYMENT_CORE_FILES = [
  "index.js",
  "index.js.map",
  "migrations",
  "wrangler-template.json",
] as const;
const EXPECTED_MIGRATIONS = [
  "0001_better_auth.sql",
  "0002_control_write_scope.sql",
  "0003_integration_catalog_scope.sql",
  "0004_agent_definition_read_scope.sql",
  "0005_agent_update_scope.sql",
  "0006_connection_write_scope.sql",
  "0007_connection_read_scope.sql",
  "0008_connection_config_read_scope.sql",
  "0009_connection_config_write_scope.sql",
  "0010_oauth_offline_access.sql",
  "0011_autonomy_write_scope.sql",
  "0012_access_levels.sql",
] as const;
const MAX_WORKER_SCRIPT_BYTES = 10 * 1_048_576;
const MAX_SOURCE_MAP_BYTES = 25 * 1_048_576;
const MAX_TEMPLATE_BYTES = 1_048_576;
const MAX_MIGRATION_BYTES = 1_048_576;
const MAX_WORKER_TEXT_MODULES = 32;
const DEPLOYMENT_DIGEST_HEX_LENGTH = 40;
const WORKER_TEXT_MODULE_NAME = /^[0-9a-f]{40}-[0-9]{4}_[a-z0-9_]{1,128}\.sql$/u;
const WORKER_TEXT_MODULE_IMPORT = /from "\.\/([^"]+\.sql)";/gu;
const WORKER_NOT_FOUND_CODE = /\[code:\s*10007\]/u;
const MINIMUM_DERIVED_RATE_LIMIT_NAMESPACE_ID = 10_000n;
const MAXIMUM_RATE_LIMIT_NAMESPACE_ID = 2_147_483_647n;
const RATE_LIMIT_NAMESPACE_PAIR_COUNT =
  (MAXIMUM_RATE_LIMIT_NAMESPACE_ID - MINIMUM_DERIVED_RATE_LIMIT_NAMESPACE_ID + 1n) / 2n;
const DEPLOYMENT_VERIFICATION_DELAYS_MS = [
  1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000,
] as const;
const MINIMUM_DEPLOYMENT_STABILITY_MS = 10_000;
const REQUIRED_CONSECUTIVE_DEPLOYMENT_MATCHES = 3;
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
const r2BucketNameSchema = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/);
const r2BucketSchema = z.looseObject({
  name: r2BucketNameSchema,
});
const missingR2BucketCode = /\[code:\s*10006\]/u;
const githubSecretsSchema = z.strictObject({
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().min(1).max(1_024),
  ownerUserId: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const composioApiKeySchema = z.string().min(16).max(4_096).regex(/^\S+$/);
const cloudflareApiTokenSchema = z.string().min(16).max(4_096).regex(/^\S+$/);
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
const cloudflareCredentialsSchema = z.discriminatedUnion("type", [
  z.strictObject({
    token: z.string().min(1).max(4_096),
    type: z.enum(["api_token", "oauth"]),
  }),
  z.strictObject({
    email: z.email().max(320),
    key: z.string().min(1).max(4_096),
    type: z.literal("api_key"),
  }),
]);
const cloudflareApiEnvelopeSchema = z.looseObject({
  success: z.boolean(),
  result: z.unknown().optional(),
});
const aiGatewaySpendRuleSchema = z.looseObject({
  enabled: z.literal(true),
  id: z.literal("crewhelm-daily"),
  limit: z.number().finite().min(0.01).max(1_000),
  limitType: z.literal("cost"),
  technique: z.literal("sliding"),
  window: z.literal(24 * 60 * 60),
});
const aiGatewaySchema = z.looseObject({
  id: deploymentNameSchema,
  spend_limits: z.looseObject({
    enabled: z.literal(true),
    rules: z.tuple([aiGatewaySpendRuleSchema]),
  }),
});
const aiGatewayIdentitySchema = z.looseObject({
  id: deploymentNameSchema,
});
const deploymentSchema = z.looseObject({
  annotations: z.record(z.string(), z.unknown()).optional(),
  id: z.uuid(),
});
const activeDeploymentSchema = z.looseObject({
  id: z.uuid(),
  versions: z
    .array(
      z.looseObject({
        percentage: z.number().finite().min(0).max(100),
        version_id: z.uuid(),
      }),
    )
    .max(100),
});
const deploymentListSchema = z.array(deploymentSchema).max(100);
const establishedDurableObjectExportSchema = z.looseObject({
  renamed_to: z.never().optional(),
  state: z.literal("created").optional(),
  storage: z.literal("sqlite"),
  transfer_from: z.never().optional(),
  transferred_to: z.never().optional(),
  type: z.literal("durable-object"),
});
const workerVersionSchema = z.looseObject({
  id: z.uuid(),
  resources: z.looseObject({
    bindings: z
      .array(
        z.looseObject({
          bucket_name: r2BucketNameSchema.optional(),
          database_id: databaseIdSchema.optional(),
          name: z.string().min(1).max(255),
          text: z.string().max(2_048).optional(),
          type: z.string().min(1).max(255),
        }),
      )
      .max(1_000),
    script_runtime: z.looseObject({
      exports: z.looseObject({
        CrewAgent: establishedDurableObjectExportSchema,
        CrewSession: establishedDurableObjectExportSchema.optional(),
        OwnerControlPlane: establishedDurableObjectExportSchema,
      }),
    }),
  }),
});
const workerSecretListSchema = z
  .array(
    z.looseObject({
      name: z.string().min(1).max(255),
      type: z.literal("secret_text"),
    }),
  )
  .max(1_000);
const queryResultSchema = z.tuple([
  z.looseObject({
    results: z.array(z.looseObject({ name: z.string() })).max(100),
    success: z.literal(true),
  }),
]);
const deploymentTemplateSchema = z.strictObject({
  ai: z.strictObject({
    binding: z.literal("AI"),
  }),
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
      z.strictObject({
        class_name: z.literal("CrewAgent"),
        name: z.literal("CREW_AGENT"),
      }),
      z.strictObject({
        class_name: z.literal("CrewSession"),
        name: z.literal("CREW_SESSION"),
      }),
    ]),
  }),
  exports: z.strictObject({
    CrewAgent: z.strictObject({
      storage: z.literal("sqlite"),
      type: z.literal("durable-object"),
    }),
    CrewSession: z.strictObject({
      storage: z.literal("sqlite"),
      type: z.literal("durable-object"),
    }),
    OwnerControlPlane: z.strictObject({
      storage: z.literal("sqlite"),
      type: z.literal("durable-object"),
    }),
  }),
  main: z.literal("./index.js"),
  name: z.literal("crewhelm"),
  observability: z.strictObject({
    enabled: z.literal(true),
    logs: z.strictObject({
      enabled: z.literal(true),
      head_sampling_rate: z.literal(1),
      invocation_logs: z.literal(false),
    }),
    traces: z.strictObject({
      enabled: z.literal(false),
    }),
  }),
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
  r2_buckets: z.tuple([
    z.strictObject({
      binding: z.literal("SKILL_PACKAGES"),
      bucket_name: deploymentNameSchema,
    }),
  ]),
  rules: z.tuple([
    z.strictObject({
      fallthrough: z.literal(true),
      globs: z.tuple([z.literal("**/*.sql")]),
      type: z.literal("Text"),
    }),
  ]),
  triggers: z.strictObject({
    crons: z.tuple([z.literal("17 * * * *")]),
  }),
  vars: z.looseObject({
    PUBLIC_ORIGIN: z.url(),
  }),
  workflows: z.tuple([
    z.strictObject({
      binding: z.literal("AGENT_TASK_WORKFLOW"),
      class_name: z.literal("AgentTaskWorkflow"),
      name: z.literal("crewhelm-agent-task-workflow"),
    }),
  ]),
});

export const bootstrapOptionsSchema = z.strictObject({
  accountId: accountIdSchema.optional(),
  aiDailySpendUsd: z.number().finite().min(0.01).max(1_000).optional(),
  aiGatewayId: deploymentNameSchema.optional(),
  databaseId: databaseIdSchema.optional(),
  databaseName: deploymentNameSchema,
  origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
  requireExisting: z.boolean().optional(),
  requireFresh: z.boolean().optional(),
  setupGitHub: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30_000),
  workerName: deploymentNameSchema,
});

const bootstrapFailureStageSchema = z.enum([
  "assets",
  "authentication",
  "gateway",
  "worker",
  "configuration",
  "database",
  "storage",
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
  aiGateway: z.discriminatedUnion("enabled", [
    z.strictObject({
      enabled: z.literal(false),
    }),
    z.strictObject({
      enabled: z.literal(true),
      id: deploymentNameSchema,
    }),
  ]),
  deployment: z.strictObject({
    action: z.enum(["created", "updated", "unchanged"]),
    origin: z.url(),
    workerName: z.string(),
  }),
  doctor: doctorReportSchema,
});

export type BootstrapFailure = z.infer<typeof bootstrapFailureSchema>;
export type BootstrapOptions = z.infer<typeof bootstrapOptionsSchema>;
export type BootstrapProgressStage = z.infer<typeof bootstrapFailureStageSchema>;
export type BootstrapReport = z.infer<typeof bootstrapReportSchema>;
export type BootstrapCreatedResource =
  | { accountId: string; id: string; kind: "gateway" }
  | { accountId: string; id: string; kind: "database"; name: string }
  | { accountId: string; kind: "bucket"; name: string }
  | { accountId: string; kind: "worker"; name: string };
type BootstrapFailureStage = BootstrapProgressStage;
type DeploymentTemplate = z.infer<typeof deploymentTemplateSchema>;
type GitHubSecrets = z.infer<typeof githubSecretsSchema>;
type CloudflareCredentials = z.infer<typeof cloudflareCredentialsSchema>;
export interface ExistingInstallationCoordinates {
  accountId: string;
  aiDailySpendUsd?: number;
  aiGatewayId?: string;
  databaseId: string;
  databaseName: string;
  origin: string;
  skillBucketName?: string;
  workerName: string;
}

export interface InstallationInfrastructureInventory {
  appliedMigrations: readonly string[];
  secretNames: readonly string[];
}

export interface BootstrapProgress {
  message: string;
  stage: BootstrapProgressStage;
}

interface DeploymentAssets {
  digest: string;
  migrations: readonly string[];
  template: DeploymentTemplate;
  workerTextModules: readonly string[];
}

export function rateLimitNamespacesForWorker(workerName: string): {
  auth: string;
  mcp: string;
} {
  const digest = createHash("sha256")
    .update("crewhelm:rate-limits:")
    .update(workerName)
    .digest("hex");
  const first =
    (BigInt(`0x${digest.slice(0, 32)}`) % RATE_LIMIT_NAMESPACE_PAIR_COUNT) * 2n +
    MINIMUM_DERIVED_RATE_LIMIT_NAMESPACE_ID;

  return {
    auth: first.toString(),
    mcp: (first + 1n).toString(),
  };
}

export function skillBucketNameForWorker(workerName: string): string {
  const direct = `${workerName}-skills`;

  if (direct.length <= 63) {
    return r2BucketNameSchema.parse(direct);
  }

  const digest = createHash("sha256")
    .update("crewhelm:skill-bucket:")
    .update(workerName)
    .digest("hex");

  return r2BucketNameSchema.parse(`${workerName.slice(0, 46)}-${digest.slice(0, 8)}-skills`);
}

interface CloudflareContext {
  accountId: string;
  accountConfigPath: string;
  cwd: string;
  dependencies: BootstrapDependencies;
}

interface WorkerInventory {
  deployments: z.infer<typeof deploymentListSchema>;
  exists: boolean;
}

export interface BootstrapDependencies extends DoctorDependencies {
  createGitHubApp?: (options: { origin: URL; workerName: string }) => Promise<GitHubSecrets>;
  deploymentAssetsDirectory: string;
  promptSecret?: (message: string) => Promise<string>;
  expectedSkillBucketName?: string;
  persistProvisionedInstallation?: (installation: ExistingInstallationCoordinates) => Promise<void>;
  readEnvironment: (name: string) => string | undefined;
  recordCreatedResource?: (resource: BootstrapCreatedResource) => Promise<void>;
  reportProgress?: (progress: BootstrapProgress) => void;
  recoverExistingInstallation?: {
    expectedAiGatewayId?: string | null;
    expectedDatabaseId?: string;
    expectedDatabaseName?: string;
    expectedDeploymentFingerprints?: readonly string[];
    persist: (installation: ExistingInstallationCoordinates) => Promise<void>;
  };
  runWrangler: RunWrangler;
  requestCloudflareGatewayAuthorization?: (request: {
    accountId: string;
    canSkip: boolean;
    dailySpendUsd: number;
    workerName: string;
  }) => Promise<CloudflareGatewayAuthorization>;
  wait?: (milliseconds: number) => Promise<void>;
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

function reportProgress(
  dependencies: BootstrapDependencies,
  stage: BootstrapFailureStage,
  message: string,
): void {
  dependencies.reportProgress?.({ message, stage });
}

async function recordCreatedResource(
  dependencies: BootstrapDependencies,
  resource: BootstrapCreatedResource,
): Promise<void> {
  try {
    await dependencies.recordCreatedResource?.(resource);
  } catch {
    throw commandFailed(
      "configuration",
      "A created Cloudflare resource could not be recorded for recovery.",
    );
  }
}

async function waitFor(
  milliseconds: number,
  dependencies: Pick<BootstrapDependencies, "wait">,
): Promise<void> {
  if (dependencies.wait) {
    await dependencies.wait(milliseconds);
    return;
  }

  await new Promise((complete) => setTimeout(complete, milliseconds));
}

async function verifyDeployedControlPlane(
  options: BootstrapOptions,
  expectedDeploymentFingerprint: string,
  dependencies: BootstrapDependencies,
): Promise<DoctorReport> {
  const attempts = [...DEPLOYMENT_VERIFICATION_DELAYS_MS, undefined];
  let consecutiveMatches = 0;
  let stableMilliseconds = 0;

  for (const [index, delay] of attempts.entries()) {
    reportProgress(
      dependencies,
      "deployment",
      `Checking the deployed control plane (attempt ${index + 1} of ${attempts.length})`,
    );
    const doctor = await diagnoseDeployment(options, {
      expectedDeploymentFingerprint,
      fetch: dependencies.fetch,
    });

    const matched = doctor.ok && doctor.deployment.alignment === "aligned";

    if (matched) {
      consecutiveMatches += 1;

      if (
        consecutiveMatches >= REQUIRED_CONSECUTIVE_DEPLOYMENT_MATCHES &&
        stableMilliseconds >= MINIMUM_DEPLOYMENT_STABILITY_MS
      ) {
        return doctor;
      }
    } else {
      consecutiveMatches = 0;
      stableMilliseconds = 0;
    }

    if (doctor.deployment.alignment === "cli_outdated" || delay === undefined) {
      break;
    }

    await waitFor(delay, dependencies);
    if (matched) {
      stableMilliseconds += delay;
    }
  }

  throw commandFailed(
    "deployment",
    "Worker deployment completed, but the packaged build fingerprint could not be verified.",
  );
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
  dependencies: Pick<BootstrapDependencies, "deploymentAssetsDirectory">,
): Promise<DeploymentAssets> {
  try {
    const entries = await readdir(dependencies.deploymentAssetsDirectory, {
      withFileTypes: true,
    });
    const entryNames = entries.map((entry) => entry.name).toSorted();
    const workerTextModules = entryNames.filter(
      (name) => !(EXPECTED_DEPLOYMENT_CORE_FILES as readonly string[]).includes(name),
    );

    if (
      !EXPECTED_DEPLOYMENT_CORE_FILES.every((name) => entryNames.includes(name)) ||
      workerTextModules.length > MAX_WORKER_TEXT_MODULES ||
      workerTextModules.some((name) => !WORKER_TEXT_MODULE_NAME.test(name))
    ) {
      throw new Error("Unexpected deployment asset inventory.");
    }

    const boundedFiles = [
      ["index.js", MAX_WORKER_SCRIPT_BYTES],
      ["index.js.map", MAX_SOURCE_MAP_BYTES],
      ["wrangler-template.json", MAX_TEMPLATE_BYTES],
    ] as const;

    for (const [name, maximumBytes] of boundedFiles) {
      const file = await lstat(resolve(dependencies.deploymentAssetsDirectory, name));

      if (!file.isFile() || file.size > maximumBytes) {
        throw new Error("Unexpected deployment asset.");
      }
    }

    const workerSource = await readFile(
      resolve(dependencies.deploymentAssetsDirectory, "index.js"),
      "utf8",
    );
    const referencedTextModules = [...workerSource.matchAll(WORKER_TEXT_MODULE_IMPORT)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
      .toSorted();

    if (
      new Set(referencedTextModules).size !== referencedTextModules.length ||
      referencedTextModules.join("\n") !== workerTextModules.join("\n")
    ) {
      throw new Error("Unexpected Worker text-module inventory.");
    }

    for (const name of workerTextModules) {
      const textModule = await lstat(resolve(dependencies.deploymentAssetsDirectory, name));

      if (!textModule.isFile() || textModule.size > MAX_MIGRATION_BYTES) {
        throw new Error("Unexpected Worker text module.");
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

    const templateText = await readFile(
      resolve(dependencies.deploymentAssetsDirectory, "wrangler-template.json"),
      "utf8",
    );
    const template = deploymentTemplateSchema.parse(JSON.parse(templateText));
    const digest = createHash("sha256");

    for (const name of [
      "index.js",
      "index.js.map",
      "wrangler-template.json",
      ...workerTextModules,
      ...migrationNames.map((migration) => `migrations/${migration}`),
    ]) {
      digest.update(name);
      digest.update("\0");
      digest.update(await readFile(resolve(dependencies.deploymentAssetsDirectory, name)));
      digest.update("\0");
    }

    return {
      digest: digest.digest("hex"),
      migrations: migrationNames,
      template,
      workerTextModules,
    };
  } catch {
    throw commandFailed("assets", "Packaged deployment assets are invalid.");
  }
}

export async function readPackagedDeploymentFingerprint(
  dependencies: Pick<BootstrapDependencies, "deploymentAssetsDirectory">,
): Promise<string> {
  return (await loadDeploymentAssets(dependencies)).digest;
}

export async function readPackagedMigrationInventory(
  dependencies: Pick<BootstrapDependencies, "deploymentAssetsDirectory">,
): Promise<readonly string[]> {
  return [...(await loadDeploymentAssets(dependencies)).migrations];
}

export async function inspectInstallationInfrastructure(
  coordinates: Pick<ExistingInstallationCoordinates, "accountId" | "databaseId" | "workerName">,
  dependencies: BootstrapDependencies,
): Promise<InstallationInfrastructureInventory> {
  const parsed = z
    .strictObject({
      accountId: accountIdSchema,
      databaseId: databaseIdSchema,
      workerName: deploymentNameSchema,
    })
    .parse(coordinates);
  const cwd = await createPrivateWorkspace();

  try {
    const neutralConfigPath = await writeAccountConfig(cwd);
    const account = await authenticate(
      { accountId: parsed.accountId },
      cwd,
      neutralConfigPath,
      dependencies,
    );
    const accountConfigPath = await writeAccountConfig(cwd, account.id);
    const context = { accountId: account.id, accountConfigPath, cwd, dependencies };
    const worker = await readWorkerInventory(parsed.workerName, context);

    if (!worker.exists) {
      throw commandFailed("worker", "Worker inventory could not be read.");
    }

    const appliedMigrations = await readAppliedMigrations(parsed.databaseId, context);
    const secretNames = await readWorkerSecretNames(parsed.workerName, context);

    return {
      appliedMigrations: [...appliedMigrations],
      secretNames: [...secretNames].toSorted(),
    };
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

async function authenticate(
  options: Pick<BootstrapOptions, "accountId">,
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

async function readCloudflareCredentials(
  context: Pick<CloudflareContext, "cwd" | "dependencies">,
): Promise<CloudflareCredentials> {
  const environmentToken = context.dependencies.readEnvironment(CLOUDFLARE_API_TOKEN_ENVIRONMENT);

  if (environmentToken !== undefined) {
    const parsed = cloudflareApiTokenSchema.safeParse(environmentToken);

    if (!parsed.success) {
      throw commandFailed(
        "gateway",
        `Set ${CLOUDFLARE_API_TOKEN_ENVIRONMENT} to a valid account API token with AI Gateway Edit.`,
      );
    }

    return { token: parsed.data, type: "api_token" };
  }

  const result = await runCloudflare(context, ["auth", "token", "--json"], "authentication");
  requireCompleted(
    result,
    "authentication",
    "Cloudflare credential retrieval outcome could not be confirmed.",
  );

  if (result.exitCode !== 0) {
    throw commandFailed("authentication", "Cloudflare credentials could not be retrieved.");
  }

  try {
    return cloudflareCredentialsSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw commandFailed("authentication", "Cloudflare credentials were invalid.");
  }
}

function cloudflareHeaders(credentials: CloudflareCredentials): Record<string, string> {
  if (credentials.type === "api_key") {
    return {
      "X-Auth-Email": credentials.email,
      "X-Auth-Key": credentials.key,
    };
  }

  return { Authorization: `Bearer ${credentials.token}` };
}

async function cloudflareApiRequest(
  dependencies: BootstrapDependencies,
  credentials: CloudflareCredentials,
  url: string,
  init: RequestInit,
): Promise<{ result: unknown; status: number; success: boolean }> {
  let response: Response;

  try {
    response = await dependencies.fetch(url, {
      ...init,
      headers: {
        ...cloudflareHeaders(credentials),
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw commandFailed("gateway", "Cloudflare AI Gateway request failed.");
  }

  if (response.status === 404) {
    return { result: undefined, status: response.status, success: false };
  }

  let envelope: z.infer<typeof cloudflareApiEnvelopeSchema>;

  try {
    const body = await response.text();

    if (body.length > MAX_TEMPLATE_BYTES) {
      throw new Error("Response too large.");
    }

    envelope = cloudflareApiEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    throw commandFailed("gateway", "Cloudflare AI Gateway returned an invalid response.");
  }

  return {
    result: envelope.result,
    status: response.status,
    success: response.ok && envelope.success,
  };
}

interface AiGatewayPlan {
  dailySpendUsd: number;
  exists: boolean;
  id: string;
  needsMutation: boolean;
}

function aiGatewayBody(plan: AiGatewayPlan): string {
  return JSON.stringify({
    cache_invalidate_on_update: true,
    cache_ttl: 0,
    collect_logs: true,
    id: plan.id,
    rate_limiting_interval: 0,
    rate_limiting_limit: 0,
    spend_limits: {
      enabled: true,
      rules: [
        {
          enabled: true,
          id: "crewhelm-daily",
          limit: plan.dailySpendUsd,
          limitType: "cost",
          technique: "sliding",
          window: 24 * 60 * 60,
        },
      ],
    },
  });
}

function parseConfiguredAiGateway(
  result: unknown,
  gatewayId: string,
  dailySpendUsd?: number,
): z.infer<typeof aiGatewaySchema> | undefined {
  const parsed = aiGatewaySchema.safeParse(result);

  if (
    !parsed.success ||
    parsed.data.id !== gatewayId ||
    (dailySpendUsd !== undefined && parsed.data.spend_limits.rules[0].limit !== dailySpendUsd)
  ) {
    return undefined;
  }

  return parsed.data;
}

async function planAiGateway(
  options: BootstrapOptions,
  accountId: string,
  credentials: CloudflareCredentials,
  dependencies: BootstrapDependencies,
): Promise<AiGatewayPlan> {
  const dailySpendUsd = options.aiDailySpendUsd;

  if (dailySpendUsd === undefined) {
    throw commandFailed("gateway", "An explicit AI Gateway daily spend limit is required.");
  }

  const gatewayId = options.aiGatewayId ?? options.workerName;
  const collectionUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;
  const gatewayUrl = `${collectionUrl}/${gatewayId}`;
  const existing = await cloudflareApiRequest(dependencies, credentials, gatewayUrl, {
    method: "GET",
  });

  if (existing.status === 401 || existing.status === 403) {
    throw commandFailed("gateway", CLOUDFLARE_GATEWAY_DENIED_MESSAGE);
  }

  if (existing.status !== 404 && !existing.success) {
    throw commandFailed("gateway", "Cloudflare AI Gateway inventory could not be read.");
  }

  if (existing.status === 404) {
    return {
      dailySpendUsd,
      exists: false,
      id: gatewayId,
      needsMutation: true,
    };
  }

  const configured = parseConfiguredAiGateway(existing.result, gatewayId);

  return {
    dailySpendUsd,
    exists: true,
    id: gatewayId,
    needsMutation:
      configured === undefined || configured.spend_limits.rules[0].limit !== dailySpendUsd,
  };
}

async function applyAiGatewayPlan(
  plan: AiGatewayPlan,
  accountId: string,
  credentials: CloudflareCredentials,
  dependencies: BootstrapDependencies,
): Promise<void> {
  const collectionUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai-gateway/gateways`;
  const gatewayUrl = `${collectionUrl}/${plan.id}`;
  let configuredVerification: Awaited<ReturnType<typeof cloudflareApiRequest>> | undefined;
  const recoverGateway = async (requireConfigured: boolean) => {
    const verification = await cloudflareApiRequest(dependencies, credentials, gatewayUrl, {
      method: "GET",
    });
    const identity = aiGatewayIdentitySchema.safeParse(verification.result);

    if (!verification.success || !identity.success || identity.data.id !== plan.id) {
      return undefined;
    }

    return !requireConfigured ||
      parseConfiguredAiGateway(verification.result, plan.id, plan.dailySpendUsd) !== undefined
      ? verification
      : undefined;
  };

  if (plan.needsMutation) {
    let response: Awaited<ReturnType<typeof cloudflareApiRequest>> | undefined;

    if (!plan.exists) {
      const fresh = await cloudflareApiRequest(dependencies, credentials, gatewayUrl, {
        method: "GET",
      });

      if (fresh.status !== 404) {
        throw commandFailed(
          "gateway",
          "AI Gateway name became occupied before creation; no mutation was attempted.",
        );
      }
    }

    try {
      response = await cloudflareApiRequest(
        dependencies,
        credentials,
        plan.exists ? gatewayUrl : collectionUrl,
        {
          body: aiGatewayBody(plan),
          method: plan.exists ? "PUT" : "POST",
        },
      );
    } catch (error) {
      if (plan.exists) {
        configuredVerification = await recoverGateway(true);

        if (configuredVerification === undefined) {
          throw error;
        }
      } else {
        const recoveredCreation = await recoverGateway(false);

        if (recoveredCreation === undefined) {
          throw error;
        }

        configuredVerification =
          parseConfiguredAiGateway(recoveredCreation.result, plan.id, plan.dailySpendUsd) ===
          undefined
            ? undefined
            : recoveredCreation;
      }
    }

    if (response !== undefined && !response.success) {
      if (response.status < 500) {
        throw commandFailed("gateway", "Cloudflare AI Gateway could not be configured.");
      }

      const recovered = await recoverGateway(plan.exists);

      if (recovered === undefined) {
        throw commandFailed("gateway", "Cloudflare AI Gateway could not be configured.");
      }

      configuredVerification =
        parseConfiguredAiGateway(recovered.result, plan.id, plan.dailySpendUsd) === undefined
          ? undefined
          : recovered;
    }

    if (!plan.exists) {
      await recordCreatedResource(dependencies, {
        accountId,
        id: plan.id,
        kind: "gateway",
      });

      if (configuredVerification === undefined) {
        let update: Awaited<ReturnType<typeof cloudflareApiRequest>> | undefined;

        try {
          update = await cloudflareApiRequest(dependencies, credentials, gatewayUrl, {
            body: aiGatewayBody(plan),
            method: "PUT",
          });
        } catch (error) {
          configuredVerification = await recoverGateway(true);

          if (configuredVerification === undefined) {
            throw error;
          }
        }

        if (update !== undefined && !update.success) {
          if (update.status < 500) {
            throw commandFailed("gateway", "Cloudflare AI Gateway could not be configured.");
          }

          configuredVerification = await recoverGateway(true);

          if (configuredVerification === undefined) {
            throw commandFailed("gateway", "Cloudflare AI Gateway could not be configured.");
          }
        }
      }
    }
  }

  const verified =
    configuredVerification ??
    (await cloudflareApiRequest(dependencies, credentials, gatewayUrl, {
      method: "GET",
    }));

  if (
    !verified.success ||
    parseConfiguredAiGateway(verified.result, plan.id, plan.dailySpendUsd) === undefined
  ) {
    throw commandFailed("gateway", "Cloudflare AI Gateway configuration could not be verified.");
  }
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

async function readWorkerSecretNames(
  workerName: string,
  context: CloudflareContext,
): Promise<readonly string[]> {
  const result = await runCloudflare(
    context,
    [
      "secret",
      "list",
      "--name",
      workerName,
      "--format",
      "json",
      "--config",
      context.accountConfigPath,
    ],
    "worker",
  );
  requireCompleted(result, "worker", "Worker secret inventory outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    throw commandFailed("worker", "Worker secret inventory could not be read.");
  }

  try {
    return workerSecretListSchema.parse(JSON.parse(result.stdout)).map((secret) => secret.name);
  } catch {
    throw commandFailed("worker", "Worker secret inventory returned an invalid response.");
  }
}

async function readGitHubSecrets(
  workerExists: boolean,
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
): Promise<GitHubSecrets | undefined> {
  const candidate = {
    clientId: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.clientId),
    clientSecret: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.clientSecret),
    ownerUserId: dependencies.readEnvironment(GITHUB_SECRET_ENVIRONMENT.ownerUserId),
  };
  const suppliedCount = Object.values(candidate).filter((value) => value !== undefined).length;

  if (workerExists && suppliedCount === 0 && !options.setupGitHub) {
    return undefined;
  }

  if (suppliedCount === 0 && dependencies.createGitHubApp) {
    try {
      return githubSecretsSchema.parse(
        await dependencies.createGitHubApp({
          origin: options.origin,
          workerName: options.workerName,
        }),
      );
    } catch {
      throw commandFailed("configuration", "Private GitHub App setup did not complete.");
    }
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

async function readComposioApiKey(
  workerExists: boolean,
  dependencies: BootstrapDependencies,
): Promise<string | undefined> {
  let candidate = dependencies.readEnvironment(COMPOSIO_API_KEY_ENVIRONMENT);

  if (workerExists && candidate === undefined) {
    return undefined;
  }

  if (candidate === undefined && dependencies.promptSecret) {
    try {
      candidate = await dependencies.promptSecret("Composio project API key: ");
    } catch {
      throw commandFailed("configuration", "Composio API key input did not complete.");
    }
  }

  const parsed = composioApiKeySchema.safeParse(candidate);

  if (!parsed.success) {
    throw commandFailed(
      "configuration",
      `Set ${COMPOSIO_API_KEY_ENVIRONMENT} to a valid Composio project API key.`,
    );
  }

  return parsed.data;
}

function requireCompleteSecretSet(
  existingSecretNames: readonly string[],
  githubSecrets: GitHubSecrets | undefined,
  composioApiKey: string | undefined,
): void {
  const available = new Set(existingSecretNames);

  if (githubSecrets) {
    available.add("GITHUB_CLIENT_ID");
    available.add("GITHUB_CLIENT_SECRET");
    available.add("OWNER_GITHUB_USER_ID");
  }

  if (composioApiKey) {
    available.add("COMPOSIO_API_KEY");
  }

  const missing = REQUIRED_SECRET_NAMES.filter((name) => !available.has(name));

  if (missing.length === 0) {
    return;
  }

  const suppliedEnvironmentNames = missing.flatMap((name) => {
    const environmentName = SECRET_ENVIRONMENT_BY_NAME[name];
    return environmentName ? [environmentName] : [];
  });
  const restoreInCloudflare = missing.filter(
    (name) => SECRET_ENVIRONMENT_BY_NAME[name] === undefined,
  );
  const guidance = [
    suppliedEnvironmentNames.length > 0
      ? `Set ${suppliedEnvironmentNames.join(", ")} before retrying.`
      : undefined,
    restoreInCloudflare.length > 0
      ? `Restore ${restoreInCloudflare.join(", ")} in Cloudflare before retrying.`
      : undefined,
  ]
    .filter((message) => message !== undefined)
    .join(" ");
  const noun = missing.length === 1 ? "secret" : "secrets";

  throw commandFailed(
    "configuration",
    `Existing Worker is missing required ${noun}: ${missing.join(", ")}. ${guidance}`,
  );
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

async function readBucket(name: string, context: CloudflareContext) {
  const result = await runCloudflare(
    context,
    ["r2", "bucket", "info", name, "--json", "--config", context.accountConfigPath],
    "storage",
  );
  requireCompleted(result, "storage", "R2 bucket outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    if (missingR2BucketCode.test(result.stderr)) {
      return undefined;
    }

    throw commandFailed("storage", "R2 bucket could not be read.");
  }

  try {
    const bucket = r2BucketSchema.parse(JSON.parse(result.stdout));

    if (bucket.name !== name) {
      throw new Error("R2 bucket identity mismatch.");
    }

    return bucket;
  } catch {
    throw commandFailed("storage", "R2 bucket returned an invalid response.");
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
  policy: { allowEmpty: boolean },
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
    if (!policy.allowEmpty) {
      throw commandFailed("database", "Existing Worker D1 database has no Crewhelm provenance.");
    }

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

function readSingleActiveVersionId(inventory: WorkerInventory): string | undefined {
  const currentDeployment = activeDeploymentSchema.safeParse(inventory.deployments.at(-1));

  return currentDeployment.success &&
    currentDeployment.data.versions.length === 1 &&
    currentDeployment.data.versions[0]?.percentage === 100
    ? currentDeployment.data.versions[0].version_id
    : undefined;
}

async function requireUnchangedWorkerVersion(
  workerName: string,
  expectedVersionId: string,
  context: CloudflareContext,
): Promise<void> {
  const inventory = await readWorkerInventory(workerName, context);

  if (readSingleActiveVersionId(inventory) !== expectedVersionId) {
    throw commandFailed("worker", "Existing Worker changed before the upgrade could be applied.");
  }
}

async function recoverExistingInstallation(
  options: BootstrapOptions,
  inventory: WorkerInventory,
  migrations: readonly string[],
  context: CloudflareContext,
): Promise<BootstrapOptions> {
  const recovery = context.dependencies.recoverExistingInstallation;

  if (!recovery || !inventory.exists) {
    return options;
  }

  const versionId = readSingleActiveVersionId(inventory);

  if (versionId === undefined) {
    throw commandFailed(
      "worker",
      "Existing Worker has no single active version that can be adopted safely.",
    );
  }

  const result = await runCloudflare(
    context,
    [
      "versions",
      "view",
      versionId,
      "--name",
      options.workerName,
      "--json",
      "--config",
      context.accountConfigPath,
    ],
    "worker",
  );
  requireCompleted(result, "worker", "Active Worker version outcome could not be confirmed.");

  if (result.exitCode !== 0) {
    throw commandFailed("worker", "Active Worker version could not be read.");
  }

  let version: z.infer<typeof workerVersionSchema>;

  try {
    version = workerVersionSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw commandFailed("worker", "Active Worker version returned an invalid response.");
  }

  if (version.id !== versionId) {
    throw commandFailed("worker", "Active Worker version did not match the requested version.");
  }

  const bindings = version.resources.bindings;
  const bindingNames = bindings.map((binding) => binding.name);

  if (new Set(bindingNames).size !== bindingNames.length) {
    throw commandFailed("worker", "Active Worker version contains ambiguous bindings.");
  }

  const databaseBinding = bindings.find((binding) => binding.name === "AUTH_DB");
  const fingerprintBinding = bindings.find(
    (binding) => binding.name === "CREWHELM_DEPLOYMENT_FINGERPRINT",
  );
  const originBinding = bindings.find((binding) => binding.name === "PUBLIC_ORIGIN");
  const gatewayBinding = bindings.find((binding) => binding.name === "AI_GATEWAY_ID");
  const skillBucketBinding = bindings.find((binding) => binding.name === "SKILL_PACKAGES");

  if (databaseBinding?.type !== "d1" || databaseBinding.database_id === undefined) {
    throw commandFailed("worker", "Existing Worker has no valid Crewhelm AUTH_DB binding.");
  }

  if (
    originBinding?.type !== "plain_text" ||
    originBinding.text === undefined ||
    originBinding.text !== options.origin.origin
  ) {
    throw commandFailed(
      "configuration",
      "Existing Worker PUBLIC_ORIGIN does not match the requested endpoint.",
    );
  }

  if (
    gatewayBinding !== undefined &&
    (gatewayBinding.type !== "plain_text" ||
      gatewayBinding.text === undefined ||
      !deploymentNameSchema.safeParse(gatewayBinding.text).success)
  ) {
    throw commandFailed("worker", "Existing Worker has an invalid AI_GATEWAY_ID binding.");
  }

  if (
    skillBucketBinding !== undefined &&
    (skillBucketBinding.type !== "r2_bucket" ||
      skillBucketBinding.bucket_name !== skillBucketNameForWorker(options.workerName))
  ) {
    throw commandFailed("worker", "Existing Worker has an invalid SKILL_PACKAGES binding.");
  }

  if (
    recovery.expectedDeploymentFingerprints !== undefined &&
    (fingerprintBinding?.type !== "plain_text" ||
      fingerprintBinding.text === undefined ||
      !deploymentFingerprintSchema.safeParse(fingerprintBinding.text).success ||
      !recovery.expectedDeploymentFingerprints.includes(fingerprintBinding.text))
  ) {
    throw commandFailed(
      "configuration",
      "Existing Worker fingerprint does not match the supported upgrade state.",
    );
  }

  if (
    recovery.expectedAiGatewayId !== undefined &&
    (recovery.expectedAiGatewayId === null
      ? gatewayBinding !== undefined
      : gatewayBinding?.text !== recovery.expectedAiGatewayId)
  ) {
    throw commandFailed(
      "configuration",
      "The requested AI Gateway conflicts with the existing Worker binding.",
    );
  }

  if (
    recovery.expectedDatabaseId !== undefined &&
    recovery.expectedDatabaseId !== databaseBinding.database_id
  ) {
    throw commandFailed(
      "configuration",
      "The requested D1 database ID conflicts with the existing Worker binding.",
    );
  }

  const databases = (await listDatabases(context)).filter(
    (database) => database.uuid === databaseBinding.database_id,
  );

  if (databases.length !== 1 || !databases[0]) {
    throw commandFailed(
      "database",
      "Existing Worker AUTH_DB could not be matched to exactly one D1 database.",
    );
  }

  const database = databases[0];

  if (!deploymentNameSchema.safeParse(database.name).success) {
    throw commandFailed("database", "Existing Worker D1 database has an invalid name.");
  }

  if (
    recovery.expectedDatabaseName !== undefined &&
    recovery.expectedDatabaseName !== database.name
  ) {
    throw commandFailed(
      "configuration",
      "The requested D1 database name conflicts with the existing Worker binding.",
    );
  }

  await validateDatabaseForReuse(database.uuid, migrations, context, { allowEmpty: false });

  const reconciledInventory = await readWorkerInventory(options.workerName, context);

  if (readSingleActiveVersionId(reconciledInventory) !== versionId) {
    throw commandFailed("worker", "Existing Worker changed while its installation was recovered.");
  }

  const aiGatewayId = gatewayBinding?.text;
  const coordinates: ExistingInstallationCoordinates = {
    accountId: context.accountId,
    ...(aiGatewayId === undefined ? {} : { aiGatewayId }),
    databaseId: database.uuid,
    databaseName: database.name,
    origin: options.origin.origin,
    ...(skillBucketBinding?.bucket_name === undefined
      ? {}
      : { skillBucketName: skillBucketBinding.bucket_name }),
    workerName: options.workerName,
  };

  try {
    await recovery.persist(coordinates);
  } catch {
    throw commandFailed(
      "configuration",
      "Existing installation was verified, but local installation metadata could not be saved.",
    );
  }

  return bootstrapOptionsSchema.parse({
    ...options,
    aiGatewayId,
    databaseId: database.uuid,
    databaseName: database.name,
  });
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

    await validateDatabaseForReuse(existing[0].uuid, migrations, context, { allowEmpty: true });
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
      await recordCreatedResource(context.dependencies, {
        accountId: context.accountId,
        id: reconciled[0].uuid,
        kind: "database",
        name: reconciled[0].name,
      });
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

  await recordCreatedResource(context.dependencies, {
    accountId: context.accountId,
    id: reconciled[0].uuid,
    kind: "database",
    name: reconciled[0].name,
  });

  return { action: "created" as const, database: reconciled[0] };
}

async function ensureSkillBucket(
  workerInventory: WorkerInventory,
  requireFresh: boolean,
  workerName: string,
  context: CloudflareContext,
) {
  const name = skillBucketNameForWorker(workerName);
  const existing = await readBucket(name, context);

  if (existing !== undefined) {
    if (context.dependencies.expectedSkillBucketName === name) {
      return { action: "reused" as const, name };
    }

    if (requireFresh || !workerInventory.exists) {
      throw commandFailed(
        "storage",
        `R2 bucket ${name} already exists without the requested Worker. Choose another Worker name or remove the unused bucket.`,
      );
    }

    const versionId = readSingleActiveVersionId(workerInventory);

    if (versionId === undefined) {
      throw commandFailed(
        "storage",
        "Existing R2 Skill package storage could not be matched to one active Worker version.",
      );
    }

    const result = await runCloudflare(
      context,
      [
        "versions",
        "view",
        versionId,
        "--name",
        workerName,
        "--json",
        "--config",
        context.accountConfigPath,
      ],
      "storage",
    );
    requireCompleted(result, "storage", "Worker Skill package binding could not be confirmed.");

    if (result.exitCode !== 0) {
      throw commandFailed("storage", "Worker Skill package binding could not be read.");
    }

    let version: z.infer<typeof workerVersionSchema>;

    try {
      version = workerVersionSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw commandFailed("storage", "Worker Skill package binding returned an invalid response.");
    }

    const bindings = version.resources.bindings.filter(
      (binding) => binding.name === "SKILL_PACKAGES",
    );

    if (
      version.id !== versionId ||
      bindings.length !== 1 ||
      bindings[0]?.type !== "r2_bucket" ||
      bindings[0].bucket_name !== name
    ) {
      throw commandFailed(
        "storage",
        "Existing R2 Skill package storage is not bound to this Worker.",
      );
    }

    return { action: "reused" as const, name };
  }

  const created = await runCloudflare(
    context,
    ["r2", "bucket", "create", name, "--config", context.accountConfigPath],
    "storage",
  );

  if (created.outcome !== "completed" || created.exitCode !== 0) {
    const reconciled = await readBucket(name, context);

    if (reconciled !== undefined) {
      throw commandFailed(
        "storage",
        "R2 bucket creation outcome was ambiguous. Inspect ownership before retrying.",
      );
    }

    throw commandFailed("storage", "R2 Skill package bucket could not be created.");
  }

  await recordCreatedResource(context.dependencies, {
    accountId: context.accountId,
    kind: "bucket",
    name,
  });
  const reconciled = await readBucket(name, context);

  if (reconciled === undefined) {
    throw commandFailed("storage", "Created R2 Skill package bucket could not be reconciled.");
  }

  return { action: "created" as const, name };
}

async function stageDeployment(
  options: BootstrapOptions,
  accountId: string,
  database: { name: string; uuid: string },
  skillBucketName: string,
  aiGateway: { id: string } | undefined,
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

    for (const name of assets.workerTextModules) {
      await cp(
        resolve(context.dependencies.deploymentAssetsDirectory, name),
        resolve(context.cwd, name),
      );
    }

    const rateLimitNamespaces = rateLimitNamespacesForWorker(options.workerName);
    const config = {
      account_id: accountId,
      ai: assets.template.ai,
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
      observability: assets.template.observability,
      ratelimits: assets.template.ratelimits.map((rateLimit) => ({
        ...rateLimit,
        namespace_id:
          rateLimit.name === "AUTH_RATE_LIMIT" ? rateLimitNamespaces.auth : rateLimitNamespaces.mcp,
      })),
      r2_buckets: [
        {
          binding: "SKILL_PACKAGES",
          bucket_name: skillBucketName,
        },
      ],
      rules: assets.template.rules,
      secrets: {
        required: REQUIRED_SECRET_NAMES,
      },
      triggers: assets.template.triggers,
      vars: {
        ...(aiGateway === undefined ? {} : { AI_GATEWAY_ID: aiGateway.id }),
        CREWHELM_DEPLOYMENT_FINGERPRINT: assets.digest,
        PUBLIC_ORIGIN: options.origin.origin,
      },
      workflows: assets.template.workflows,
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
  composioApiKey: string | undefined,
  workerExists: boolean,
): Promise<string | undefined> {
  if (!github && !composioApiKey) {
    return undefined;
  }

  const secrets: Record<string, string> = {};

  if (github) {
    secrets.GITHUB_CLIENT_ID = github.clientId;
    secrets.GITHUB_CLIENT_SECRET = github.clientSecret;
    secrets.OWNER_GITHUB_USER_ID = github.ownerUserId;
  }

  if (composioApiKey) {
    secrets.COMPOSIO_API_KEY = composioApiKey;
  }

  if (!workerExists) {
    secrets.BETTER_AUTH_SECRET = randomBytes(48).toString("base64url");
  }

  const path = resolve(cwd, "secrets.json");

  try {
    await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
    return path;
  } catch {
    throw commandFailed("configuration", "Deployment secrets could not be staged.");
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

function currentDeploymentHasMessage(inventory: WorkerInventory, message: string): boolean {
  return inventory.deployments.at(-1)?.annotations?.["workers/message"] === message;
}

export function createBootstrapFailure(error: BootstrapError): BootstrapFailure {
  return bootstrapFailureSchema.parse({
    schemaVersion: 1,
    ok: false,
    stage: error.stage,
    message: error.message,
  });
}

const cleanupStatusSchema = z.enum(["absent", "deleted", "unresolved"]);

export const bootstrapCleanupReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  resources: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          id: deploymentNameSchema,
          kind: z.literal("gateway"),
          status: cleanupStatusSchema,
        }),
        z.strictObject({
          id: databaseIdSchema,
          kind: z.literal("database"),
          name: deploymentNameSchema,
          status: cleanupStatusSchema,
        }),
        z.strictObject({
          kind: z.literal("bucket"),
          name: r2BucketNameSchema,
          status: cleanupStatusSchema,
        }),
        z.strictObject({
          kind: z.literal("worker"),
          name: deploymentNameSchema,
          status: cleanupStatusSchema,
        }),
      ]),
    )
    .max(4),
});

export type BootstrapCleanupReport = z.infer<typeof bootstrapCleanupReportSchema>;

function unresolvedCleanupReport(
  resources: readonly BootstrapCreatedResource[],
): BootstrapCleanupReport {
  return bootstrapCleanupReportSchema.parse({
    schemaVersion: 1,
    ok: false,
    resources: resources.map((resource) => ({
      ...(resource.kind === "gateway" || resource.kind === "database" ? { id: resource.id } : {}),
      ...(resource.kind === "worker" || resource.kind === "database" || resource.kind === "bucket"
        ? { name: resource.name }
        : {}),
      kind: resource.kind,
      status: "unresolved",
    })),
  });
}

async function cleanupWorker(
  resource: Extract<BootstrapCreatedResource, { kind: "worker" }>,
  context: CloudflareContext,
): Promise<BootstrapCleanupReport["resources"][number]> {
  try {
    if (!(await readWorkerInventory(resource.name, context)).exists) {
      return { kind: "worker", name: resource.name, status: "absent" };
    }

    await runCloudflare(
      context,
      ["delete", resource.name, "--config", context.accountConfigPath],
      "worker",
    );
    const status = (await readWorkerInventory(resource.name, context)).exists
      ? "unresolved"
      : "deleted";
    return { kind: "worker", name: resource.name, status };
  } catch {
    return { kind: "worker", name: resource.name, status: "unresolved" };
  }
}

async function cleanupDatabase(
  resource: Extract<BootstrapCreatedResource, { kind: "database" }>,
  context: CloudflareContext,
): Promise<BootstrapCleanupReport["resources"][number]> {
  try {
    const matchingName = (await listDatabases(context)).filter(
      (database) => database.name === resource.name,
    );

    if (matchingName.length === 0) {
      return {
        id: resource.id,
        kind: "database",
        name: resource.name,
        status: "absent",
      };
    }

    if (matchingName.length !== 1 || matchingName[0]?.uuid !== resource.id) {
      return {
        id: resource.id,
        kind: "database",
        name: resource.name,
        status: "unresolved",
      };
    }

    await runCloudflare(
      context,
      ["d1", "delete", resource.name, "--skip-confirmation", "--config", context.accountConfigPath],
      "database",
    );
    const remains = (await listDatabases(context)).some(
      (database) => database.name === resource.name && database.uuid === resource.id,
    );
    return {
      id: resource.id,
      kind: "database",
      name: resource.name,
      status: remains ? "unresolved" : "deleted",
    };
  } catch {
    return {
      id: resource.id,
      kind: "database",
      name: resource.name,
      status: "unresolved",
    };
  }
}

async function cleanupBucket(
  resource: Extract<BootstrapCreatedResource, { kind: "bucket" }>,
  context: CloudflareContext,
): Promise<BootstrapCleanupReport["resources"][number]> {
  try {
    const matching = await readBucket(resource.name, context);

    if (matching === undefined) {
      return { kind: "bucket", name: resource.name, status: "absent" };
    }

    await runCloudflare(
      context,
      ["r2", "bucket", "delete", resource.name, "--config", context.accountConfigPath],
      "storage",
    );
    const remains = (await readBucket(resource.name, context)) !== undefined;

    return {
      kind: "bucket",
      name: resource.name,
      status: remains ? "unresolved" : "deleted",
    };
  } catch {
    return { kind: "bucket", name: resource.name, status: "unresolved" };
  }
}

async function cleanupGateway(
  resource: Extract<BootstrapCreatedResource, { kind: "gateway" }>,
  context: CloudflareContext,
): Promise<BootstrapCleanupReport["resources"][number]> {
  try {
    const credentials = await readCloudflareCredentials(context);
    const url = `https://api.cloudflare.com/client/v4/accounts/${context.accountId}/ai-gateway/gateways/${resource.id}`;
    const existing = await cloudflareApiRequest(context.dependencies, credentials, url, {
      method: "GET",
    });

    if (existing.status === 404) {
      return { id: resource.id, kind: "gateway", status: "absent" };
    }

    if (!existing.success) {
      return { id: resource.id, kind: "gateway", status: "unresolved" };
    }

    await cloudflareApiRequest(context.dependencies, credentials, url, { method: "DELETE" });
    const verified = await cloudflareApiRequest(context.dependencies, credentials, url, {
      method: "GET",
    });
    return {
      id: resource.id,
      kind: "gateway",
      status: verified.status === 404 ? "deleted" : "unresolved",
    };
  } catch {
    return { id: resource.id, kind: "gateway", status: "unresolved" };
  }
}

export async function cleanupCreatedInstallationResources(
  resources: readonly BootstrapCreatedResource[],
  dependencies: BootstrapDependencies,
): Promise<BootstrapCleanupReport> {
  const parsed = z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({
          accountId: accountIdSchema,
          kind: z.literal("bucket"),
          name: r2BucketNameSchema,
        }),
        z.strictObject({
          accountId: accountIdSchema,
          id: deploymentNameSchema,
          kind: z.literal("gateway"),
        }),
        z.strictObject({
          accountId: accountIdSchema,
          id: databaseIdSchema,
          kind: z.literal("database"),
          name: deploymentNameSchema,
        }),
        z.strictObject({
          accountId: accountIdSchema,
          kind: z.literal("worker"),
          name: deploymentNameSchema,
        }),
      ]),
    )
    .min(1)
    .max(4)
    .parse(resources);
  const accountIds = new Set(parsed.map((resource) => resource.accountId));

  if (accountIds.size !== 1) {
    throw commandFailed(
      "configuration",
      "Cleanup resources must belong to one Cloudflare account.",
    );
  }

  const cwd = await createPrivateWorkspace();

  try {
    const neutralConfigPath = await writeAccountConfig(cwd);
    const account = await authenticate(
      { accountId: parsed[0]!.accountId },
      cwd,
      neutralConfigPath,
      dependencies,
    );
    const accountConfigPath = await writeAccountConfig(cwd, account.id);
    const context = { accountId: account.id, accountConfigPath, cwd, dependencies };
    const ordered = parsed.toSorted(
      (left, right) =>
        ["worker", "bucket", "database", "gateway"].indexOf(left.kind) -
        ["worker", "bucket", "database", "gateway"].indexOf(right.kind),
    );
    const results: BootstrapCleanupReport["resources"] = [];

    for (const resource of ordered) {
      results.push(
        resource.kind === "worker"
          ? await cleanupWorker(resource, context)
          : resource.kind === "bucket"
            ? await cleanupBucket(resource, context)
            : resource.kind === "database"
              ? await cleanupDatabase(resource, context)
              : await cleanupGateway(resource, context),
      );
    }

    return bootstrapCleanupReportSchema.parse({
      schemaVersion: 1,
      ok: results.every((resource) => resource.status !== "unresolved"),
      resources: results,
    });
  } catch {
    return unresolvedCleanupReport(parsed);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

export async function bootstrapDeployment(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
): Promise<BootstrapReport> {
  reportProgress(dependencies, "assets", "Loading packaged deployment assets");
  const assets = await loadDeploymentAssets(dependencies);
  const installed = await diagnoseDeploymentAlignment(options, {
    expectedDeploymentFingerprint: assets.digest,
    fetch: dependencies.fetch,
  });

  if (installed.alignment === "cli_outdated") {
    throw commandFailed(
      "deployment",
      "The installed Worker requires a newer Crewhelm CLI. The Worker was not changed.",
    );
  }

  const cwd = await createPrivateWorkspace();

  try {
    const neutralConfigPath = await writeAccountConfig(cwd);
    reportProgress(dependencies, "authentication", "Authenticating with Cloudflare");
    const account = await authenticate(options, cwd, neutralConfigPath, dependencies);
    const accountConfigPath = await writeAccountConfig(cwd, account.id);
    const context = { accountId: account.id, accountConfigPath, cwd, dependencies };
    const configuredGatewayToken = dependencies.readEnvironment(CLOUDFLARE_API_TOKEN_ENVIRONMENT);

    if (
      options.aiDailySpendUsd !== undefined &&
      configuredGatewayToken !== undefined &&
      !cloudflareApiTokenSchema.safeParse(configuredGatewayToken).success
    ) {
      throw commandFailed(
        "gateway",
        `Set ${CLOUDFLARE_API_TOKEN_ENVIRONMENT} to a valid account API token with AI Gateway Edit.`,
      );
    }

    reportProgress(dependencies, "worker", "Inspecting the existing Worker");
    const workerInventory = await readWorkerInventory(options.workerName, context);
    const requiredWorkerVersionId =
      options.requireExisting === true ? readSingleActiveVersionId(workerInventory) : undefined;

    if (options.requireFresh === true && workerInventory.exists) {
      throw commandFailed("worker", "Fresh installation requires an unused Worker name.");
    }

    if (options.requireExisting === true && requiredWorkerVersionId === undefined) {
      throw commandFailed("worker", "Upgrade requires one existing active Worker version.");
    }

    const deploymentOptions = await recoverExistingInstallation(
      options,
      workerInventory,
      assets.migrations,
      context,
    );
    const existingSecretNames = workerInventory.exists
      ? await readWorkerSecretNames(deploymentOptions.workerName, context)
      : undefined;
    const suppliedGitHubSecretCount = Object.values(GITHUB_SECRET_ENVIRONMENT).filter(
      (name) => dependencies.readEnvironment(name) !== undefined,
    ).length;
    let githubSecrets =
      (workerInventory.exists && !deploymentOptions.setupGitHub) ||
      (!workerInventory.exists &&
        (suppliedGitHubSecretCount > 0 || dependencies.createGitHubApp === undefined))
        ? await readGitHubSecrets(workerInventory.exists, deploymentOptions, dependencies)
        : undefined;
    let composioApiKey =
      workerInventory.exists ||
      dependencies.readEnvironment(COMPOSIO_API_KEY_ENVIRONMENT) !== undefined ||
      dependencies.promptSecret === undefined
        ? await readComposioApiKey(workerInventory.exists, dependencies)
        : undefined;

    if (existingSecretNames !== undefined && !deploymentOptions.setupGitHub) {
      requireCompleteSecretSet(existingSecretNames, githubSecrets, composioApiKey);
    }

    let aiGatewayPlan: AiGatewayPlan | undefined;
    let gatewayCredentials: CloudflareCredentials | undefined;

    if (deploymentOptions.aiDailySpendUsd !== undefined) {
      reportProgress(dependencies, "gateway", "Planning the AI Gateway spend limit");
      gatewayCredentials = await readCloudflareCredentials({ cwd, dependencies });

      try {
        aiGatewayPlan = await planAiGateway(
          deploymentOptions,
          account.id,
          gatewayCredentials,
          dependencies,
        );
      } catch (error) {
        if (
          !(error instanceof BootstrapError) ||
          error.message !== CLOUDFLARE_GATEWAY_DENIED_MESSAGE ||
          dependencies.readEnvironment(CLOUDFLARE_API_TOKEN_ENVIRONMENT) !== undefined ||
          dependencies.requestCloudflareGatewayAuthorization === undefined
        ) {
          throw error;
        }

        let authorization: CloudflareGatewayAuthorization;

        try {
          authorization = await dependencies.requestCloudflareGatewayAuthorization({
            accountId: account.id,
            canSkip: deploymentOptions.aiGatewayId === undefined,
            dailySpendUsd: deploymentOptions.aiDailySpendUsd,
            workerName: deploymentOptions.workerName,
          });
        } catch {
          throw commandFailed("gateway", "Cloudflare API token recovery did not complete.");
        }

        if (authorization.action === "stop") {
          throw commandFailed(
            "gateway",
            "AI Gateway setup stopped before infrastructure was changed.",
          );
        }

        if (authorization.action === "skip") {
          if (deploymentOptions.aiGatewayId !== undefined) {
            throw commandFailed("gateway", "An existing AI Gateway cannot be skipped implicitly.");
          }
          gatewayCredentials = undefined;
        } else {
          const parsed = cloudflareApiTokenSchema.safeParse(authorization.token);

          if (!parsed.success) {
            throw commandFailed(
              "gateway",
              `Set ${CLOUDFLARE_API_TOKEN_ENVIRONMENT} to a valid account API token with AI Gateway Edit.`,
            );
          }

          gatewayCredentials = { token: parsed.data, type: "api_token" };
          aiGatewayPlan = await planAiGateway(
            deploymentOptions,
            account.id,
            gatewayCredentials,
            dependencies,
          );
        }
      }

      if (deploymentOptions.requireFresh === true && aiGatewayPlan?.exists === true) {
        throw commandFailed("gateway", "Fresh installation requires an unused AI Gateway name.");
      }
    }

    reportProgress(dependencies, "database", "Preparing the D1 database");
    const { action: databaseAction, database } = await ensureDatabase(
      deploymentOptions,
      assets.migrations,
      context,
    );
    reportProgress(dependencies, "storage", "Preparing the Skill package store");
    const skillBucket = await ensureSkillBucket(
      workerInventory,
      deploymentOptions.requireFresh === true,
      deploymentOptions.workerName,
      context,
    );
    const aiGatewayId = aiGatewayPlan?.id ?? deploymentOptions.aiGatewayId;
    const aiDailySpendUsd =
      aiGatewayPlan === undefined ? undefined : deploymentOptions.aiDailySpendUsd;
    const persistProvisionedInstallation = async (installedAiGatewayId?: string) => {
      try {
        await dependencies.persistProvisionedInstallation?.({
          accountId: account.id,
          ...(aiDailySpendUsd === undefined ? {} : { aiDailySpendUsd }),
          ...(installedAiGatewayId === undefined ? {} : { aiGatewayId: installedAiGatewayId }),
          databaseId: database.uuid,
          databaseName: database.name,
          origin: deploymentOptions.origin.origin,
          skillBucketName: skillBucket.name,
          workerName: deploymentOptions.workerName,
        });
      } catch {
        throw commandFailed(
          "configuration",
          "Provisioned infrastructure could not be recorded for a safe retry.",
        );
      }
    };

    if (skillBucket.action === "created") {
      await persistProvisionedInstallation(deploymentOptions.aiGatewayId);
    }
    reportProgress(dependencies, "configuration", "Preparing deployment configuration");
    const configPath = await stageDeployment(
      deploymentOptions,
      account.id,
      database,
      skillBucket.name,
      aiGatewayId === undefined ? undefined : { id: aiGatewayId },
      assets,
      context,
    );
    if (requiredWorkerVersionId !== undefined) {
      await requireUnchangedWorkerVersion(
        deploymentOptions.workerName,
        requiredWorkerVersionId,
        context,
      );
    }
    reportProgress(dependencies, "migrations", "Applying D1 migrations");
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

    if (aiGatewayPlan !== undefined && gatewayCredentials !== undefined) {
      reportProgress(dependencies, "gateway", "Applying the AI Gateway spend limit");
      await applyAiGatewayPlan(aiGatewayPlan, account.id, gatewayCredentials, dependencies);
      await persistProvisionedInstallation(aiGatewayId);
    }

    githubSecrets ??= await readGitHubSecrets(
      workerInventory.exists,
      deploymentOptions,
      dependencies,
    );
    composioApiKey ??= await readComposioApiKey(workerInventory.exists, dependencies);

    if (existingSecretNames !== undefined) {
      requireCompleteSecretSet(existingSecretNames, githubSecrets, composioApiKey);
    }

    const secretsPath = await writeSecretsFile(
      cwd,
      githubSecrets,
      composioApiKey,
      workerInventory.exists,
    );
    const deploymentDigest = createHash("sha256")
      .update(assets.digest)
      .update("\0")
      .update(await readFile(configPath))
      .digest("hex");
    const deploymentMessage = `Crewhelm ${deploymentDigest.slice(0, DEPLOYMENT_DIGEST_HEX_LENGTH)}`;
    const deployArguments = [
      "deploy",
      "--config",
      configPath,
      "--name",
      deploymentOptions.workerName,
      "--no-bundle",
      "--strict",
      "--upload-source-maps",
      "--message",
      deploymentMessage,
    ];

    if (secretsPath) {
      deployArguments.push("--secrets-file", secretsPath);
    }

    const deploymentUnchanged =
      secretsPath === undefined && currentDeploymentHasMessage(workerInventory, deploymentMessage);

    if (requiredWorkerVersionId !== undefined) {
      await requireUnchangedWorkerVersion(
        deploymentOptions.workerName,
        requiredWorkerVersionId,
        context,
      );
    }

    reportProgress(
      dependencies,
      "deployment",
      deploymentUnchanged ? "Reconciling Worker routes and schedules" : "Deploying the Worker",
    );
    if (!deploymentUnchanged) {
      const deployment = await runCloudflare(context, deployArguments, "deployment");

      if (deployment.outcome !== "completed" || deployment.exitCode !== 0) {
        const reconciled = await readWorkerInventory(deploymentOptions.workerName, context);

        if (!hasDeploymentMessage(reconciled, deploymentMessage)) {
          throw commandFailed(
            "deployment",
            "Worker deployment outcome could not be confirmed. Inspect Cloudflare before retrying.",
          );
        }

        if (!workerInventory.exists) {
          await recordCreatedResource(dependencies, {
            accountId: account.id,
            kind: "worker",
            name: deploymentOptions.workerName,
          });
        }

        const triggerReconciliation = await runCloudflare(context, deployArguments, "deployment");

        if (triggerReconciliation.outcome !== "completed" || triggerReconciliation.exitCode !== 0) {
          throw commandFailed(
            "deployment",
            "Worker code was deployed, but route or schedule reconciliation failed.",
          );
        }
      } else if (!workerInventory.exists) {
        await recordCreatedResource(dependencies, {
          accountId: account.id,
          kind: "worker",
          name: deploymentOptions.workerName,
        });
      }
    } else {
      const triggerReconciliation = await runCloudflare(
        context,
        ["triggers", "deploy", "--config", configPath, "--name", deploymentOptions.workerName],
        "deployment",
      );

      if (triggerReconciliation.outcome !== "completed" || triggerReconciliation.exitCode !== 0) {
        throw commandFailed(
          "deployment",
          "Worker code is current, but route or schedule reconciliation failed.",
        );
      }
    }

    const doctor = await verifyDeployedControlPlane(deploymentOptions, assets.digest, dependencies);

    return bootstrapReportSchema.parse({
      schemaVersion: 1,
      ok: doctor.ok,
      account: {
        id: account.id,
      },
      aiGateway:
        aiGatewayId === undefined ? { enabled: false } : { enabled: true, id: aiGatewayId },
      database: {
        action: databaseAction,
        id: database.uuid,
        name: database.name,
      },
      deployment: {
        action: !workerInventory.exists ? "created" : deploymentUnchanged ? "unchanged" : "updated",
        origin: deploymentOptions.origin.origin,
        workerName: deploymentOptions.workerName,
      },
      doctor,
    });
  } finally {
    await removePrivateWorkspace(cwd);
  }
}

export function bootstrapUpgradeDeployment(
  options: BootstrapOptions,
  dependencies: BootstrapDependencies,
  expectedDeploymentFingerprints: readonly string[],
): Promise<BootstrapReport> {
  const parsedOptions = bootstrapOptionsSchema.parse({
    ...options,
    requireExisting: true,
  });
  const fingerprints = z
    .array(deploymentFingerprintSchema)
    .min(1)
    .max(2)
    .parse(expectedDeploymentFingerprints);

  if (parsedOptions.databaseId === undefined) {
    throw commandFailed("configuration", "Upgrade requires an exact D1 database ID.");
  }

  return bootstrapDeployment(parsedOptions, {
    ...dependencies,
    readEnvironment: (name) =>
      INSTALLATION_SECRET_ENVIRONMENTS.has(name) ? undefined : dependencies.readEnvironment(name),
    recoverExistingInstallation: {
      expectedAiGatewayId: parsedOptions.aiGatewayId ?? null,
      expectedDatabaseId: parsedOptions.databaseId,
      expectedDatabaseName: parsedOptions.databaseName,
      expectedDeploymentFingerprints: fingerprints,
      persist: () => Promise.resolve(),
    },
  });
}
