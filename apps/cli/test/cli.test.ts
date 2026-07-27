import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CLI_HELP, runCli, type CliDependencies } from "../src/cli.js";
import { doctorReportSchema } from "../src/doctor.js";

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof URL) {
    return input.pathname;
  }

  return new URL(typeof input === "string" ? input : input.url).pathname;
}

function healthyDeploymentFetch(): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const path = requestPath(input);
    let payload: unknown;

    if (path === "/health") {
      payload = { service: "crewhelm", status: "ok" };
    } else if (path === "/.well-known/oauth-protected-resource") {
      payload = {
        authorization_servers: ["https://crewhelm.example/api/auth"],
        bearer_methods_supported: ["header"],
        resource: "https://crewhelm.example/mcp",
        scopes_supported: ["control:read"],
      };
    } else {
      payload = {
        authorization_endpoint: "https://crewhelm.example/api/auth/oauth2/authorize",
        authorization_response_iss_parameter_supported: true,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code"],
        issuer: "https://crewhelm.example/api/auth",
        jwks_uri: "https://crewhelm.example/api/auth/jwks",
        registration_endpoint: "https://crewhelm.example/api/auth/oauth2/register",
        response_modes_supported: ["query"],
        response_types_supported: ["code"],
        revocation_endpoint: "https://crewhelm.example/api/auth/oauth2/revoke",
        scopes_supported: ["control:read"],
        token_endpoint: "https://crewhelm.example/api/auth/oauth2/token",
        token_endpoint_auth_methods_supported: ["none"],
      };
    }

    return Response.json(payload);
  });
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
    fetch,
    readEnvironment: () => undefined,
    runWrangler: vi.fn<CliDependencies["runWrangler"]>(),
    writeError: (text) => errors.push(text),
    writeOutput: (text) => output.push(text),
    ...overrides,
  };

  return { dependencies, errors, output };
}

describe("Crewhelm CLI", () => {
  it("prints concise help without making a request", async () => {
    const harness = createHarness();

    await expect(runCli([], harness.dependencies)).resolves.toBe(0);
    expect(harness.output).toEqual([CLI_HELP]);
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
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

  it("does not reflect an invalid command value", async () => {
    const harness = createHarness();

    await expect(runCli(["secret-command-value"], harness.dependencies)).resolves.toBe(2);
    expect(harness.errors.join("")).not.toContain("secret-command-value");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });

  it("emits a stable bootstrap failure without reflecting Wrangler output", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "crewhelm-cli-test-"));
    await mkdir(resolve(directory, "migrations"));
    await writeFile(resolve(directory, "index.js"), "export default {};\n");
    await writeFile(resolve(directory, "index.js.map"), "{}\n");
    await writeFile(resolve(directory, "migrations", "0001_better_auth.sql"), "SELECT 1;\n");
    await writeFile(
      resolve(directory, "wrangler-template.json"),
      JSON.stringify({
        compatibility_date: "2026-07-22",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "AUTH_DB",
            database_id: "c58217fd-fe09-447b-b79c-5d63ed1cedc0",
            database_name: "crewhelm-auth",
            migrations_dir: "./migrations",
          },
        ],
        durable_objects: {
          bindings: [{ class_name: "OwnerControlPlane", name: "OWNER_CONTROL_PLANE" }],
        },
        exports: {
          OwnerControlPlane: { storage: "sqlite", type: "durable-object" },
        },
        main: "./index.js",
        name: "crewhelm",
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
        triggers: { crons: ["17 * * * *"] },
        vars: { PUBLIC_ORIGIN: "https://crewhelm.example" },
      }),
    );
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
        runCli(
          ["bootstrap", "--endpoint", "https://crewhelm.example", "--json"],
          harness.dependencies,
        ),
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
    { arguments_: ["bootstrap", "--endpoint", "http://localhost:8787"] },
    {
      arguments_: [
        "bootstrap",
        "--endpoint",
        "https://crewhelm.example",
        "--worker-name",
        "Invalid_Name",
      ],
    },
  ])("returns a usage error for $arguments_ without making a request", async ({ arguments_ }) => {
    const harness = createHarness();

    await expect(runCli(arguments_, harness.dependencies)).resolves.toBe(2);
    expect(harness.output).toEqual([]);
    expect(harness.errors.join("")).toContain("Error:");
    expect(harness.dependencies.fetch).not.toHaveBeenCalled();
  });
});
