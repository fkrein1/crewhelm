import { createHash } from "node:crypto";
import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  deploymentFingerprintSchema,
  getAgentScheduleResultSchema,
  getAgentResultSchema,
  getAgentRevisionResultSchema,
  getFleetConfigurationResultSchema,
  listAgentRevisionsResultSchema,
  listAgentsResultSchema,
  listConnectionsResultSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

import {
  bootstrapReportSchema,
  type BootstrapOptions,
  type BootstrapReport,
  type ExistingInstallationCoordinates,
  type InstallationInfrastructureInventory,
} from "./bootstrap.js";
import { doctorReportSchema, type DoctorReport } from "./doctor.js";
import {
  installationSchema,
  readInstallation,
  writeInstallation,
  type Installation,
} from "./installation.js";
import {
  initializeResponseSchema,
  MCP_PROTOCOL_VERSION,
  parseMcpToolResult,
  runTemporaryOwnerSession,
  TemporaryOwnerSessionError,
  toolCallResponseSchema,
  type TemporaryOwnerMcpSession,
  type TemporaryOwnerSessionDependencies,
} from "./temporary-owner-session.js";

export const UPGRADE_SMOKE_SCOPE = "crewhelm:view";
const MAXIMUM_RECEIPT_BYTES = 16 * 1_024;
const MAXIMUM_FIXTURE_AGENTS = 4;
const MAXIMUM_FIXTURE_AGENT_REVISIONS = 8;
const MAXIMUM_FIXTURE_CONNECTIONS = 8;
const migrationInventorySchema = z
  .array(
    z
      .string()
      .min(1)
      .max(160)
      .regex(/^[0-9]{4}_[a-z0-9_]+\.sql$/),
  )
  .max(100)
  .refine((names) => new Set(names).size === names.length);

const upgradeStatusResultSchema = z.discriminatedUnion("ok", [
  z.looseObject({
    ok: z.literal(true),
    status: z.looseObject({
      configurationRevision: z.number().int().positive().safe(),
      schemaVersion: z.number().int().positive(),
      usage: z.looseObject({
        agents: z.looseObject({
          active: z.number().int().nonnegative().safe(),
          total: z.number().int().nonnegative().safe(),
        }),
        connections: z.looseObject({
          active: z.number().int().nonnegative().safe(),
          total: z.number().int().nonnegative().safe(),
        }),
      }),
    }),
  }),
  z.looseObject({
    ok: z.literal(false),
  }),
]);

const collectionEvidenceSchema = z.strictObject({
  count: z.number().int().nonnegative().max(1_000),
  digest: deploymentFingerprintSchema,
});

export const upgradeOwnerStateEvidenceSchema = z.strictObject({
  agents: collectionEvidenceSchema,
  agentRevisions: collectionEvidenceSchema,
  configuration: z.strictObject({
    digest: deploymentFingerprintSchema,
    revision: z.number().int().positive().safe(),
  }),
  connections: collectionEvidenceSchema,
  schedules: collectionEvidenceSchema,
  status: z.strictObject({
    activeAgents: z.number().int().nonnegative().safe(),
    activeConnections: z.number().int().nonnegative().safe(),
    configurationRevision: z.number().int().positive().safe(),
    schemaVersion: z.number().int().positive().safe(),
    totalAgents: z.number().int().nonnegative().safe(),
    totalConnections: z.number().int().nonnegative().safe(),
  }),
});

export const upgradeInfrastructureEvidenceSchema = z.strictObject({
  migrations: collectionEvidenceSchema,
  secrets: collectionEvidenceSchema,
});

const upgradeStateEvidenceSchema = z.strictObject({
  infrastructure: upgradeInfrastructureEvidenceSchema,
  owner: upgradeOwnerStateEvidenceSchema,
});

const upgradeCoordinatesSchema = installationSchema.omit({
  schemaVersion: true,
  updatedAt: true,
});

const upgradeReceiptBaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("crewhelm-upgrade-smoke"),
  baselineFingerprint: deploymentFingerprintSchema,
  coordinates: upgradeCoordinatesSchema,
  currentFingerprint: deploymentFingerprintSchema,
  before: upgradeStateEvidenceSchema,
  updatedAt: z.iso.datetime(),
});

const upgradePendingReceiptSchema = upgradeReceiptBaseSchema.extend({
  phase: z.literal("upgrade_pending"),
});

const upgradeCompletedReceiptSchema = upgradeReceiptBaseSchema.extend({
  phase: z.literal("completed"),
  after: upgradeStateEvidenceSchema,
  deployment: z.strictObject({
    firstAction: z.enum(["updated", "unchanged"]),
    retryAction: z.literal("unchanged"),
  }),
});

export const upgradeReceiptSchema = z.discriminatedUnion("phase", [
  upgradePendingReceiptSchema,
  upgradeCompletedReceiptSchema,
]);

export const upgradeSmokeOptionsSchema = z.strictObject({
  authorizationTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60 * 1_000)
    .optional(),
  baselineFingerprint: deploymentFingerprintSchema,
  installationPath: z.string().min(1).max(4_096),
  origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
  receiptPath: z.string().min(1).max(4_096),
  timeoutMs: z.number().int().min(100).max(30_000),
});

export const upgradeSmokeReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.literal(true),
  baselineFingerprint: deploymentFingerprintSchema,
  currentFingerprint: deploymentFingerprintSchema,
  coordinates: upgradeCoordinatesSchema,
  before: upgradeStateEvidenceSchema,
  after: upgradeStateEvidenceSchema,
  deployment: z.strictObject({
    firstAction: z.enum(["updated", "unchanged"]),
    retryAction: z.literal("unchanged"),
  }),
  receiptPath: z.string().min(1).max(4_096),
  recovery: z.enum(["completed_receipt", "fresh", "resumed"]),
});

export const upgradeSmokeFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.literal(false),
  receiptPath: z.string().min(1).max(4_096),
  code: z.enum([
    "invalid_input",
    "rehearsal_failed",
    "token_revocation_unconfirmed",
    "unsupported_upgrade",
  ]),
  recovery: z.enum([
    "fix_input",
    "revoke_temporary_access",
    "retry_same_rehearsal",
    "use_supported_upgrade",
  ]),
  stage: z.literal("upgrade"),
  message: z.string().min(1).max(240),
});

export type UpgradeOwnerStateEvidence = z.infer<typeof upgradeOwnerStateEvidenceSchema>;
export type UpgradeSmokeOptions = z.infer<typeof upgradeSmokeOptionsSchema>;
export type UpgradeSmokeReport = z.infer<typeof upgradeSmokeReportSchema>;
type UpgradeReceipt = z.infer<typeof upgradeReceiptSchema>;
type UpgradeStateEvidence = z.infer<typeof upgradeStateEvidenceSchema>;
type UpgradeSmokeFailure = z.infer<typeof upgradeSmokeFailureSchema>;

export class UpgradeSmokeError extends Error {
  override readonly name = "UpgradeSmokeError";

  constructor(
    readonly code: UpgradeSmokeFailure["code"],
    readonly recovery: UpgradeSmokeFailure["recovery"],
    readonly publicMessage: string,
    message: string,
  ) {
    super(message);
  }
}

function invalidInput(message: string): UpgradeSmokeError {
  return new UpgradeSmokeError(
    "invalid_input",
    "fix_input",
    "Upgrade rehearsal inputs are invalid or incomplete.",
    message,
  );
}

export interface UpgradeSmokeProgress {
  message: string;
  stage: "baseline" | "deployment" | "retry" | "verification";
}

