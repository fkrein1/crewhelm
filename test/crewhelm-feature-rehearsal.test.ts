import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runFeatureRehearsal } from "../scripts/crewhelm-feature-rehearsal.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("feature rehearsal target", () => {
  it("rejects a same-name installation at a non-canonical origin before network access", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-feature-target-"));
    directories.push(directory);
    const installationPath = resolve(directory, "installation.json");
    await writeFile(
      installationPath,
      JSON.stringify({
        accountId: "a".repeat(32),
        databaseId: "11111111-1111-4111-8111-111111111111",
        databaseName: "crewhelm-testing-auth",
        origin: "https://attacker.example",
        schemaVersion: 1,
        updatedAt: "2026-07-31T12:00:00.000Z",
        workerName: "crewhelm-testing",
      }),
      { mode: 0o600 },
    );
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);

    await expect(
      runFeatureRehearsal(["workflow", "--installation", installationPath]),
    ).rejects.toThrow("canonical crewhelm-testing origin");
    expect(fetch).not.toHaveBeenCalled();
  });
});
