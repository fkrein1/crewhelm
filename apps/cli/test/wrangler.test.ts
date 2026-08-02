import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import * as z from "zod";

import { createWranglerRunner, WranglerExecutionError } from "../src/wrangler.js";

const childReportSchema = z.strictObject({
  apiBase: z.null(),
  cwd: z.string(),
  overrideName: z.null(),
  token: z.literal("allowed-test-token"),
  unrelated: z.null(),
});

describe("Wrangler subprocess boundary", () => {
  it("normalizes a synchronous subprocess start rejection", async () => {
    const runWrangler = createWranglerRunner({});

    await expect(runWrangler(["invalid\0argument"], { cwd: process.cwd() })).rejects.toEqual(
      expect.objectContaining({
        message: "Cloudflare command could not be started.",
        name: WranglerExecutionError.name,
      }),
    );
  });

  it("uses the explicit private cwd and an allowlisted environment", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-runner-test-"));
    const trusted = resolve(root, "trusted");
    const executablePath = resolve(root, "inspect.mjs");
    await mkdir(trusted);
    await writeFile(
      executablePath,
      `process.stdout.write(JSON.stringify({
        apiBase: process.env.CLOUDFLARE_API_BASE_URL ?? null,
        cwd: process.cwd(),
        overrideName: process.env.WRANGLER_CI_OVERRIDE_NAME ?? null,
        token: process.env.CLOUDFLARE_API_TOKEN ?? null,
        unrelated: process.env.UNRELATED_SECRET ?? null
      }));`,
    );
    const runWrangler = createWranglerRunner(
      {
        CLOUDFLARE_API_BASE_URL: "https://attacker.invalid",
        CLOUDFLARE_API_TOKEN: "allowed-test-token",
        UNRELATED_SECRET: "must-not-pass",
        WRANGLER_CI_OVERRIDE_NAME: "wrong-worker",
      },
      { executablePath },
    );

    try {
      const result = await runWrangler([], { cwd: trusted });
      const canonicalTrusted = await realpath(trusted);

      expect(result.outcome).toBe("completed");
      expect(childReportSchema.parse(JSON.parse(result.stdout))).toEqual({
        apiBase: null,
        cwd: canonicalTrusted,
        overrideName: null,
        token: "allowed-test-token",
        unrelated: null,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("waits for a timed-out process to exit and marks its outcome unknown", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "crewhelm-runner-timeout-test-"));
    const executablePath = resolve(root, "wait.mjs");
    await writeFile(executablePath, "setInterval(() => {}, 1_000);\n");
    const runWrangler = createWranglerRunner(
      {},
      {
        executablePath,
        terminationGraceMs: 50,
        timeoutMs: 20,
      },
    );

    try {
      const result = await runWrangler([], { cwd: root });

      expect(result.outcome).toBe("unknown");
      expect(result.exitCode).not.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
