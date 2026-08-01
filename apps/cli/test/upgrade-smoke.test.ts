import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
  DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
  DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
  DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
  DEFAULT_RUNNABLE_AGENT_MODEL,
  RUNNABLE_AGENT_MODELS,
  defaultFleetCapacity,
  defaultFleetExecutionLimits,
  defaultFleetRetention,
} from "@crewhelm/contracts";

import type {
  BootstrapOptions,
  BootstrapReport,
  InstallationInfrastructureInventory,
} from "../src/bootstrap.js";
import type { DoctorReport } from "../src/doctor.js";
import { writeInstallation } from "../src/installation.js";
import {
  createUpgradeSmokeFailure,
  readUpgradeOwnerState,
  runUpgradeSmoke,
  UPGRADE_SMOKE_SCOPE,
  UpgradeSmokeError,
  upgradeOwnerStateEvidenceSchema,
  upgradeReceiptSchema,
  type UpgradeOwnerStateEvidence,
  type UpgradeSmokeDependencies,
} from "../src/upgrade-smoke.js";
import type { TemporaryOwnerMcpSession } from "../src/temporary-owner-session.js";

const ACCOUNT_ID = "a".repeat(32);
const DATABASE_ID = "11111111-1111-4111-8111-111111111111";
const BASELINE_FINGERPRINT = "b".repeat(64);
const CURRENT_FINGERPRINT = "c".repeat(64);
const BASELINE_MIGRATIONS = ["0001_base.sql"] as const;
const CURRENT_MIGRATIONS = [...BASELINE_MIGRATIONS, "0002_current.sql"] as const;
const ORIGIN = new URL("https://crewhelm-upgrade-fixture.example");
const WORKER_NAME = "crewhelm-upgrade-fixture";
const DATABASE_NAME = "crewhelm-upgrade-fixture-auth";
const CHECK_NAMES = [
  "worker-health",
  "mcp-protected-resource",
  "oauth-authorization-server",
] as const;
const directories: string[] = [];
const AGENT_ID = "agent_11111111-1111-4111-8111-111111111111";

function validCheck(name: (typeof CHECK_NAMES)[number]): DoctorReport["checks"][number] {
  return {
    code: "valid",
    endpoint: new URL(`/${name}`, ORIGIN).href,
    message: "Valid.",
    name,
    status: "pass",
  };
}

function doctor(fingerprint: string, alignment: DoctorReport["deployment"]["alignment"]) {
  return {
    schemaVersion: 3,
    ok: alignment === "aligned",
    checks: [validCheck(CHECK_NAMES[0]), validCheck(CHECK_NAMES[1]), validCheck(CHECK_NAMES[2])],
    deployment: {
      alignment,
      worker: { fingerprint, protocolVersion: 1 },
    },
  } satisfies DoctorReport;
}

function bootstrap(action: "updated" | "unchanged"): BootstrapReport {
  return {
    schemaVersion: 1,
    ok: true,
    account: { id: ACCOUNT_ID },
    aiGateway: { enabled: false },
    database: {
      action: "reused",
      id: DATABASE_ID,
      name: DATABASE_NAME,
    },
    deployment: {
      action,
      origin: ORIGIN.origin,
      workerName: WORKER_NAME,
    },
    doctor: doctor(CURRENT_FINGERPRINT, "aligned"),
    features: {
      sandboxCode: {
        enabled: false,
        requirement: "Cloudflare Workers Paid",
        setupCommand: "crewhelm up --sandbox",
      },
    },
  };
}

function ownerState(seed = "1", schemaVersion = 16): UpgradeOwnerStateEvidence {
  return upgradeOwnerStateEvidenceSchema.parse({
    agents: { count: 1, digest: seed.repeat(64) },
    agentRevisions: { count: 2, digest: "6".repeat(64) },
    configuration: { digest: "2".repeat(64), revision: 3 },
    connections: { count: 1, digest: "3".repeat(64) },
    schedules: { count: 1, digest: "4".repeat(64) },
    status: {
      activeAgents: 1,
      activeConnections: 1,
      configurationRevision: 3,
      schemaVersion,
      totalAgents: 1,
      totalConnections: 1,
    },
  });
}

