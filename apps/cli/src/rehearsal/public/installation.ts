import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as z from "zod";

import { agentRehearsalReportSchema, runAgentRehearsal } from "./agent.js";
import {
  bootstrapCleanupReportSchema,
  bootstrapDeployment,
  BootstrapError,
  bootstrapFailureSchema,
  bootstrapOptionsSchema,
  bootstrapReportSchema,
  cleanupCreatedInstallationResources,
  createBootstrapFailure,
  readPackagedDeploymentFingerprint,
  skillBucketNameForWorker,
  type BootstrapDependencies,
} from "../../bootstrap.js";

const MAXIMUM_RECEIPT_BYTES = 16 * 1_024;
const BROWSER_EDGE_SETTLE_MS = 15_000;
const deploymentNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const rehearsalNameSchema = deploymentNameSchema.refine(
  (name) => name.startsWith("crewhelm-rehearsal-") || name.startsWith("crewhelm-smoke-"),
  "Rehearsal resource names must start with crewhelm-rehearsal-.",
);
const accountIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const databaseIdSchema = z.uuid();
const rehearsalResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    accountId: accountIdSchema,
    id: rehearsalNameSchema,
    kind: z.literal("gateway"),
  }),
  z.strictObject({
    accountId: accountIdSchema,
    id: databaseIdSchema,
    kind: z.literal("database"),
    name: rehearsalNameSchema,
  }),
  z.strictObject({
    accountId: accountIdSchema,
    kind: z.literal("bucket"),
    name: deploymentNameSchema,
  }),
  z.strictObject({
    accountId: accountIdSchema,
    kind: z.literal("worker"),
    name: rehearsalNameSchema,
  }),
]);

export const installationRehearsalOptionsSchema = z.strictObject({
  accountId: accountIdSchema.optional(),
  aiDailySpendUsd: bootstrapOptionsSchema.shape.aiDailySpendUsd,
  cleanupOnly: z.boolean(),
  databaseName: rehearsalNameSchema,
  origin: z.instanceof(URL).refine((origin) => origin.protocol === "https:"),
  receiptPath: z.string().min(1).max(4_096),
  runTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60 * 1_000),
  timeoutMs: bootstrapOptionsSchema.shape.timeoutMs,
  workerName: rehearsalNameSchema,
});

const installationRehearsalReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.union([
      z.literal("crewhelm-installation-rehearsal"),
      z.literal("crewhelm-installation-smoke"),
    ]),
    databaseName: rehearsalNameSchema,
    origin: z.url(),
    phase: z.enum(["provisioning", "cleanup_pending", "completed"]),
    resources: z.array(rehearsalResourceSchema).max(4),
    updatedAt: z.iso.datetime(),
    workerName: rehearsalNameSchema,
  })
  .superRefine((receipt, context) => {
    if (
      new Set(receipt.resources.map((resource) => resource.kind)).size !== receipt.resources.length
    ) {
      context.addIssue({ code: "custom", message: "Duplicate rehearsal resources." });
    }

    for (const resource of receipt.resources) {
      const matches =
        resource.kind === "database"
          ? resource.name === receipt.databaseName
          : resource.kind === "worker"
            ? resource.name === receipt.workerName
            : resource.kind === "bucket"
              ? resource.name === skillBucketNameForWorker(receipt.workerName)
              : resource.id === receipt.workerName;

      if (!matches) {
        context.addIssue({ code: "custom", message: "Rehearsal resource coordinates differ." });
      }
    }
  });

export const installationRehearsalFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.literal(false),
  stage: z.literal("rehearsal"),
  message: z.string().max(256),
  recovery: z.enum(["inspect_receipt", "cleanup_retry_failed"]),
  receiptPath: z.string().min(1).max(8_192),
});

export const installationRehearsalReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  recovered: z.boolean(),
  deployment: z.union([bootstrapReportSchema, bootstrapFailureSchema]).optional(),
  agent: agentRehearsalReportSchema.optional(),
  cleanup: bootstrapCleanupReportSchema,
  receiptPath: z.string().min(1).max(8_192),
});

export type InstallationRehearsalOptions = z.infer<typeof installationRehearsalOptionsSchema>;
export type InstallationRehearsalReport = z.infer<typeof installationRehearsalReportSchema>;
export type InstallationRehearsalFailure = z.infer<typeof installationRehearsalFailureSchema>;
type InstallationRehearsalReceipt = z.infer<typeof installationRehearsalReceiptSchema>;

