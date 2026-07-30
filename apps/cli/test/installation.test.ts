import { lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { installationSchema, readInstallation, writeInstallation } from "../src/installation.js";

const INSTALLATION = {
  schemaVersion: 1,
  accountId: "055dc37aa5b65190125a66e918e9b73e",
  aiGatewayId: "crewhelm",
  databaseId: "c58217fd-fe09-447b-b79c-5d63ed1cedc0",
  databaseName: "crewhelm-auth",
  origin: "https://crewhelm.example",
  updatedAt: "2026-07-29T12:00:00.000Z",
  workerName: "crewhelm",
} as const;

describe("local installation metadata", () => {
  it("keeps the tracked example valid and secret-free", async () => {
    const text = await readFile(resolve("crewhelm.installation.example.json"), "utf8");

    expect(installationSchema.parse(JSON.parse(text))).toBeDefined();
    expect(text.toLowerCase()).not.toContain("secret");
  });

  it("round-trips non-secret upgrade coordinates through a private file", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-test-"));
    const path = resolve(directory, "nested", "installation.json");

    try {
      await writeInstallation(path, INSTALLATION);

      await expect(readInstallation(path)).resolves.toEqual(INSTALLATION);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(await readInstallation(path))).not.toContain("secret");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not follow a metadata symlink", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-test-"));
    const target = resolve(directory, "target.json");
    const link = resolve(directory, "installation.json");

    try {
      await writeInstallation(target, INSTALLATION);
      await symlink(target, link);

      await expect(readInstallation(link)).rejects.toThrow("regular bounded file");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
