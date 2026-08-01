import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runInstallationRehearsal } from "../../../src/rehearsal/public/installation.js";
import { type RunWrangler, type WranglerResult } from "../../../src/wrangler.js";

const ACCOUNT_ID = "055dc37aa5b65190125a66e918e9b73e";
const DATABASE_ID = "c58217fd-fe09-447b-b79c-5d63ed1cedc0";
const NAME = "crewhelm-rehearsal-example";
const LEGACY_NAME = "crewhelm-smoke-example";

function success(stdout = ""): WranglerResult {
  return { exitCode: 0, outcome: "completed", stderr: "", stdout };
}

function absentWorker(): WranglerResult {
  return {
    exitCode: 1,
    outcome: "completed",
    stderr: "Worker not found [code: 10007]",
    stdout: "",
  };
}

describe("fresh-install rehearsal recovery", () => {
  it("rejects an endpoint that does not belong to the requested rehearsal Worker", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    const runWrangler = vi.fn<RunWrangler>();

    try {
      await expect(
        runInstallationRehearsal(
          {
            cleanupOnly: false,
            databaseName: NAME,
            origin: new URL("https://crewhelm-production.example.workers.dev"),
            receiptPath,
            runTimeoutMs: 1_000,
            timeoutMs: 1_000,
            workerName: NAME,
          },
          {
            deploymentAssetsDirectory: root,
            fetch: vi.fn<typeof globalThis.fetch>(),
            openUrl: vi.fn<(url: URL) => Promise<void>>(),
            readEnvironment: () => undefined,
            runWrangler,
          },
        ),
      ).rejects.toThrow("must belong to the requested rehearsal Worker");
      expect(runWrangler).not.toHaveBeenCalled();
      await expect(readFile(receiptPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("deletes only the exact resources recorded by the receipt", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    let workerDeleted = false;
    let databaseDeleted = false;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return success(JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }));
      }

      if (arguments_[0] === "deployments") {
        return workerDeleted ? absentWorker() : success("[]");
      }

      if (arguments_[0] === "delete") {
        workerDeleted = true;
        return success();
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return success(
          JSON.stringify(
            databaseDeleted
              ? []
              : [
                  { name: LEGACY_NAME, uuid: DATABASE_ID },
                  { name: "keep-me", uuid: "d896b01d-543b-45c6-a312-9b8306301f90" },
                ],
          ),
        );
      }

      if (arguments_[0] === "d1" && arguments_[1] === "delete") {
        databaseDeleted = true;
        return success();
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });

    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-smoke",
        databaseName: LEGACY_NAME,
        origin: `https://${LEGACY_NAME}.workers.dev`,
        phase: "cleanup_pending",
        resources: [
          { accountId: ACCOUNT_ID, kind: "worker", name: LEGACY_NAME },
          { accountId: ACCOUNT_ID, id: DATABASE_ID, kind: "database", name: LEGACY_NAME },
        ],
        updatedAt: new Date().toISOString(),
        workerName: LEGACY_NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const report = await runInstallationRehearsal(
        {
          cleanupOnly: true,
          databaseName: LEGACY_NAME,
          origin: new URL(`https://${LEGACY_NAME}.workers.dev`),
          receiptPath,
          runTimeoutMs: 1_000,
          timeoutMs: 1_000,
          workerName: LEGACY_NAME,
        },
        {
          deploymentAssetsDirectory: root,
          fetch: vi.fn<typeof globalThis.fetch>(),
          openUrl: vi.fn<(url: URL) => Promise<void>>(),
          readEnvironment: () => undefined,
          runWrangler,
        },
      );

      expect(report).toMatchObject({
        ok: true,
        recovered: true,
        cleanup: {
          resources: [
            { kind: "worker", name: LEGACY_NAME, status: "deleted" },
            { id: DATABASE_ID, kind: "database", name: LEGACY_NAME, status: "deleted" },
          ],
        },
      });
      expect(
        runWrangler.mock.calls.find(([arguments_]) => arguments_[0] === "delete")?.[0],
      ).toEqual(["delete", LEGACY_NAME, "--config", expect.stringMatching(/account\.json$/u)]);
      expect(
        runWrangler.mock.calls.find(
          ([arguments_]) => arguments_[0] === "d1" && arguments_[1] === "delete",
        )?.[0],
      ).toEqual([
        "d1",
        "delete",
        LEGACY_NAME,
        "--skip-confirmation",
        "--config",
        expect.stringMatching(/account\.json$/u),
      ]);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
        phase: "completed",
        resources: [],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses to reuse a completed cleanup receipt", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    const runWrangler = vi.fn<RunWrangler>();
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-rehearsal",
        databaseName: NAME,
        origin: `https://${NAME}.workers.dev`,
        phase: "completed",
        resources: [],
        updatedAt: new Date().toISOString(),
        workerName: NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await expect(
        runInstallationRehearsal(
          {
            cleanupOnly: true,
            databaseName: NAME,
            origin: new URL(`https://${NAME}.workers.dev`),
            receiptPath,
            runTimeoutMs: 1_000,
            timeoutMs: 1_000,
            workerName: NAME,
          },
          {
            deploymentAssetsDirectory: root,
            fetch: vi.fn<typeof globalThis.fetch>(),
            openUrl: vi.fn<(url: URL) => Promise<void>>(),
            readEnvironment: () => undefined,
            runWrangler,
          },
        ),
      ).rejects.toThrow("already completed");
      expect(runWrangler).not.toHaveBeenCalled();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses cleanup when supplied coordinates differ from the receipt", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-rehearsal",
        databaseName: NAME,
        origin: `https://${NAME}.workers.dev`,
        phase: "cleanup_pending",
        resources: [],
        updatedAt: new Date().toISOString(),
        workerName: NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await expect(
        runInstallationRehearsal(
          {
            cleanupOnly: true,
            databaseName: "crewhelm-rehearsal-other",
            origin: new URL(`https://${NAME}.workers.dev`),
            receiptPath,
            runTimeoutMs: 1_000,
            timeoutMs: 1_000,
            workerName: NAME,
          },
          {
            deploymentAssetsDirectory: root,
            fetch: vi.fn<typeof globalThis.fetch>(),
            openUrl: vi.fn<(url: URL) => Promise<void>>(),
            readEnvironment: () => undefined,
            runWrangler: vi.fn<RunWrangler>(),
          },
        ),
      ).rejects.toThrow("Cleanup flags do not match");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects receipt resources that differ from the confirmed rehearsal coordinates", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    const runWrangler = vi.fn<RunWrangler>();
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-rehearsal",
        databaseName: NAME,
        origin: `https://${NAME}.workers.dev`,
        phase: "cleanup_pending",
        resources: [{ accountId: ACCOUNT_ID, kind: "worker", name: "crewhelm-rehearsal-other" }],
        updatedAt: new Date().toISOString(),
        workerName: NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      await expect(
        runInstallationRehearsal(
          {
            cleanupOnly: true,
            databaseName: NAME,
            origin: new URL(`https://${NAME}.workers.dev`),
            receiptPath,
            runTimeoutMs: 1_000,
            timeoutMs: 1_000,
            workerName: NAME,
          },
          {
            deploymentAssetsDirectory: root,
            fetch: vi.fn<typeof globalThis.fetch>(),
            openUrl: vi.fn<(url: URL) => Promise<void>>(),
            readEnvironment: () => undefined,
            runWrangler,
          },
        ),
      ).rejects.toThrow("receipt is invalid");
      expect(runWrangler).not.toHaveBeenCalled();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves the receipt and reports unresolved cleanup when authentication fails", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-rehearsal",
        databaseName: NAME,
        origin: `https://${NAME}.workers.dev`,
        phase: "cleanup_pending",
        resources: [{ accountId: ACCOUNT_ID, kind: "worker", name: NAME }],
        updatedAt: new Date().toISOString(),
        workerName: NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const report = await runInstallationRehearsal(
        {
          cleanupOnly: true,
          databaseName: NAME,
          origin: new URL(`https://${NAME}.workers.dev`),
          receiptPath,
          runTimeoutMs: 1_000,
          timeoutMs: 1_000,
          workerName: NAME,
        },
        {
          deploymentAssetsDirectory: root,
          fetch: vi.fn<typeof globalThis.fetch>(),
          openUrl: vi.fn<(url: URL) => Promise<void>>(),
          readEnvironment: () => undefined,
          runWrangler: vi.fn<RunWrangler>().mockResolvedValue({
            exitCode: 1,
            outcome: "completed",
            stderr: "",
            stdout: "",
          }),
        },
      );

      expect(report).toMatchObject({
        ok: false,
        cleanup: {
          ok: false,
          resources: [{ kind: "worker", name: NAME, status: "unresolved" }],
        },
      });
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
        phase: "cleanup_pending",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retires resolved targets when only part of cleanup succeeds", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-installation-rehearsal-test-"));
    const receiptPath = resolve(root, "receipt.json");
    let workerDeleted = false;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return success(JSON.stringify({ accounts: [{ id: ACCOUNT_ID }], loggedIn: true }));
      }

      if (arguments_[0] === "deployments") {
        return workerDeleted ? absentWorker() : success("[]");
      }

      if (arguments_[0] === "delete") {
        workerDeleted = true;
        return success();
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return { exitCode: 1, outcome: "completed", stderr: "temporary failure", stdout: "" };
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });
    await writeFile(
      receiptPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "crewhelm-installation-rehearsal",
        databaseName: NAME,
        origin: `https://${NAME}.workers.dev`,
        phase: "cleanup_pending",
        resources: [
          { accountId: ACCOUNT_ID, kind: "worker", name: NAME },
          { accountId: ACCOUNT_ID, id: DATABASE_ID, kind: "database", name: NAME },
        ],
        updatedAt: new Date().toISOString(),
        workerName: NAME,
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const report = await runInstallationRehearsal(
        {
          cleanupOnly: true,
          databaseName: NAME,
          origin: new URL(`https://${NAME}.workers.dev`),
          receiptPath,
          runTimeoutMs: 1_000,
          timeoutMs: 1_000,
          workerName: NAME,
        },
        {
          deploymentAssetsDirectory: root,
          fetch: vi.fn<typeof globalThis.fetch>(),
          openUrl: vi.fn<(url: URL) => Promise<void>>(),
          readEnvironment: () => undefined,
          runWrangler,
        },
      );

      expect(report.ok).toBe(false);
      expect(JSON.parse(await readFile(receiptPath, "utf8"))).toMatchObject({
        phase: "cleanup_pending",
        resources: [{ accountId: ACCOUNT_ID, id: DATABASE_ID, kind: "database", name: NAME }],
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
