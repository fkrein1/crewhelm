import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  refreshableOwnerCredentialSchema,
  type RefreshableOwnerCredential,
} from "../temporary-owner-session.js";

const MAXIMUM_CREDENTIAL_BYTES = 16 * 1_024;

function assertPrivateMode(mode: number): void {
  if ((mode & 0o077) !== 0) {
    throw new Error("Rehearsal credential must not be readable or writable by group or others.");
  }
}

export async function readRehearsalCredential(path: string): Promise<RefreshableOwnerCredential> {
  const absolutePath = resolve(path);
  const metadata = await lstat(absolutePath);

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Rehearsal credential must be a regular file.");
  }
  assertPrivateMode(metadata.mode);
  if (metadata.size > MAXIMUM_CREDENTIAL_BYTES) {
    throw new Error("Rehearsal credential exceeded its size budget.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    throw new Error("Rehearsal credential could not be read.");
  }

  const credential = refreshableOwnerCredentialSchema.safeParse(payload);

  if (!credential.success) {
    throw new Error("Rehearsal credential is invalid.");
  }

  return credential.data;
}

export async function writeRehearsalCredential(
  path: string,
  credential: RefreshableOwnerCredential,
): Promise<void> {
  const absolutePath = resolve(path);
  const directory = dirname(absolutePath);
  const temporaryPath = resolve(
    directory,
    `.${basename(absolutePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(refreshableOwnerCredentialSchema.parse(credential), null, 2)}\n`;

  if (Buffer.byteLength(serialized) > MAXIMUM_CREDENTIAL_BYTES) {
    throw new Error("Rehearsal credential exceeded its size budget.");
  }

  try {
    await writeFile(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, absolutePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
