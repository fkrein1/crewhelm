import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { authenticatedDoctorReportSchema } from "../src/authenticated-doctor.js";
import { agentSmokeReportSchema } from "../src/agent-smoke.js";
import { readPackagedDeploymentFingerprint } from "../src/bootstrap.js";
import { CLI_HELP, parseCli, runCli, type CliDependencies } from "../src/cli.js";
import { doctorReportSchema } from "../src/doctor.js";
import { readInstallation } from "../src/installation.js";
import { installationSmokeFailureSchema } from "../src/installation-smoke.js";
import { CLI_BANNER } from "../src/presentation.js";
import { standingIntegrationSmokeReportSchema } from "../src/standing-integration-smoke.js";
import { upgradeSmokeFailureSchema } from "../src/upgrade-smoke.js";

const DATABASE_ID = "c58217fd-fe09-447b-b79c-5d63ed1cedc0";
const DEPLOYMENT_VERSION_ID = "37bcd44d-e373-41a2-8a47-eb03cce01d32";
const DEPLOYMENT_FINGERPRINT = "a".repeat(64);
const EXPECTED_MIGRATIONS = [
  "0001_better_auth.sql",
  "0002_control_write_scope.sql",
  "0003_integration_catalog_scope.sql",
  "0004_agent_definition_read_scope.sql",
  "0005_agent_update_scope.sql",
  "0006_connection_write_scope.sql",
  "0007_connection_read_scope.sql",
  "0008_connection_config_read_scope.sql",
  "0009_connection_config_write_scope.sql",
  "0010_oauth_offline_access.sql",
  "0011_autonomy_write_scope.sql",
  "0012_access_levels.sql",
] as const;
const AUTH_TABLES = [
  "_cf_KV",
  "account",
  "d1_migrations",
  "jwks",
  "mcpClientRegistration",
  "mcpTokenRevocation",
  "oauthAccessToken",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthConsent",
  "oauthRefreshToken",
  "oauthResource",
  "session",
  "sqlite_sequence",
  "user",
  "verification",
] as const;

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.pathname;
  }

  return new URL(typeof input === "string" ? input : input.url).pathname;
}

function healthyDeploymentFetch(
  deploymentFingerprint = DEPLOYMENT_FINGERPRINT,
): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const path = requestPath(input);
    let payload: unknown;

    if (path === "/health") {
      payload = {
        deployment: { fingerprint: deploymentFingerprint, protocolVersion: 1 },
        service: "crewhelm",
        status: "ok",
      };
    } else if (path === "/.well-known/oauth-protected-resource") {
      payload = {
        authorization_servers: ["https://crewhelm.example/api/auth"],
        bearer_methods_supported: ["header"],
        resource: "https://crewhelm.example/mcp",
        scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
      };
    } else {
      payload = {
        authorization_endpoint: "https://crewhelm.example/api/auth/oauth2/authorize",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: "https://crewhelm.example/api/auth",
        jwks_uri: "https://crewhelm.example/api/auth/jwks",
        registration_endpoint: "https://crewhelm.example/api/auth/oauth2/register",
        response_modes_supported: ["query"],
        response_types_supported: ["code"],
        revocation_endpoint: "https://crewhelm.example/api/auth/oauth2/revoke",
        scopes_supported: ["crewhelm:view", "crewhelm:use", "crewhelm:full", "offline_access"],
        token_endpoint: "https://crewhelm.example/api/auth/oauth2/token",
        token_endpoint_auth_methods_supported: ["none"],
      };
    }

    return Response.json(payload);
  });
}

function completedWrangler(stdout = "") {
  return {
    exitCode: 0,
    outcome: "completed" as const,
    stderr: "",
    stdout,
  };
}