function infrastructure(migrations: readonly string[]): InstallationInfrastructureInventory {
  return {
    appliedMigrations: migrations,
    secretNames: [
      "BETTER_AUTH_SECRET",
      "COMPOSIO_API_KEY",
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "OWNER_GITHUB_USER_ID",
    ],
  };
}

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-upgrade-smoke-test-"));
  directories.push(directory);
  const installationPath = resolve(directory, "installation.json");
  const receiptPath = resolve(directory, "receipt.json");

  await writeInstallation(installationPath, {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    databaseId: DATABASE_ID,
    databaseName: DATABASE_NAME,
    origin: ORIGIN.origin,
    updatedAt: "2026-07-30T12:00:00.000Z",
    workerName: WORKER_NAME,
  });

  return {
    installationPath,
    options: {
      baselineFingerprint: BASELINE_FINGERPRINT,
      installationPath,
      origin: ORIGIN,
      receiptPath,
      timeoutMs: 5_000,
    },
    receiptPath,
  };
}

function dependencies(overrides: Partial<UpgradeSmokeDependencies> = {}) {
  const bootstrapMock = vi
    .fn<
      (options: BootstrapOptions, expectedDeploymentFingerprint: string) => Promise<BootstrapReport>
    >()
    .mockResolvedValueOnce(bootstrap("updated"))
    .mockResolvedValueOnce(bootstrap("unchanged"));
  const inspectInfrastructure = vi
    .fn<UpgradeSmokeDependencies["inspectInfrastructure"]>()
    .mockResolvedValueOnce(infrastructure(BASELINE_MIGRATIONS))
    .mockResolvedValueOnce(infrastructure(CURRENT_MIGRATIONS))
    .mockResolvedValueOnce(infrastructure(CURRENT_MIGRATIONS));
  const captureOwnerState = vi.fn<NonNullable<UpgradeSmokeDependencies["captureOwnerState"]>>(
    async () => ownerState(),
  );

  return {
    bootstrap: bootstrapMock,
    captureOwnerState,
    diagnose: vi
      .fn<(expectedFingerprint: string) => Promise<DoctorReport>>()
      .mockResolvedValueOnce(doctor(BASELINE_FINGERPRINT, "different"))
      .mockResolvedValueOnce(doctor(BASELINE_FINGERPRINT, "different"))
      .mockResolvedValueOnce(doctor(CURRENT_FINGERPRINT, "aligned")),
    fetch: vi.fn<typeof globalThis.fetch>(),
    inspectInfrastructure,
    openUrl: vi.fn<UpgradeSmokeDependencies["openUrl"]>(async () => undefined),
    readCurrentFingerprint: vi.fn<UpgradeSmokeDependencies["readCurrentFingerprint"]>(
      async () => CURRENT_FINGERPRINT,
    ),
    readCurrentMigrations: vi.fn<UpgradeSmokeDependencies["readCurrentMigrations"]>(
      async () => CURRENT_MIGRATIONS,
    ),
    ...overrides,
  } satisfies UpgradeSmokeDependencies;
}

