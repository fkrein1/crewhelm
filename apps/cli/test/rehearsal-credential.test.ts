import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readRehearsalCredential, writeRehearsalCredential } from "../src/rehearsal-credential.js";

const directories: string[] = [];
const credential = {
  clientId: "rehearsal-client",
  origin: "https://crewhelm-testing.example",
  refreshToken: "rotating-refresh-token",
  schemaVersion: 1 as const,
  scope: "crewhelm:full" as const,
};

async function path() {
  const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-rehearsal-"));
  directories.push(directory);
  return resolve(directory, "credential.json");
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("rehearsal credential storage", () => {
  it("writes and rotates one bounded mode-0600 credential", async () => {
    const credentialPath = await path();

    await writeRehearsalCredential(credentialPath, credential);
    const metadata = await lstat(credentialPath);

    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(readRehearsalCredential(credentialPath)).resolves.toEqual(credential);

    await writeRehearsalCredential(credentialPath, {
      ...credential,
      refreshToken: "rotated-refresh-token",
    });
    expect(await readRehearsalCredential(credentialPath)).toMatchObject({
      refreshToken: "rotated-refresh-token",
    });
    expect(await readFile(credentialPath, "utf8")).not.toContain("rotating-refresh-token");
  });

  it("rejects credentials exposed to group or other users", async () => {
    const credentialPath = await path();
    await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
    await chmod(credentialPath, 0o640);

    await expect(readRehearsalCredential(credentialPath)).rejects.toThrow(
      "must not be readable or writable",
    );
  });

  it("rejects invalid and oversized credentials", async () => {
    const invalidPath = await path();
    await writeFile(invalidPath, "{}", { mode: 0o600 });
    await expect(readRehearsalCredential(invalidPath)).rejects.toThrow("is invalid");

    const oversizedPath = await path();
    await writeFile(oversizedPath, "x".repeat(16 * 1_024 + 1), { mode: 0o600 });
    await expect(readRehearsalCredential(oversizedPath)).rejects.toThrow("size budget");
  });
});