function createHarness(
  fetch: typeof globalThis.fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 503 })),
  overrides: Partial<CliDependencies> = {},
) {
  const output: string[] = [];
  const errors: string[] = [];
  const dependencies: CliDependencies = {
    deploymentAssetsDirectory: "/not-used-by-doctor",
    deploymentFingerprint: DEPLOYMENT_FINGERPRINT,
    fetch,
    readEnvironment: () => undefined,
    runWrangler: vi.fn<CliDependencies["runWrangler"]>(),
    writeError: (text) => errors.push(text),
    writeOutput: (text) => output.push(text),
    ...overrides,
  };

  return { dependencies, errors, output };
}

async function createDeploymentAssetsDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-cli-test-"));
  await mkdir(resolve(directory, "migrations"));
  await writeFile(resolve(directory, "index.js"), "export default {};\n");
  await writeFile(resolve(directory, "index.js.map"), "{}\n");

  for (const migration of EXPECTED_MIGRATIONS) {
    await writeFile(resolve(directory, "migrations", migration), "SELECT 1;\n");
  }

  await writeFile(
    resolve(directory, "wrangler-template.json"),
    JSON.stringify({
      ai: { binding: "AI" },
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
      d1_databases: [
        {
          binding: "AUTH_DB",
          database_id: DATABASE_ID,
          database_name: "crewhelm-auth",
          migrations_dir: "./migrations",
        },
      ],
      durable_objects: {
        bindings: [
          { class_name: "OwnerControlPlane", name: "OWNER_CONTROL_PLANE" },
          { class_name: "CrewAgent", name: "CREW_AGENT" },
        ],
      },
      exports: {
        CrewAgent: { storage: "sqlite", type: "durable-object" },
        OwnerControlPlane: { storage: "sqlite", type: "durable-object" },
      },
      main: "./index.js",
      name: "crewhelm",
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 1, invocation_logs: false },
        traces: { enabled: false },
      },
      ratelimits: [
        {
          name: "AUTH_RATE_LIMIT",
          namespace_id: "10001",
          simple: { limit: 10, period: 60 },
        },
        {
          name: "MCP_RATE_LIMIT",
          namespace_id: "10002",
          simple: { limit: 60, period: 60 },
        },
      ],
      rules: [{ fallthrough: true, globs: ["**/*.sql"], type: "Text" }],
      triggers: { crons: ["17 * * * *"] },
      vars: {
        PUBLIC_ORIGIN: "https://crewhelm.example",
      },
    }),
  );

  return directory;
}