export interface UpgradeSmokeDependencies extends TemporaryOwnerSessionDependencies {
  bootstrap: (
    options: BootstrapOptions,
    expectedDeploymentFingerprint: string,
  ) => Promise<BootstrapReport>;
  captureOwnerState?: (
    options: Pick<UpgradeSmokeOptions, "authorizationTimeoutMs" | "origin" | "timeoutMs">,
  ) => Promise<UpgradeOwnerStateEvidence>;
  diagnose: (expectedFingerprint: string) => Promise<DoctorReport>;
  inspectInfrastructure: (
    coordinates: Pick<ExistingInstallationCoordinates, "accountId" | "databaseId" | "workerName">,
  ) => Promise<InstallationInfrastructureInventory>;
  now?: () => Date;
  readCurrentFingerprint: () => Promise<string>;
  readCurrentMigrations: () => Promise<readonly string[]>;
  reportUpgradeProgress?: (progress: UpgradeSmokeProgress) => void;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reportProgress(
  dependencies: UpgradeSmokeDependencies,
  stage: UpgradeSmokeProgress["stage"],
  message: string,
): void {
  dependencies.reportUpgradeProgress?.({ message, stage });
}

function collectionEvidence(values: readonly unknown[]) {
  return collectionEvidenceSchema.parse({
    count: values.length,
    digest: digest(values),
  });
}

function coordinatesFromInstallation(installation: Installation) {
  return upgradeCoordinatesSchema.parse({
    accountId: installation.accountId,
    ...(installation.aiGatewayId === undefined ? {} : { aiGatewayId: installation.aiGatewayId }),
    databaseId: installation.databaseId,
    databaseName: installation.databaseName,
    origin: installation.origin,
    workerName: installation.workerName,
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ownerStatePreserved(
  before: UpgradeOwnerStateEvidence,
  after: UpgradeOwnerStateEvidence,
): boolean {
  const { schemaVersion: beforeSchemaVersion, ...beforeStatus } = before.status;
  const { schemaVersion: afterSchemaVersion, ...afterStatus } = after.status;

  return (
    afterSchemaVersion >= beforeSchemaVersion &&
    sameValue(before.agents, after.agents) &&
    sameValue(before.agentRevisions, after.agentRevisions) &&
    sameValue(before.configuration, after.configuration) &&
    sameValue(before.connections, after.connections) &&
    sameValue(before.schedules, after.schedules) &&
    sameValue(beforeStatus, afterStatus)
  );
}

function infrastructureEvidence(
  inventory: InstallationInfrastructureInventory,
): z.infer<typeof upgradeInfrastructureEvidenceSchema> {
  return upgradeInfrastructureEvidenceSchema.parse({
    migrations: collectionEvidence(inventory.appliedMigrations),
    secrets: collectionEvidence([...inventory.secretNames].toSorted()),
  });
}

async function callTool<T>(
  session: TemporaryOwnerMcpSession,
  name: string,
  arguments_: unknown,
  schema: z.ZodType<T>,
  invalidMessage: string,
): Promise<T> {
  const response = await session.call(
    "tools/call",
    { arguments: arguments_, name },
    toolCallResponseSchema,
  );
  return parseMcpToolResult(response, schema, invalidMessage);
}

export async function readUpgradeOwnerState(
  session: TemporaryOwnerMcpSession,
): Promise<UpgradeOwnerStateEvidence> {
  await session.call(
    "initialize",
    {
      capabilities: {},
      clientInfo: { name: "crewhelm-cli", version: "0.0.0" },
      protocolVersion: MCP_PROTOCOL_VERSION,
    },
    initializeResponseSchema,
  );
  const statusResult = await callTool(
    session,
    "crewhelm_status",
    {},
    upgradeStatusResultSchema,
    "Fleet status returned an invalid payload.",
  );
  const agentResult = await callTool(
    session,
    "crewhelm_list_agents",
    { limit: MAXIMUM_FIXTURE_AGENTS },
    listAgentsResultSchema,
    "Agent fixture inventory returned an invalid payload.",
  );
  const connectionResult = await callTool(
    session,
    "crewhelm_list_connections",
    { limit: MAXIMUM_FIXTURE_CONNECTIONS },
    listConnectionsResultSchema,
    "Connection fixture inventory returned an invalid payload.",
  );
  const configurationResult = await callTool(
    session,
    "crewhelm_get_config",
    { target: { kind: "fleet" } },
    getFleetConfigurationResultSchema,
    "Fleet configuration returned an invalid payload.",
  );

  if (
    !statusResult.ok ||
    !agentResult.ok ||
    !connectionResult.ok ||
    !configurationResult.ok ||
    agentResult.nextCursor !== null ||
    connectionResult.nextCursor !== null
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Pinned upgrade fixture inventory was unavailable or exceeded its rehearsal budget.",
    );
  }

  if (agentResult.agents.length === 0 || connectionResult.connections.length === 0) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Pinned upgrade fixture requires at least one Agent and one connection.",
    );
  }

  const agents: unknown[] = [];
  const agentRevisions: unknown[] = [];
  const schedules: unknown[] = [];

  for (const agent of agentResult.agents) {
    const exactAgent = await callTool(
      session,
      "crewhelm_get_agent",
      { id: agent.id },
      getAgentResultSchema,
      "Exact Agent fixture returned an invalid payload.",
    );
    const revisions = await callTool(
      session,
      "crewhelm_list_agent_revisions",
      { id: agent.id, limit: MAXIMUM_FIXTURE_AGENT_REVISIONS },
      listAgentRevisionsResultSchema,
      "Agent revision fixture inventory returned an invalid payload.",
    );

    if (
      !exactAgent.ok ||
      !revisions.ok ||
      revisions.nextCursor !== null ||
      !sameValue(
        {
          createdAt: exactAgent.agent.createdAt,
          id: exactAgent.agent.id,
          model: exactAgent.agent.model,
          name: exactAgent.agent.name,
          revision: exactAgent.agent.revision,
          status: exactAgent.agent.status,
        },
        agent,
      )
    ) {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Pinned Agent fixture was incomplete or exceeded its revision budget.",
      );
    }

    agents.push(exactAgent.agent);

    for (const revision of revisions.revisions) {
      if (agentRevisions.length >= MAXIMUM_FIXTURE_AGENT_REVISIONS) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Pinned Agent fixture exceeded its total revision budget.",
        );
      }