function ownerFixtureSession(): TemporaryOwnerMcpSession {
  const createdAt = "2026-07-30T12:00:00.000Z";
  const revisedAt = "2026-07-30T12:01:00.000Z";
  const exactAgent = {
    capabilities: [
      {
        configuration: { model: DEFAULT_RUNNABLE_AGENT_MODEL },
        id: "inference.workers-ai",
        schemaVersion: 1,
      },
    ],
    capabilityGrants: [],
    createdAt,
    executionLimits: {
      maxDurationSeconds: 60,
      maxModelTokens: 512,
      maxToolCalls: 0,
      maxTurns: 1,
    },
    id: AGENT_ID,
    instructions: "Upgrade fixture instructions.",
    model: DEFAULT_RUNNABLE_AGENT_MODEL,
    name: "Upgrade fixture Agent",
    revision: 1,
    status: "active",
  };
  const toolResults = new Map<string, unknown>([
    [
      "crewhelm_status",
      {
        ok: true,
        status: {
          capacity: { ...defaultFleetCapacity, retention: defaultFleetRetention },
          configurationRevision: 1,
          schemaVersion: 16,
          status: "ready",
          usage: {
            agents: { active: 1, total: 1 },
            connections: { active: 1, pending: 0, total: 1 },
            diagnostics: { expiredApprovals: 0, pendingAiUsage: 0 },
            inbox: {
              actionRequired: 0,
              deferred: 0,
              exceptions: 0,
              outcomes: 0,
              total: 0,
            },
            recovery: { unresolvedEffects: 0 },
            runs: { active: 0 },
            skills: { active: 0, pendingObjects: 0, storedBytes: 0, total: 0, versions: 0 },
          },
        },
      },
    ],
    [
      "crewhelm_list_agents",
      {
        agents: [
          {
            createdAt,
            id: AGENT_ID,
            model: exactAgent.model,
            name: exactAgent.name,
            revision: 1,
            status: "active",
          },
        ],
        nextCursor: null,
        ok: true,
      },
    ],
    ["crewhelm_get_agent", { agent: exactAgent, ok: true }],
    [
      "crewhelm_list_agent_revisions",
      {
        nextCursor: null,
        ok: true,
        revisions: [
          {
            id: AGENT_ID,
            model: exactAgent.model,
            name: exactAgent.name,
            revisedAt,
            revision: 1,
          },
        ],
      },
    ],
    ["crewhelm_get_agent_revision", { agent: { ...exactAgent, revisedAt }, ok: true }],
    [
      "crewhelm_list_connections",
      {
        connections: [
          {
            accountLabel: "fixture@example.com",
            authorizationOutcome: "returned",
            authConfigId: "ac_fixture",
            connectionId: "connection_22222222-2222-4222-8222-222222222222",
            createdAt,
            integrationSlug: "gmail",
            providerConnectionId: "ca_fixture",
            status: "active",
          },
        ],
        nextCursor: null,
        ok: true,
      },
    ],
    [
      "crewhelm_get_config",
      {
        configuration: {
          configuredAt: createdAt,
          data: {
            capacity: defaultFleetCapacity,
            execution: defaultFleetExecutionLimits,
            integrations: {
              callsPerDay: DEFAULT_FLEET_INTEGRATION_CALLS_PER_DAY,
              callsPerThirtyDays: DEFAULT_FLEET_INTEGRATION_CALLS_PER_THIRTY_DAYS,
              duplicateToolCallLimit: DEFAULT_FLEET_DUPLICATE_TOOL_CALL_LIMIT,
              maxCallsPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_RUN,
              maxCallsPerToolPerRun: DEFAULT_FLEET_MAXIMUM_TOOL_CALLS_PER_TOOL_PER_RUN,
              maxConcurrencyPerGrant: DEFAULT_FLEET_MAXIMUM_TOOL_CONCURRENCY_PER_GRANT,
            },
            models: {
              allowed: [...RUNNABLE_AGENT_MODELS].toSorted(),
              default: DEFAULT_RUNNABLE_AGENT_MODEL,
            },
            retention: defaultFleetRetention,
            schedules: {
              minimumIntervalSeconds: DEFAULT_FLEET_MINIMUM_SCHEDULE_INTERVAL_SECONDS,
            },
          },
          revision: 1,
        },
        ok: true,
      },
    ],
    [
      "crewhelm_get_agent_schedule",
      {
        ok: true,
        schedule: {
          agentId: AGENT_ID,
          agentRevision: 1,
          configuration: {
            intervalSeconds: 3_600,
            prompt: "Run the upgrade fixture.",
          },
          createdAt,
          lastAttempt: null,
          lastDispatchedAt: null,
          lastRunId: null,
          nextRunAt: "2026-07-30T13:00:00.000Z",
          revision: 1,
          status: "active",
        },
      },
    ],
  ]);

  return {
    call: async (method, params, schema) => {
      if (method === "initialize") {
        return schema.parse({
          id: 1,
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "crewhelm", version: "0.0.0" },
          },
        });
      }

      const call = z
        .looseObject({
          name: z.string(),
        })
        .parse(params);
      const result = toolResults.get(call.name);

      if (result === undefined) {
        throw new Error(`Unexpected tool: ${call.name}`);
      }

      return schema.parse({
        id: 2,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(result), type: "text" }],
          isError: false,
        },
      });
    },
    endpoint: new URL("/mcp", ORIGIN),
  };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("supported upgrade rehearsal", () => {
  it("requests only read access for the owner snapshot", () => {
    expect(UPGRADE_SMOKE_SCOPE).toBe("crewhelm:view");
  });

  it("reports unconfirmed temporary-token revocation explicitly", () => {
    expect(
      createUpgradeSmokeFailure(
        "receipt.json",
        new UpgradeSmokeError(
          "token_revocation_unconfirmed",
          "revoke_temporary_access",
          "Temporary owner-token revocation was not confirmed. Revoke that access before retrying.",
          "Revocation failed.",
        ),
      ),
    ).toMatchObject({
      code: "token_revocation_unconfirmed",
      recovery: "revoke_temporary_access",
    });
  });

  it("hashes exact bounded owner fixtures without exposing their contents", async () => {
    const evidence = await readUpgradeOwnerState(ownerFixtureSession());
    const serialized = JSON.stringify(evidence);

    expect(evidence).toMatchObject({
      agents: { count: 1 },
      agentRevisions: { count: 1 },
      connections: { count: 1 },
      schedules: { count: 1 },
    });
    expect(serialized).not.toContain("fixture@example.com");
    expect(serialized).not.toContain("Upgrade fixture instructions.");
    expect(serialized).not.toContain(AGENT_ID);
  });

  it("preserves fixture evidence and proves the repeated upgrade is a no-op", async () => {
    const testFixture = await fixture();
    const reportUpgradeProgress =
      vi.fn<NonNullable<UpgradeSmokeDependencies["reportUpgradeProgress"]>>();
    const harness = dependencies({
      captureOwnerState: vi
        .fn<NonNullable<UpgradeSmokeDependencies["captureOwnerState"]>>()
        .mockResolvedValueOnce(ownerState())
        .mockResolvedValueOnce(ownerState("1", 19)),
      reportUpgradeProgress,
    });

    const report = await runUpgradeSmoke(testFixture.options, harness);

    expect(report).toMatchObject({
      ok: true,
      recovery: "fresh",
      deployment: { firstAction: "updated", retryAction: "unchanged" },
      before: { infrastructure: { migrations: { count: 1 } } },
      after: { infrastructure: { migrations: { count: 2 } } },
    });
    expect(report.after.owner.status.schemaVersion).toBe(19);
    expect(harness.bootstrap).toHaveBeenCalledTimes(2);
    expect(harness.bootstrap).toHaveBeenNthCalledWith(1, expect.any(Object), BASELINE_FINGERPRINT);
    expect(harness.bootstrap).toHaveBeenNthCalledWith(2, expect.any(Object), CURRENT_FINGERPRINT);
    expect(harness.captureOwnerState).toHaveBeenCalledTimes(2);
    expect(harness.inspectInfrastructure).toHaveBeenCalledTimes(3);
    expect(harness.inspectInfrastructure).toHaveBeenNthCalledWith(1, {
      accountId: ACCOUNT_ID,
      databaseId: DATABASE_ID,
      workerName: WORKER_NAME,
    });
    expect(reportUpgradeProgress.mock.calls.map(([progress]) => progress.stage)).toEqual([
      "baseline",
      "baseline",
      "baseline",
      "deployment",
      "verification",
      "retry",
    ]);
    expect(
      upgradeReceiptSchema.parse(JSON.parse(await readFile(testFixture.receiptPath, "utf8"))),
    ).toMatchObject({ phase: "completed" });

    await expect(runUpgradeSmoke(testFixture.options, harness)).resolves.toMatchObject({
      ok: true,
      recovery: "completed_receipt",
    });
    expect(harness.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("accepts an exact target package with no new migration", async () => {
    const testFixture = await fixture();
    const inspectInfrastructure = vi
      .fn<UpgradeSmokeDependencies["inspectInfrastructure"]>()
      .mockResolvedValue(infrastructure(BASELINE_MIGRATIONS));
    const report = await runUpgradeSmoke(
      testFixture.options,
      dependencies({
        inspectInfrastructure,
        readCurrentMigrations: async () => BASELINE_MIGRATIONS,
      }),
    );

    expect(report.before.infrastructure.migrations.count).toBe(1);
    expect(report.after.infrastructure.migrations.count).toBe(1);
    expect(inspectInfrastructure).toHaveBeenCalledTimes(3);
  });

  it("fails when the current package migration inventory was not applied", async () => {
    const testFixture = await fixture();
    const inspectInfrastructure = vi
      .fn<UpgradeSmokeDependencies["inspectInfrastructure"]>()
      .mockResolvedValue(infrastructure(BASELINE_MIGRATIONS));
    const harness = dependencies({ inspectInfrastructure });

    await expect(runUpgradeSmoke(testFixture.options, harness)).rejects.toThrow(
      "Current package migrations were not applied exactly.",
    );
    expect(harness.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("revalidates the pinned Worker after the owner snapshot and before mutation", async () => {
    const testFixture = await fixture();
    const changedFingerprint = "d".repeat(64);
    const harness = dependencies({
      diagnose: vi
        .fn<(expectedFingerprint: string) => Promise<DoctorReport>>()
        .mockResolvedValueOnce(doctor(BASELINE_FINGERPRINT, "different"))
        .mockResolvedValueOnce(doctor(changedFingerprint, "different")),
    });

    await expect(runUpgradeSmoke(testFixture.options, harness)).rejects.toThrow(
      "Worker does not match the pinned baseline package.",
    );
    expect(harness.bootstrap).not.toHaveBeenCalled();
  });

  it("classifies a well-formed but wrong baseline fingerprint as invalid input", async () => {
    const testFixture = await fixture();
    const harness = dependencies({
      diagnose: vi
        .fn<(expectedFingerprint: string) => Promise<DoctorReport>>()
        .mockResolvedValue(doctor("d".repeat(64), "different")),
    });
    let failure: unknown;

    try {
      await runUpgradeSmoke(testFixture.options, harness);
    } catch (error) {
      failure = error;
    }

    expect(createUpgradeSmokeFailure(testFixture.receiptPath, failure)).toMatchObject({
      code: "invalid_input",
      recovery: "fix_input",
    });
    expect(harness.captureOwnerState).not.toHaveBeenCalled();
    expect(harness.bootstrap).not.toHaveBeenCalled();
  });

  it("classifies incompatible migration ancestry as an unsupported upgrade", async () => {
    const testFixture = await fixture();
    const harness = dependencies({
      inspectInfrastructure: vi
        .fn<UpgradeSmokeDependencies["inspectInfrastructure"]>()
        .mockResolvedValue(infrastructure(["0000_unknown.sql"])),
    });
    let failure: unknown;

    try {
      await runUpgradeSmoke(testFixture.options, harness);
    } catch (error) {
      failure = error;
    }

    expect(createUpgradeSmokeFailure(testFixture.receiptPath, failure)).toMatchObject({
      code: "unsupported_upgrade",
      recovery: "use_supported_upgrade",
    });
    expect(harness.captureOwnerState).not.toHaveBeenCalled();
    expect(harness.bootstrap).not.toHaveBeenCalled();
  });

  it("resumes from a pending receipt without replacing the baseline snapshot", async () => {
    const testFixture = await fixture();
    const firstHarness = dependencies({
      bootstrap: vi.fn<UpgradeSmokeDependencies["bootstrap"]>(async () => {
        throw new Error("Ambiguous deploy response.");
      }),
    });

    await expect(runUpgradeSmoke(testFixture.options, firstHarness)).rejects.toThrow(
      "Ambiguous deploy response.",
    );
    expect(firstHarness.captureOwnerState).toHaveBeenCalledTimes(1);
    expect(
      upgradeReceiptSchema.parse(JSON.parse(await readFile(testFixture.receiptPath, "utf8"))),
    ).toMatchObject({ phase: "upgrade_pending" });

    const resumedHarness = dependencies({
      bootstrap: vi
        .fn<
          (
            options: BootstrapOptions,
            expectedDeploymentFingerprint: string,
          ) => Promise<BootstrapReport>
        >()
        .mockResolvedValue(bootstrap("unchanged")),
      diagnose: vi
        .fn<(expectedFingerprint: string) => Promise<DoctorReport>>()
        .mockResolvedValue(doctor(CURRENT_FINGERPRINT, "aligned")),
      inspectInfrastructure: vi
        .fn<UpgradeSmokeDependencies["inspectInfrastructure"]>()
        .mockResolvedValue(infrastructure(CURRENT_MIGRATIONS)),
    });
    const report = await runUpgradeSmoke(testFixture.options, resumedHarness);

    expect(report.recovery).toBe("resumed");
    expect(report.deployment).toEqual({ firstAction: "updated", retryAction: "unchanged" });
    expect(resumedHarness.captureOwnerState).toHaveBeenCalledTimes(1);
    expect(resumedHarness.inspectInfrastructure).toHaveBeenCalledTimes(2);
  });

  it("retains recovery state when owner evidence changes", async () => {
    const testFixture = await fixture();
    const captureOwnerState = vi
      .fn<NonNullable<UpgradeSmokeDependencies["captureOwnerState"]>>()
      .mockResolvedValueOnce(ownerState())
      .mockResolvedValueOnce(ownerState("5"));
    const harness = dependencies({ captureOwnerState });

    await expect(runUpgradeSmoke(testFixture.options, harness)).rejects.toThrow(
      "Owner state or deployed secret inventory changed during upgrade.",
    );
    expect(harness.bootstrap).toHaveBeenCalledTimes(1);
    expect(
      upgradeReceiptSchema.parse(JSON.parse(await readFile(testFixture.receiptPath, "utf8"))),
    ).toMatchObject({ phase: "upgrade_pending" });
  });
});