export interface InstallationRehearsalDependencies extends BootstrapDependencies {
  openUrl: (url: URL) => Promise<void>;
}

export function createInstallationRehearsalFailure(
  receiptPath: string,
  cleanupOnly: boolean,
): InstallationRehearsalFailure {
  return installationRehearsalFailureSchema.parse({
    schemaVersion: 1,
    ok: false,
    stage: "rehearsal",
    message:
      "Installation rehearsal did not complete. Inspect the receipt and retry exact cleanup.",
    recovery: cleanupOnly ? "cleanup_retry_failed" : "inspect_receipt",
    receiptPath: resolve(receiptPath),
  });
}

async function readReceipt(path: string): Promise<InstallationRehearsalReceipt | undefined> {
  const absolutePath = resolve(path);
  let file;

  try {
    file = await lstat(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw new Error("Installation rehearsal receipt could not be read.", { cause: error });
  }

  if (!file.isFile() || file.isSymbolicLink() || file.size > MAXIMUM_RECEIPT_BYTES) {
    throw new Error("Installation rehearsal receipt is not a regular bounded file.");
  }

  try {
    return installationRehearsalReceiptSchema.parse(
      JSON.parse(await readFile(absolutePath, "utf8")),
    );
  } catch {
    throw new Error("Installation rehearsal receipt is invalid.");
  }
}

async function writeReceipt(path: string, receipt: InstallationRehearsalReceipt): Promise<void> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;

  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, absolutePath);
  } catch {
    await rm(temporaryPath, { force: true });
    throw new Error("Installation rehearsal receipt could not be saved.");
  }
}

function emptyCleanupReport() {
  return bootstrapCleanupReportSchema.parse({
    schemaVersion: 1,
    ok: true,
    resources: [],
  });
}

function assertRehearsalWorkerOrigin(options: InstallationRehearsalOptions): void {
  const workerLabel = options.origin.hostname.split(".")[0];

  if (!options.origin.hostname.endsWith(".workers.dev") || workerLabel !== options.workerName) {
    throw new Error(
      "The rehearsal endpoint must belong to the requested rehearsal Worker on workers.dev.",
    );
  }
}

async function cleanupReceipt(
  receipt: InstallationRehearsalReceipt,
  dependencies: InstallationRehearsalDependencies,
) {
  if (receipt.resources.length === 0) {
    return emptyCleanupReport();
  }

  return cleanupCreatedInstallationResources(receipt.resources, dependencies);
}

function retainUnresolvedResources(
  receipt: InstallationRehearsalReceipt,
  cleanup: InstallationRehearsalReport["cleanup"],
): InstallationRehearsalReceipt["resources"] {
  const unresolved = new Set(
    cleanup.resources
      .filter((resource) => resource.status === "unresolved")
      .map((resource) =>
        resource.kind === "worker"
          ? `worker:${resource.name}`
          : resource.kind === "database"
            ? `database:${resource.id}`
            : resource.kind === "bucket"
              ? `bucket:${resource.name}`
              : `gateway:${resource.id}`,
      ),
  );

  return receipt.resources.filter((resource) =>
    unresolved.has(
      resource.kind === "worker"
        ? `worker:${resource.name}`
        : resource.kind === "database"
          ? `database:${resource.id}`
          : resource.kind === "bucket"
            ? `bucket:${resource.name}`
            : `gateway:${resource.id}`,
    ),
  );
}

function receiptAfterCleanup(
  receipt: InstallationRehearsalReceipt,
  cleanup: InstallationRehearsalReport["cleanup"],
): InstallationRehearsalReceipt {
  const resources = retainUnresolvedResources(receipt, cleanup);

  return installationRehearsalReceiptSchema.parse({
    ...receipt,
    phase: resources.length === 0 ? "completed" : "cleanup_pending",
    resources,
    updatedAt: new Date().toISOString(),
  });
}