      const exactRevision = await callTool(
        session,
        "crewhelm_get_agent_revision",
        { id: agent.id, revision: revision.revision },
        getAgentRevisionResultSchema,
        "Exact Agent revision fixture returned an invalid payload.",
      );

      if (
        !exactRevision.ok ||
        !sameValue(
          {
            id: exactRevision.agent.id,
            model: exactRevision.agent.model,
            name: exactRevision.agent.name,
            revisedAt: exactRevision.agent.revisedAt,
            revision: exactRevision.agent.revision,
          },
          revision,
        )
      ) {
        throw new TemporaryOwnerSessionError(
          "invalid_payload",
          "Pinned Agent revision fixture could not be read.",
        );
      }

      agentRevisions.push(exactRevision.agent);
    }

    const scheduleResult = await callTool(
      session,
      "crewhelm_get_agent_schedule",
      { agentId: agent.id },
      getAgentScheduleResultSchema,
      "Agent schedule fixture returned an invalid payload.",
    );

    if (scheduleResult.ok) {
      const schedule = scheduleResult.schedule;
      schedules.push({
        agentId: schedule.agentId,
        agentRevision: schedule.agentRevision,
        configuration: schedule.configuration,
        createdAt: schedule.createdAt,
        revision: schedule.revision,
        status: schedule.status,
      });
    } else if (scheduleResult.error.code !== "schedule_not_found") {
      throw new TemporaryOwnerSessionError(
        "invalid_payload",
        "Agent schedule fixture could not be read.",
      );
    }
  }

  if (schedules.length === 0) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Pinned upgrade fixture requires at least one Agent schedule.",
    );
  }

  const status = statusResult.status;

  if (
    status.usage.agents.total !== agentResult.agents.length ||
    status.usage.connections.total !== connectionResult.connections.length ||
    status.configurationRevision !== configurationResult.configuration.revision
  ) {
    throw new TemporaryOwnerSessionError(
      "invalid_payload",
      "Pinned upgrade fixture summaries did not reconcile with fleet status.",
    );
  }

  return upgradeOwnerStateEvidenceSchema.parse({
    agents: collectionEvidence(agents),
    agentRevisions: collectionEvidence(agentRevisions),
    configuration: {
      digest: digest(configurationResult.configuration),
      revision: configurationResult.configuration.revision,
    },
    connections: collectionEvidence(connectionResult.connections),
    schedules: collectionEvidence(schedules),
    status: {
      activeAgents: status.usage.agents.active,
      activeConnections: status.usage.connections.active,
      configurationRevision: status.configurationRevision,
      schemaVersion: status.schemaVersion,
      totalAgents: status.usage.agents.total,
      totalConnections: status.usage.connections.total,
    },
  });
}