describe("Crewhelm CLI", () => {
  it("prints concise help without making a request", async () => {
    const harness = createHarness();

    await expect(runCli([], harness.dependencies)).resolves.toBe(0);
    expect(harness.output).toEqual([CLI_HELP]);
    expect(CLI_HELP).toContain("Examples:");
    expect(CLI_HELP).toContain("$ crewhelm up");
    expect(CLI_HELP).not.toContain("CREWHELM_CLOUDFLARE_API_TOKEN");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("colors the root hierarchy when interactive", async () => {
    const harness = createHarness(undefined, { color: true, interactive: true });

    await expect(runCli([], harness.dependencies)).resolves.toBe(0);
    expect(harness.output.join("")).toContain(">_");
    expect(harness.output.join("")).toContain("CREWHELM");
    expect(harness.output.join("")).toContain("\u001B[38;2;100;168;255m");
    expect(harness.output.join("")).toContain("\u001B[38;2;10;132;255m");
    expect(harness.errors).toEqual([]);
  });

  it("prints command-specific help through the injected output", async () => {
    const harness = createHarness(undefined, { color: true, interactive: true });

    await expect(runCli(["doctor", "--help"], harness.dependencies)).resolves.toBe(0);
    expect(harness.output.join("")).toContain("crewhelm doctor [options]");
    expect(harness.output.join("")).toContain("--authenticated");
    expect(harness.output.join("")).not.toContain("--confirm-production");
    expect(harness.output.join("")).toContain("\u001B[");
    expect(harness.errors).toEqual([]);

    const upHarness = createHarness();

    await expect(runCli(["up", "--help"], upHarness.dependencies)).resolves.toBe(0);
    expect(upHarness.output.join("")).toContain("Automation:");
    expect(upHarness.output.join("")).toContain("CREWHELM_COMPOSIO_API_KEY");
    expect(upHarness.output.join("")).toContain("CREWHELM_CLOUDFLARE_API_TOKEN");
    expect(upHarness.output.join("")).toContain("Safety:");
  });

  it("adds a color-safe banner and progress only for interactive human output", async () => {
    const harness = createHarness(undefined, { color: true, interactive: true });

    await expect(
      runCli(["up", "--endpoint", "https://crewhelm.example"], harness.dependencies),
    ).resolves.toBe(1);
    expect(harness.output[0]).toContain(">_");
    expect(harness.output[0]).toContain("CREWHELM");
    expect(harness.output[0]).toContain("\u001B[");
    expect(harness.output.join("")).toContain("Installation target");
    expect(harness.output.join("")).toContain("Worker    crewhelm");
    expect(harness.output.join("")).toContain("Endpoint  https://crewhelm.example");
    expect(harness.errors.join("")).toContain("Loading packaged deployment assets");
    expect(harness.errors.join("")).toContain("\u001B[");

    const plainHarness = createHarness(undefined, { color: true, interactive: true });

    await expect(runCli(["--no-color", "--help"], plainHarness.dependencies)).resolves.toBe(0);
    expect(plainHarness.output.join("")).toContain(CLI_BANNER);
    expect(plainHarness.output.join("")).not.toContain("\u001B[");
  });

  it("keeps JSON setup non-interactive and stdout clean", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-cli-json-test-"));
    const promptText = vi.fn<(message: string) => Promise<string>>();
    const promptSecret = vi.fn<(message: string) => Promise<string>>();
    const createGitHubApp = vi.fn<NonNullable<CliDependencies["createGitHubApp"]>>();
    const harness = createHarness(undefined, {
      createGitHubApp,
      interactive: true,
      promptSecret,
      promptText,
    });

    try {
      await expect(
        runCli(
          ["up", "--json", "--installation", resolve(directory, "installation.json")],
          harness.dependencies,
        ),
      ).resolves.toBe(2);
      expect(promptText).not.toHaveBeenCalled();
      expect(promptSecret).not.toHaveBeenCalled();
      expect(createGitHubApp).not.toHaveBeenCalled();
      expect(harness.output).toEqual([]);
      expect(harness.errors.join("")).toContain("up requires an HTTPS endpoint on the first run.");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts a bounded installation AI budget in dollars", () => {
    expect(
      parseCli(["up", "--endpoint", "https://crewhelm.example", "--ai-budget-usd", "2.50"]),
    ).toMatchObject({
      aiDailySpendUsd: 2.5,
      kind: "up",
    });
    expect(
      parseCli(["doctor", "--endpoint", "https://crewhelm.example", "--no-color"]),
    ).toMatchObject({ kind: "doctor" });
  });

  it.each([
    {
      answers: ["yes", "7.50"],
      expectedPrompts: ["Choose [1]: ", "Daily limit in USD: "],
      label: "enables the recommended Gateway with an explicit amount",
    },
    {
      answers: ["skip"],
      expectedPrompts: ["Choose [1]: "],
      label: "skips the optional Gateway",
    },
  ])("$label during first-run guidance", async ({ answers, expectedPrompts }) => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-cli-guidance-test-"));
    const promptText = vi.fn<(message: string) => Promise<string>>(
      async () => answers.shift() ?? "",
    );
    const harness = createHarness(undefined, { promptText });

    try {
      await expect(
        runCli(
          [
            "up",
            "--endpoint",
            "https://crewhelm.example",
            "--installation",
            resolve(directory, "installation.json"),
          ],
          harness.dependencies,
        ),
      ).resolves.toBe(1);
      expect(promptText.mock.calls.map(([message]) => message)).toEqual(expectedPrompts);
      expect(harness.output.join("")).toContain("AI spending protection");
      expect(harness.output.join("")).toContain("1. Configure a spending limit (recommended)");
      expect(harness.output.join("")).toContain("2. Continue without a spending limit");
      expect(harness.errors.join("")).toContain("FAIL Setup stopped");
      expect(harness.errors.join("")).toContain("Stage  Preparation");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a healthy Worker in human-readable form", async () => {
    const harness = createHarness(healthyDeploymentFetch());

    await expect(
      runCli(["doctor", "--endpoint", "https://crewhelm.example"], harness.dependencies),
    ).resolves.toBe(0);
    expect(harness.output.join("")).toContain("PASS worker-health https://crewhelm.example/health");
    expect(harness.output.join("")).toContain(
      "PASS mcp-protected-resource https://crewhelm.example/.well-known/oauth-protected-resource",
    );
    expect(harness.output.join("")).toContain(
      "PASS oauth-authorization-server https://crewhelm.example/.well-known/oauth-authorization-server/api/auth",
    );
    expect(harness.errors).toEqual([]);
  });

  it("routes the explicit authenticated doctor flag to a stable layered report", async () => {
    const harness = createHarness(healthyDeploymentFetch());

    expect(
      parseCli(["doctor", "--endpoint", "https://crewhelm.example", "--authenticated"]),
    ).toMatchObject({
      authenticated: true,
      kind: "doctor",
    });
    await expect(
      runCli(
        ["doctor", "--endpoint", "https://crewhelm.example", "--authenticated", "--json"],
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    const report = authenticatedDoctorReportSchema.parse(JSON.parse(harness.output.join("")));
    expect(report.public.ok).toBe(true);
    expect(report.checks[0]).toMatchObject({
      code: "invalid_payload",
      name: "oauth-owner-access",
      status: "fail",
    });
    expect(report.checks.slice(1).every((check) => check.status === "skip")).toBe(true);
    expect(harness.errors).toEqual([]);
  });

  it("requires explicit production confirmation for the Agent smoke command", () => {
    expect(() => parseCli(["smoke", "agent", "--endpoint", "https://crewhelm.example"])).toThrow(
      "smoke agent requires --confirm-production.",
    );
    expect(() =>
      parseCli(["smoke", "agent", "--endpoint", "http://127.0.0.1:8787", "--confirm-production"]),
    ).toThrow("smoke agent requires an HTTPS endpoint.");
  });

  it("requires isolated coordinates for the fresh-install smoke command", () => {
    expect(() =>
      parseCli([
        "smoke",
        "installation",
        "--endpoint",
        "https://crewhelm-smoke-example.workers.dev",
        "--worker-name",
        "crewhelm-smoke-example",
        "--database-name",
        "crewhelm-smoke-example",
      ]),
    ).toThrow("smoke installation requires --confirm-production.");
    expect(() =>
      parseCli([
        "smoke",
        "installation",
        "--endpoint",
        "https://crewhelm-smoke-example.workers.dev",
        "--worker-name",
        "crewhelm",
        "--database-name",
        "crewhelm-smoke-example",
        "--confirm-production",
      ]),
    ).toThrow("One or more command values were invalid or outside their bounds.");
    expect(
      parseCli([
        "smoke",
        "installation",
        "--endpoint",
        "https://crewhelm-smoke-example.workers.dev",
        "--worker-name",
        "crewhelm-smoke-example",
        "--database-name",
        "crewhelm-smoke-example",
        "--ai-budget-usd",
        "3",
        "--confirm-production",
      ]),
    ).toMatchObject({
      aiDailySpendUsd: 3,
      cleanupOnly: false,
      kind: "installation-smoke",
      workerName: "crewhelm-smoke-example",
    });
  });

  it("requires a pinned build and explicit confirmation for the upgrade smoke", () => {
    expect(() =>
      parseCli([
        "smoke",
        "upgrade",
        "--endpoint",
        "https://crewhelm-upgrade.example",
        "--from-fingerprint",
        "b".repeat(64),
      ]),
    ).toThrow("smoke upgrade requires --confirm-production.");
    expect(() =>
      parseCli([
        "smoke",
        "upgrade",
        "--endpoint",
        "https://crewhelm-upgrade.example",
        "--from-fingerprint",
        "not-a-fingerprint",
        "--confirm-production",
      ]),
    ).toThrow("One or more command values were invalid or outside their bounds.");
    expect(
      parseCli([
        "smoke",
        "upgrade",
        "--endpoint",
        "https://crewhelm-upgrade.example",
        "--from-fingerprint",
        "b".repeat(64),
        "--confirm-production",
      ]),
    ).toMatchObject({
      baselineFingerprint: "b".repeat(64),
      kind: "upgrade-smoke",
      receiptPath: "crewhelm.upgrade-receipt.json",
    });
  });

  it("routes only upgrade options into the strict rehearsal contract", async () => {
    const harness = createHarness(healthyDeploymentFetch());
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-upgrade-smoke-cli-test-"));
    const receiptPath = resolve(directory, "receipt.json");

    try {
      await expect(
        runCli(
          [
            "smoke",
            "upgrade",
            "--endpoint",
            "https://crewhelm-upgrade.example",
            "--from-fingerprint",
            "b".repeat(64),
            "--installation",
            resolve(directory, "missing-installation.json"),
            "--receipt",
            receiptPath,
            "--confirm-production",
            "--json",
          ],
          harness.dependencies,
        ),
      ).resolves.toBe(1);

      expect(upgradeSmokeFailureSchema.parse(JSON.parse(harness.errors.join("")))).toMatchObject({
        code: "invalid_input",
        ok: false,
        receiptPath,
        recovery: "fix_input",
        stage: "upgrade",
      });
      expect(harness.errors.join("")).not.toContain("unrecognized_keys");
      expect(harness.output).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("classifies malformed upgrade metadata as an input failure", async () => {
    const harness = createHarness(healthyDeploymentFetch());
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-upgrade-smoke-cli-test-"));
    const installationPath = resolve(directory, "installation.json");
    const receiptPath = resolve(directory, "receipt.json");
    await writeFile(installationPath, "{", { mode: 0o600 });

    try {
      await expect(
        runCli(
          [
            "smoke",
            "upgrade",
            "--endpoint",
            "https://crewhelm-upgrade.example",
            "--from-fingerprint",
            "b".repeat(64),
            "--installation",
            installationPath,
            "--receipt",
            receiptPath,
            "--confirm-production",
            "--json",
          ],
          harness.dependencies,
        ),
      ).resolves.toBe(1);

      expect(upgradeSmokeFailureSchema.parse(JSON.parse(harness.errors.join("")))).toMatchObject({
        code: "invalid_input",
        recovery: "fix_input",
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("keeps thrown fresh-install failures machine-readable in JSON mode", async () => {
    const harness = createHarness(healthyDeploymentFetch());
    const receiptPath = resolve(
      await mkdtemp(resolve(tmpdir(), "crewhelm-installation-smoke-cli-test-")),
      "missing.json",
    );

    try {
      await expect(
        runCli(
          [
            "smoke",
            "installation",
            "--endpoint",
            "https://crewhelm-smoke-example.workers.dev",
            "--worker-name",
            "crewhelm-smoke-example",
            "--database-name",
            "crewhelm-smoke-example",
            "--receipt",
            receiptPath,
            "--cleanup-only",
            "--confirm-production",
            "--json",
          ],
          harness.dependencies,
        ),
      ).resolves.toBe(1);

      expect(
        installationSmokeFailureSchema.parse(JSON.parse(harness.errors.join(""))),
      ).toMatchObject({
        ok: false,
        receiptPath,
        recovery: "cleanup_retry_failed",
        stage: "rehearsal",
      });
      expect(harness.output).toEqual([]);
    } finally {
      await rm(resolve(receiptPath, ".."), { force: true, recursive: true });
    }
  });

  it("parses bounded Agent smoke timeouts and routes public failures without authorization", async () => {
    expect(
      parseCli([
        "smoke",
        "agent",
        "--endpoint",
        "https://crewhelm.example",
        "--confirm-production",
        "--run-timeout-ms",
        "45000",
        "--timeout-ms",
        "2000",
      ]),
    ).toMatchObject({
      confirmProduction: true,
      kind: "agent-smoke",
      runTimeoutMs: 45_000,
      timeoutMs: 2_000,
    });

    const openUrl = vi.fn<(url: URL) => Promise<void>>();
    const harness = createHarness(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      { openUrl },
    );

    await expect(
      runCli(
        [
          "smoke",
          "agent",
          "--endpoint",
          "https://crewhelm.example",
          "--confirm-production",
          "--json",
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    const report = agentSmokeReportSchema.parse(JSON.parse(harness.output.join("")));
    expect(report.public.ok).toBe(false);
    expect(report.checks.every((check) => check.status === "skip")).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
  });

  it("offers an explicit matching deploy before an interactive smoke and respects decline", async () => {
    const openUrl = vi.fn<(url: URL) => Promise<void>>();
    const promptText = vi.fn<(message: string) => Promise<string>>(async () => "no");
    const harness = createHarness(healthyDeploymentFetch("b".repeat(64)), {
      interactive: true,
      openUrl,
      promptText,
    });

    await expect(
      runCli(
        ["smoke", "agent", "--endpoint", "https://crewhelm.example", "--confirm-production"],
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    expect(promptText).toHaveBeenCalledWith(
      "Worker runs a different compatible build. Deploy this CLI's bundled Worker now? [y/N]: ",
    );
    expect(openUrl).not.toHaveBeenCalled();
    expect(harness.output.join("")).toContain("FAIL deployment-alignment");
    expect(harness.errors).toEqual([]);
  });

  it("requires an exact connection and explicit confirmation for the integration smoke", async () => {
    const connectionId = "connection_33333333-3333-4333-8333-333333333333";

    expect(() =>
      parseCli([
        "smoke",
        "integration",
        "--endpoint",
        "https://crewhelm.example",
        "--connection-id",
        connectionId,
      ]),
    ).toThrow("smoke integration requires --confirm-production.");
    expect(() =>
      parseCli([
        "smoke",
        "integration",
        "--endpoint",
        "https://crewhelm.example",
        "--connection-id",
        "not-a-connection",
        "--confirm-production",
      ]),
    ).toThrow("One or more command values were invalid or outside their bounds.");
    expect(
      parseCli([
        "smoke",
        "integration",
        "--endpoint",
        "https://crewhelm.example",
        "--connection-id",
        connectionId,
        "--confirm-production",
        "--run-timeout-ms",
        "45000",
      ]),
    ).toMatchObject({
      confirmProduction: true,
      connectionId,
      kind: "standing-integration-smoke",
      runTimeoutMs: 45_000,
      trigger: "manual",
    });
    expect(
      parseCli([
        "smoke",
        "integration",
        "--endpoint",
        "https://crewhelm.example",
        "--connection-id",
        connectionId,
        "--confirm-production",
        "--trigger",
        "schedule",
      ]),
    ).toMatchObject({
      connectionId,
      kind: "standing-integration-smoke",
      runTimeoutMs: 180_000,
      trigger: "schedule",
    });
    expect(() =>
      parseCli([
        "smoke",
        "integration",
        "--endpoint",
        "https://crewhelm.example",
        "--connection-id",
        connectionId,
        "--confirm-production",
        "--trigger",
        "hourly",
      ]),
    ).toThrow("One or more command values were invalid or outside their bounds.");

    const openUrl = vi.fn<(url: URL) => Promise<void>>();
    const harness = createHarness(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 })),
      { openUrl },
    );

    await expect(
      runCli(
        [
          "smoke",
          "integration",
          "--endpoint",
          "https://crewhelm.example",
          "--connection-id",
          connectionId,
          "--confirm-production",
          "--json",
        ],
        harness.dependencies,
      ),
    ).resolves.toBe(1);

    const report = standingIntegrationSmokeReportSchema.parse(JSON.parse(harness.output.join("")));
    expect(report.public.ok).toBe(false);
    expect(report.connectionId).toBe(connectionId);
    expect(report.trigger).toBe("manual");
    expect(report.checks.every((check) => check.status === "skip")).toBe(true);
    expect(openUrl).not.toHaveBeenCalled();
    expect(harness.errors).toEqual([]);
  });

  it("emits a stable JSON failure without reflecting the response body", async () => {
    const harness = createHarness(
      vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
        return new Response("secret-provider-diagnostic", {
          headers: { "content-type": "text/plain" },
          status: 503,
        });
      }),
    );

    await expect(
      runCli(["doctor", "--endpoint", "https://crewhelm.example", "--json"], harness.dependencies),
    ).resolves.toBe(1);

    const report = doctorReportSchema.parse(JSON.parse(harness.output.join("")));
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.code)).toEqual([
      "http_status",
      "http_status",
      "http_status",
    ]);
    expect(harness.output.join("")).not.toContain("secret-provider-diagnostic");
  });

  it.each([
    {
      arguments_: ["secret-command-value"],
      secret: "secret-command-value",
    },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "--secret-option-value"],
      secret: "secret-option-value",
    },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "secret-positional-value"],
      secret: "secret-positional-value",
    },
  ])("does not reflect invalid input from $arguments_", async ({ arguments_, secret }) => {
    const harness = createHarness();

    await expect(runCli(arguments_, harness.dependencies)).resolves.toBe(2);
    expect(harness.errors.join("")).not.toContain(secret);
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("recreates missing installation metadata before upgrading an existing Worker", async () => {
    const directory = await createDeploymentAssetsDirectory();
    const deploymentFingerprint = await readPackagedDeploymentFingerprint({
      deploymentAssetsDirectory: directory,
    });
    const installationPath = resolve(directory, "installation.json");
    const databaseName = "crewhelm-development-auth";
    const events: string[] = [];
    let metadataAtMutation: Awaited<ReturnType<typeof readInstallation>>;
    const runWrangler = vi.fn<CliDependencies["runWrangler"]>(async (arguments_) => {
      events.push(arguments_.slice(0, 2).join(":"));

      if (arguments_[0] === "whoami") {
        return completedWrangler(
          JSON.stringify({
            accounts: [{ id: "055dc37aa5b65190125a66e918e9b73e", name: "owner" }],
            loggedIn: true,
          }),
        );
      }
      if (arguments_[0] === "deployments") {
        return completedWrangler(
          JSON.stringify([
            {
              id: "24f9520f-a92f-47e8-8c7d-6cbd14c89309",
              versions: [{ percentage: 100, version_id: DEPLOYMENT_VERSION_ID }],
            },
          ]),
        );
      }
      if (arguments_[0] === "versions") {
        return completedWrangler(
          JSON.stringify({
            id: DEPLOYMENT_VERSION_ID,
            resources: {
              bindings: [
                { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
                { name: "AI_GATEWAY_ID", text: "crewhelm", type: "plain_text" },
                {
                  name: "PUBLIC_ORIGIN",
                  text: "https://crewhelm.example",
                  type: "plain_text",
                },
              ],
              script_runtime: {
                exports: {
                  CrewAgent: { storage: "sqlite", type: "durable-object" },
                  OwnerControlPlane: { storage: "sqlite", type: "durable-object" },
                },
              },
            },
          }),
        );
      }
      if (arguments_[0] === "secret") {
        return completedWrangler(
          JSON.stringify(
            [
              "BETTER_AUTH_SECRET",
              "COMPOSIO_API_KEY",
              "GITHUB_CLIENT_ID",
              "GITHUB_CLIENT_SECRET",
              "OWNER_GITHUB_USER_ID",
            ].map((name) => ({ name, type: "secret_text" })),
          ),
        );
      }
      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return completedWrangler(JSON.stringify([{ name: databaseName, uuid: DATABASE_ID }]));
      }
      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        const names = arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
          ? EXPECTED_MIGRATIONS
          : AUTH_TABLES;
        return completedWrangler(
          JSON.stringify([
            {
              results: names.map((name) => ({ name })),
              success: true,
            },
          ]),
        );
      }
      if (arguments_[0] === "d1" && arguments_[1] === "migrations") {
        metadataAtMutation = await readInstallation(installationPath);
      }

      return completedWrangler();
    });
    const harness = createHarness(healthyDeploymentFetch(deploymentFingerprint), {
      deploymentAssetsDirectory: directory,
      runWrangler,
    });

    try {
      await expect(
        runCli(
          [
            "up",
            "--endpoint",
            "https://crewhelm.example",
            "--installation",
            installationPath,
            "--json",
          ],
          harness.dependencies,
        ),
      ).resolves.toBe(0);

      expect(metadataAtMutation).toMatchObject({
        aiGatewayId: "crewhelm",
        databaseId: DATABASE_ID,
        databaseName,
        origin: "https://crewhelm.example",
        workerName: "crewhelm",
      });
      await expect(readInstallation(installationPath)).resolves.toMatchObject({
        aiGatewayId: "crewhelm",
        databaseId: DATABASE_ID,
        databaseName,
        origin: "https://crewhelm.example",
        workerName: "crewhelm",
      });
      expect(events).not.toContain("d1:create");
      expect(events.indexOf("versions:view")).toBeLessThan(events.indexOf("d1:migrations"));
      expect(harness.errors).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("emits a stable up failure without reflecting Wrangler output", async () => {
    const directory = await createDeploymentAssetsDirectory();
    const harness = createHarness(undefined, {
      deploymentAssetsDirectory: directory,
      runWrangler: vi.fn<CliDependencies["runWrangler"]>().mockResolvedValue({
        exitCode: 1,
        outcome: "completed",
        stderr: "secret-provider-diagnostic",
        stdout: "",
      }),
    });

    try {
      await expect(
        runCli(["up", "--endpoint", "https://crewhelm.example", "--json"], harness.dependencies),
      ).resolves.toBe(1);
      expect(JSON.parse(harness.errors.join(""))).toMatchObject({
        ok: false,
        stage: "authentication",
      });
      expect(harness.errors.join("")).not.toContain("secret-provider-diagnostic");
      expect(harness.output).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    { arguments_: ["unknown"] },
    { arguments_: ["doctor"] },
    { arguments_: ["doctor", "--endpoint", "http://example.com"] },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "--timeout-ms", "0"],
    },
    {
      arguments_: ["doctor", "--endpoint", "https://crewhelm.example", "--json", "--json"],
    },
    { arguments_: ["up", "--endpoint", "http://localhost:8787"] },
    {
      arguments_: ["up", "--endpoint", "https://crewhelm.example", "--worker-name", "Invalid_Name"],
    },
    {
      arguments_: ["up", "--endpoint", "https://crewhelm.example", "--ai-budget-usd", "0"],
    },
  ])("returns a usage error for $arguments_ without making a request", async ({ arguments_ }) => {
    const harness = createHarness();

    await expect(runCli(arguments_, harness.dependencies)).resolves.toBe(2);
    expect(harness.output).toEqual([]);
    expect(harness.errors.join("")).toContain("Error:");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });
});