export async function runInstallationRehearsal(
  input: InstallationRehearsalOptions,
  dependencies: InstallationRehearsalDependencies,
): Promise<InstallationRehearsalReport> {
  const options = installationRehearsalOptionsSchema.parse(input);
  if (!options.cleanupOnly) {
    assertRehearsalWorkerOrigin(options);
  }
  const existing = await readReceipt(options.receiptPath);

  if (options.cleanupOnly) {
    if (!existing) {
      throw new Error("Cleanup requires an existing installation rehearsal receipt.");
    }

    if (existing.phase === "completed") {
      throw new Error("Installation rehearsal cleanup already completed.");
    }

    if (
      existing.origin !== options.origin.origin ||
      existing.workerName !== options.workerName ||
      existing.databaseName !== options.databaseName ||
      (options.accountId !== undefined &&
        existing.resources.some((resource) => resource.accountId !== options.accountId))
    ) {
      throw new Error("Cleanup flags do not match the installation rehearsal receipt.");
    }

    const cleanup = await cleanupReceipt(existing, dependencies);
    await writeReceipt(options.receiptPath, receiptAfterCleanup(existing, cleanup));
    return installationRehearsalReportSchema.parse({
      schemaVersion: 1,
      ok: cleanup.ok,
      recovered: true,
      cleanup,
      receiptPath: resolve(options.receiptPath),
    });
  }

  if (existing) {
    throw new Error(
      "Installation rehearsal receipt already exists; run with --cleanup-only or choose another path.",
    );
  }

  let receipt = installationRehearsalReceiptSchema.parse({
    schemaVersion: 1,
    kind: "crewhelm-installation-rehearsal",
    databaseName: options.databaseName,
    origin: options.origin.origin,
    phase: "provisioning",
    resources: [],
    updatedAt: new Date().toISOString(),
    workerName: options.workerName,
  });
  await writeReceipt(options.receiptPath, receipt);

  const bootstrapDependencies: InstallationRehearsalDependencies = {
    ...dependencies,
    recordCreatedResource: async (resource) => {
      if (
        receipt.resources.some(
          (recorded) =>
            recorded.kind === resource.kind &&
            ("id" in recorded ? recorded.id : recorded.name) ===
              ("id" in resource ? resource.id : resource.name),
        )
      ) {
        return;
      }

      receipt = installationRehearsalReceiptSchema.parse({
        ...receipt,
        resources: [...receipt.resources, resource],
        updatedAt: new Date().toISOString(),
      });
      await writeReceipt(options.receiptPath, receipt);
      await dependencies.recordCreatedResource?.(resource);
    },
  };
  delete bootstrapDependencies.createGitHubApp;
  delete bootstrapDependencies.requestCloudflareGatewayAuthorization;
  delete bootstrapDependencies.promptSecret;
  let deployment: InstallationRehearsalReport["deployment"];
  let agent: InstallationRehearsalReport["agent"];
  let unexpectedError: unknown;

  try {
    deployment = await bootstrapDeployment(
      bootstrapOptionsSchema.parse({
        accountId: options.accountId,
        aiDailySpendUsd: options.aiDailySpendUsd,
        databaseName: options.databaseName,
        origin: options.origin,
        requireFresh: true,
        timeoutMs: options.timeoutMs,
        workerName: options.workerName,
      }),
      bootstrapDependencies,
    );

    if (deployment.ok) {
      agent = await runAgentRehearsal(
        {
          authorizationDelayMs: BROWSER_EDGE_SETTLE_MS,
          origin: options.origin,
          runTimeoutMs: options.runTimeoutMs,
          timeoutMs: options.timeoutMs,
        },
        {
          expectedDeploymentFingerprint: await readPackagedDeploymentFingerprint(dependencies),
          fetch: dependencies.fetch,
          openUrl: dependencies.openUrl,
          ...(dependencies.wait === undefined ? {} : { wait: dependencies.wait }),
        },
      );
    }
  } catch (error) {
    if (error instanceof BootstrapError) {
      deployment = createBootstrapFailure(error);
    } else {
      unexpectedError = error;
    }
  }

  receipt = installationRehearsalReceiptSchema.parse({
    ...receipt,
    phase: "cleanup_pending",
    updatedAt: new Date().toISOString(),
  });
  const cleanup = await cleanupReceipt(receipt, dependencies);
  await writeReceipt(options.receiptPath, receiptAfterCleanup(receipt, cleanup));

  if (unexpectedError !== undefined) {
    throw unexpectedError;
  }

  return installationRehearsalReportSchema.parse({
    schemaVersion: 1,
    ok: deployment?.ok === true && agent?.ok === true && cleanup.ok,
    recovered: false,
    deployment,
    agent,
    cleanup,
    receiptPath: resolve(options.receiptPath),
  });
}