export async function captureUpgradeOwnerState(
  options: Pick<UpgradeSmokeOptions, "authorizationTimeoutMs" | "origin" | "timeoutMs">,
  dependencies: TemporaryOwnerSessionDependencies,
): Promise<UpgradeOwnerStateEvidence> {
  const result = await runTemporaryOwnerSession(
    {
      ...(options.authorizationTimeoutMs === undefined
        ? {}
        : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
      clientName: "Crewhelm supported upgrade rehearsal",
      origin: options.origin,
      scope: UPGRADE_SMOKE_SCOPE,
      timeoutMs: options.timeoutMs,
    },
    dependencies,
    readUpgradeOwnerState,
  );

  if (
    !result.authorization.ok ||
    result.operation.status !== "completed" ||
    !result.operation.ok ||
    result.revocation.status !== "revoked"
  ) {
    if (result.revocation.status === "failed") {
      throw new UpgradeSmokeError(
        "token_revocation_unconfirmed",
        "revoke_temporary_access",
        "Temporary owner-token revocation was not confirmed. Revoke that access before retrying.",
        `Temporary owner-token revocation did not complete: ${result.revocation.error.message}`,
      );
    }

    const failure = !result.authorization.ok
      ? result.authorization.error
      : result.operation.status === "failed"
        ? result.operation.error
        : {
            code: "request_failed" as const,
            message: "Temporary owner session did not complete.",
          };

    throw new TemporaryOwnerSessionError(
      failure.code,
      `Owner state snapshot or temporary-token revocation did not complete: ${failure.message}`,
    );
  }

  return result.operation.value;
}

async function readReceipt(path: string): Promise<UpgradeReceipt | undefined> {
  try {
    const file = await lstat(path);

    if (!file.isFile() || file.isSymbolicLink() || file.size > MAXIMUM_RECEIPT_BYTES) {
      throw new Error("Upgrade rehearsal receipt is not a regular bounded file.");
    }

    return upgradeReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw invalidInput(
      `Upgrade rehearsal receipt could not be read: ${
        error instanceof Error ? error.message : "invalid receipt"
      }`,
    );
  }
}

async function writeReceipt(path: string, receipt: UpgradeReceipt): Promise<void> {
  const parsed = upgradeReceiptSchema.parse(receipt);
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;

  if (Buffer.byteLength(serialized) > MAXIMUM_RECEIPT_BYTES) {
    throw new Error("Upgrade rehearsal receipt exceeded its size budget.");
  }

  const temporaryPath = resolve(dirname(path), `.${basename(path)}.${process.pid}.tmp`);

  try {
    await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new Error("Upgrade rehearsal receipt could not be saved.", { cause: error });
  }
}

function assertMatchingReceipt(
  receipt: UpgradeReceipt,
  options: UpgradeSmokeOptions,
  coordinates: z.infer<typeof upgradeCoordinatesSchema>,
  currentFingerprint: string,
): void {
  if (
    receipt.baselineFingerprint !== options.baselineFingerprint ||
    receipt.currentFingerprint !== currentFingerprint ||
    !sameValue(receipt.coordinates, coordinates)
  ) {
    throw invalidInput("Upgrade rehearsal flags do not match the existing receipt.");
  }
}

function assertBeforeDeployment(
  report: DoctorReport,
  baselineFingerprint: string,
  currentFingerprint: string,
  resumed: boolean,
  classifyAsInputMismatch = false,
): void {
  const fingerprint = report.deployment.worker?.fingerprint;
  const publicChecksPassed = report.checks.every((check) => check.status === "pass");
  const baselineMatches =
    fingerprint === baselineFingerprint && report.deployment.alignment === "different";
  const currentMatches =
    resumed &&
    fingerprint === currentFingerprint &&
    report.deployment.alignment === "aligned" &&
    report.ok;

  if (!publicChecksPassed || (!baselineMatches && !currentMatches)) {
    if (classifyAsInputMismatch) {
      throw invalidInput("Worker does not match the pinned baseline package.");
    }

    throw new Error(
      resumed
        ? "Worker identity no longer matches the recorded baseline or current package."
        : "Worker does not match the pinned baseline package.",
    );
  }
}

function assertBootstrapCoordinates(
  report: BootstrapReport,
  coordinates: z.infer<typeof upgradeCoordinatesSchema>,
): void {
  if (
    !report.ok ||
    report.account.id !== coordinates.accountId ||
    report.database.id !== coordinates.databaseId ||
    report.database.name !== coordinates.databaseName ||
    report.deployment.origin !== coordinates.origin ||
    report.deployment.workerName !== coordinates.workerName ||
    report.database.action !== "reused" ||
    report.deployment.action === "created"
  ) {
    throw new Error("Upgrade did not preserve the exact installation coordinates.");
  }
}

function assertBaselineMigrationsSupported(
  before: z.infer<typeof collectionEvidenceSchema>,
  expectedMigrations: readonly string[],
): void {
  if (
    expectedMigrations.length < before.count ||
    digest(expectedMigrations.slice(0, before.count)) !== before.digest
  ) {
    throw new UpgradeSmokeError(
      "unsupported_upgrade",
      "use_supported_upgrade",
      "The pinned installation is not compatible with this package. Use a supported upgrade path.",
      "Pinned D1 migration history is not supported by the current package.",
    );
  }
}

function assertTargetMigrationsApplied(
  expectedMigrations: readonly string[],
  appliedMigrations: readonly string[],
): void {
  if (!sameValue(expectedMigrations, appliedMigrations)) {
    throw new Error("Current package migrations were not applied exactly.");
  }
}

function stateEvidence(
  owner: UpgradeOwnerStateEvidence,
  infrastructure: InstallationInfrastructureInventory,
): UpgradeStateEvidence {
  return upgradeStateEvidenceSchema.parse({
    infrastructure: infrastructureEvidence(infrastructure),
    owner,
  });
}

function bootstrapOptions(
  options: UpgradeSmokeOptions,
  coordinates: z.infer<typeof upgradeCoordinatesSchema>,
): BootstrapOptions {
  return {
    accountId: coordinates.accountId,
    ...(coordinates.aiGatewayId === undefined ? {} : { aiGatewayId: coordinates.aiGatewayId }),
    databaseId: coordinates.databaseId,
    databaseName: coordinates.databaseName,
    origin: options.origin,
    setupGitHub: false,
    timeoutMs: options.timeoutMs,
    workerName: coordinates.workerName,
  };
}

function completedReport(
  receipt: z.infer<typeof upgradeCompletedReceiptSchema>,
  receiptPath: string,
  recovery: UpgradeSmokeReport["recovery"],
): UpgradeSmokeReport {
  return upgradeSmokeReportSchema.parse({
    schemaVersion: 1,
    ok: true,
    baselineFingerprint: receipt.baselineFingerprint,
    currentFingerprint: receipt.currentFingerprint,
    coordinates: receipt.coordinates,
    before: receipt.before,
    after: receipt.after,
    deployment: receipt.deployment,
    receiptPath,
    recovery,
  });
}

export function createUpgradeSmokeFailure(receiptPath: string, error?: unknown) {
  const failure =
    error instanceof UpgradeSmokeError
      ? error
      : new UpgradeSmokeError(
          "rehearsal_failed",
          "retry_same_rehearsal",
          "Upgrade rehearsal did not complete. Preserve the fixture and retry with the same receipt.",
          "Upgrade rehearsal failed.",
        );

  return upgradeSmokeFailureSchema.parse({
    schemaVersion: 1,
    ok: false,
    code: failure.code,
    receiptPath,
    recovery: failure.recovery,
    stage: "upgrade",
    message: failure.publicMessage,
  });
}

export async function runUpgradeSmoke(
  input: UpgradeSmokeOptions,
  dependencies: UpgradeSmokeDependencies,
): Promise<UpgradeSmokeReport> {
  const options = upgradeSmokeOptionsSchema.parse(input);
  let installation: Installation | undefined;

  try {
    installation = await readInstallation(options.installationPath);
  } catch {
    throw invalidInput("Upgrade installation metadata could not be read.");
  }

  if (!installation) {
    throw invalidInput("Upgrade rehearsal requires existing installation metadata.");
  }

  const coordinates = coordinatesFromInstallation(installation);
  const infrastructureCoordinates = {
    accountId: coordinates.accountId,
    databaseId: coordinates.databaseId,
    workerName: coordinates.workerName,
  };

  if (coordinates.origin !== options.origin.origin) {
    throw invalidInput("Upgrade endpoint does not match the installation metadata.");
  }

  const currentFingerprint = deploymentFingerprintSchema.parse(
    await dependencies.readCurrentFingerprint(),
  );
  const currentMigrations = migrationInventorySchema.parse(
    await dependencies.readCurrentMigrations(),
  );

  if (currentFingerprint === options.baselineFingerprint) {
    throw invalidInput("Upgrade rehearsal requires different baseline and current packages.");
  }

  const existingReceipt = await readReceipt(options.receiptPath);

  if (existingReceipt) {
    assertMatchingReceipt(existingReceipt, options, coordinates, currentFingerprint);

    if (existingReceipt.phase === "completed") {
      return completedReport(existingReceipt, options.receiptPath, "completed_receipt");
    }
  }

  reportProgress(dependencies, "baseline", "Verifying the pinned deployment identity");
  const beforeDeployment = doctorReportSchema.parse(
    await dependencies.diagnose(currentFingerprint),
  );
  assertBeforeDeployment(
    beforeDeployment,
    options.baselineFingerprint,
    currentFingerprint,
    existingReceipt !== undefined,
    existingReceipt === undefined,
  );
  const deploymentAlreadyReachedTarget =
    existingReceipt !== undefined &&
    beforeDeployment.deployment.worker?.fingerprint === currentFingerprint;

  let before = existingReceipt?.before;
  const now = dependencies.now ?? (() => new Date());

  if (!before) {
    reportProgress(dependencies, "baseline", "Capturing bounded pre-upgrade evidence");
    const beforeInfrastructure =
      await dependencies.inspectInfrastructure(infrastructureCoordinates);
    assertBaselineMigrationsSupported(
      collectionEvidence(beforeInfrastructure.appliedMigrations),
      currentMigrations,
    );
    const beforeOwner = await (dependencies.captureOwnerState
      ? dependencies.captureOwnerState(options)
      : captureUpgradeOwnerState(options, dependencies));
    before = stateEvidence(beforeOwner, beforeInfrastructure);
    await writeReceipt(options.receiptPath, {
      schemaVersion: 1,
      kind: "crewhelm-upgrade-smoke",
      baselineFingerprint: options.baselineFingerprint,
      coordinates,
      currentFingerprint,
      before,
      phase: "upgrade_pending",
      updatedAt: now().toISOString(),
    });
  }
  assertBaselineMigrationsSupported(before.infrastructure.migrations, currentMigrations);

  reportProgress(dependencies, "baseline", "Revalidating the exact Worker before mutation");
  const mutationDeployment = doctorReportSchema.parse(
    await dependencies.diagnose(currentFingerprint),
  );
  assertBeforeDeployment(
    mutationDeployment,
    options.baselineFingerprint,
    currentFingerprint,
    existingReceipt !== undefined,
  );
  const mutationFingerprint = deploymentFingerprintSchema.parse(
    mutationDeployment.deployment.worker?.fingerprint,
  );

  reportProgress(dependencies, "deployment", "Applying the current packaged Worker");
  const first = bootstrapReportSchema.parse(
    await dependencies.bootstrap(bootstrapOptions(options, coordinates), mutationFingerprint),
  );
  assertBootstrapCoordinates(first, coordinates);

  reportProgress(dependencies, "verification", "Verifying deployment and preserved owner state");
  const afterDeployment = doctorReportSchema.parse(await dependencies.diagnose(currentFingerprint));

  if (
    !afterDeployment.ok ||
    afterDeployment.deployment.alignment !== "aligned" ||
    afterDeployment.deployment.worker?.fingerprint !== currentFingerprint
  ) {
    throw new Error("Upgraded Worker identity could not be verified.");
  }

  const afterInfrastructureInventory =
    await dependencies.inspectInfrastructure(infrastructureCoordinates);
  assertTargetMigrationsApplied(currentMigrations, afterInfrastructureInventory.appliedMigrations);
  const afterOwner = await (dependencies.captureOwnerState
    ? dependencies.captureOwnerState(options)
    : captureUpgradeOwnerState(options, dependencies));
  const after = stateEvidence(afterOwner, afterInfrastructureInventory);

  if (
    !ownerStatePreserved(before.owner, after.owner) ||
    !sameValue(before.infrastructure.secrets, after.infrastructure.secrets)
  ) {
    throw new Error("Owner state or deployed secret inventory changed during upgrade.");
  }

  reportProgress(dependencies, "retry", "Repeating the upgrade to prove a no-op");
  const retry = bootstrapReportSchema.parse(
    await dependencies.bootstrap(bootstrapOptions(options, coordinates), currentFingerprint),
  );
  assertBootstrapCoordinates(retry, coordinates);

  if (retry.deployment.action !== "unchanged") {
    throw new Error("Repeated upgrade was not an idempotent deployment no-op.");
  }

  const retryInfrastructureInventory =
    await dependencies.inspectInfrastructure(infrastructureCoordinates);
  assertTargetMigrationsApplied(currentMigrations, retryInfrastructureInventory.appliedMigrations);
  const retryInfrastructure = infrastructureEvidence(retryInfrastructureInventory);

  if (!sameValue(after.infrastructure, retryInfrastructure)) {
    throw new Error("Repeated upgrade changed migration or secret inventory.");
  }

  await writeInstallation(options.installationPath, {
    schemaVersion: 1,
    ...coordinates,
    updatedAt: now().toISOString(),
  });

  const completed = upgradeCompletedReceiptSchema.parse({
    schemaVersion: 1,
    kind: "crewhelm-upgrade-smoke",
    baselineFingerprint: options.baselineFingerprint,
    coordinates,
    currentFingerprint,
    before,
    after,
    deployment: {
      firstAction: deploymentAlreadyReachedTarget ? "updated" : first.deployment.action,
      retryAction: retry.deployment.action,
    },
    phase: "completed",
    updatedAt: now().toISOString(),
  });
  await writeReceipt(options.receiptPath, completed);

  return completedReport(completed, options.receiptPath, existingReceipt ? "resumed" : "fresh");
}
