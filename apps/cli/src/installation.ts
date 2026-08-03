import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { recipeRegistryOriginSchema } from "@crewhelm/contracts";
import * as z from "zod";

const MAXIMUM_INSTALLATION_BYTES = 16 * 1_024;

export const installationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  aiGatewayId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/)
    .optional(),
  aiDailySpendUsd: z.number().finite().min(0.01).max(1_000).optional(),
  databaseId: z.uuid(),
  databaseName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  origin: z.url(),
  recipeRegistryOrigin: recipeRegistryOriginSchema.optional(),
  sandboxEnabled: z.boolean().optional(),
  skillBucketName: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/)
    .optional(),
  testingInstallation: z.literal(true).optional(),
  updatedAt: z.iso.datetime(),
  workerName: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
});

export type Installation = z.infer<typeof installationSchema>;

function isMissingFileError(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
  } catch {
    return false;
  }
}

export async function readInstallation(path: string): Promise<Installation | undefined> {
  const absolutePath = resolve(path);
  let file;

  try {
    file = await lstat(absolutePath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw new Error("Crewhelm installation metadata could not be read.", { cause: error });
  }

  if (!file.isFile() || file.isSymbolicLink() || file.size > MAXIMUM_INSTALLATION_BYTES) {
    throw new Error("Crewhelm installation metadata is not a regular bounded file.");
  }

  try {
    return installationSchema.parse(JSON.parse(await readFile(absolutePath, "utf8")));
  } catch {
    throw new Error("Crewhelm installation metadata is invalid.");
  }
}

export async function writeInstallation(path: string, installation: Installation): Promise<void> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;

  try {
    await mkdir(directory, { mode: 0o700, recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(installation, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, absolutePath);
  } catch {
    try {
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the bounded installation write failure.
    }
    throw new Error("Crewhelm installation metadata could not be saved.");
  }
}
