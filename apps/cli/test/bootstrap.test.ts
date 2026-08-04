import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  bootstrapDeployment,
  bootstrapUpgradeDeployment,
  inspectInstallationInfrastructure,
  rateLimitNamespacesForWorker,
  readPackagedDeploymentFingerprint,
  skillBucketNameForWorker,
  type BootstrapDependencies,
  type BootstrapOptions,
  type BootstrapProgress,
} from "../src/bootstrap.js";
import { type RunWrangler, type WranglerResult } from "../src/wrangler.js";

const DATABASE_ID = "c58217fd-fe09-447b-b79c-5d63ed1cedc0";
const DEPLOYMENT_VERSION_ID = "37bcd44d-e373-41a2-8a47-eb03cce01d32";
const ACCOUNT_ID = "055dc37aa5b65190125a66e918e9b73e";
const HOSTILE_ACCOUNT_NAME = "forged\n\u001B[31mFAIL";
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
const WORKER_SECRET_NAMES = [
  "BETTER_AUTH_SECRET",
  "COMPOSIO_API_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "OWNER_GITHUB_USER_ID",
] as const;
const WORKER_SECRET_NAMES_WITHOUT_COMPOSIO = WORKER_SECRET_NAMES.filter(
  (name) => name !== "COMPOSIO_API_KEY",
);
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
const WORKER_TEXT_MODULE = "0000000000000000000000000000000000000000-0000_test.sql";
const deploymentFingerprints = new Map<string, string>();
const OPTIONS: BootstrapOptions = {
  databaseName: "crewhelm-auth",
  origin: new URL("https://crewhelm.example"),
  timeoutMs: 5_000,
  workerName: "crewhelm",
};
const REUSE_OPTIONS: BootstrapOptions = {
  ...OPTIONS,
  databaseId: DATABASE_ID,
};
const stagedConfigSchema = z.looseObject({
  account_id: z.string(),
  ai: z.looseObject({ binding: z.literal("AI") }),
  d1_databases: z.tuple([z.looseObject({ database_id: z.uuid() })]),
  durable_objects: z.looseObject({
    bindings: z.array(z.looseObject({ class_name: z.string(), name: z.string() })),
  }),
  containers: z
    .tuple([
      z.looseObject({
        class_name: z.literal("CrewhelmSandbox"),
        image: z.literal("docker.io/cloudflare/sandbox:0.12.4-python"),
        instance_type: z.literal("lite"),
        max_instances: z.literal(5),
      }),
    ])
    .optional(),
  observability: z.looseObject({
    logs: z.looseObject({ invocation_logs: z.literal(false) }),
    traces: z.looseObject({ enabled: z.literal(false) }),
  }),
  r2_buckets: z.tuple([
    z.looseObject({
      binding: z.literal("SKILL_PACKAGES"),
      bucket_name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/),
    }),
  ]),
  ratelimits: z.tuple([
    z.looseObject({ namespace_id: z.string() }),
    z.looseObject({ namespace_id: z.string() }),
    z.looseObject({ namespace_id: z.string() }),
  ]),
  rules: z.tuple([
    z.looseObject({
      globs: z.tuple([z.literal("**/*.sql")]),
      type: z.literal("Text"),
    }),
  ]),
  secrets: z.looseObject({ required: z.array(z.string()) }),
  services: z
    .tuple([
      z.looseObject({
        binding: z.literal("RECIPE_REGISTRY"),
        service: z.literal("crewhelm-registry-dev"),
      }),
    ])
    .optional(),
  workflows: z.tuple([
    z.looseObject({
      binding: z.literal("AGENT_TASK_WORKFLOW"),
      class_name: z.literal("AgentTaskWorkflow"),
      name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
    }),
  ]),
  vars: z.looseObject({
    CREWHELM_DEPLOYMENT_FINGERPRINT: z.string().regex(/^[a-f0-9]{64}$/),
    PUBLIC_ORIGIN: z.url(),
  }),
});
const stagedSecretsSchema = z.looseObject({
  BETTER_AUTH_SECRET: z.string(),
  COMPOSIO_API_KEY: z.string(),
  GITHUB_CLIENT_SECRET: z.string(),
});

function success(stdout = ""): WranglerResult {
  return { exitCode: 0, outcome: "completed", stderr: "", stdout };
}

function whoami(): WranglerResult {
  return success(
    JSON.stringify({
      accounts: [{ id: ACCOUNT_ID, name: HOSTILE_ACCOUNT_NAME }],
      loggedIn: true,
    }),
  );
}

function queryResult(names: readonly string[]): WranglerResult {
  return success(JSON.stringify([{ results: names.map((name) => ({ name })), success: true }]));
}

function secretList(names: readonly string[]): WranglerResult {
  return success(JSON.stringify(names.map((name) => ({ name, type: "secret_text" }))));
}

function sandboxContainerList(
  state: "active" | "degraded" | "provisioning" | "ready" = "ready",
  name = "crewhelm-crewhelmsandbox",
) {
  return success(
    JSON.stringify([
      {
        id: "a039044b-a162-4e3e-ab30-98f8655e4138",
        image: "docker.io/cloudflare/sandbox:0.12.4-python",
        name,
        state,
      },
    ]),
  );
}

function gatewayPayload(limit: number): unknown {
  return {
    result: {
      id: OPTIONS.workerName,
      spend_limits: {
        enabled: true,
        rules: [
          {
            enabled: true,
            id: "crewhelm-daily",
            limit,
            limitType: "cost",
            technique: "sliding",
            window: 86_400,
          },
        ],
      },
    },
    success: true,
  };
}

function healthyDeploymentFetch(fingerprint = "a".repeat(64)): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    let payload: unknown;

    if (url.hostname === "api.cloudflare.com") {
      payload = gatewayPayload(1);
    } else if (url.pathname === "/health") {
      payload = {
        deployment: { fingerprint, protocolVersion: 1 },
        service: "crewhelm",
        status: "ok",
      };
    } else if (url.pathname === "/.well-known/oauth-protected-resource") {
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

async function createDeploymentAssets(): Promise<{ assets: string; root: string }> {
  const root = await mkdtemp(resolve(tmpdir(), "crewhelm-bootstrap-test-"));
  const assets = resolve(root, "deployment");
  await mkdir(resolve(assets, "migrations"), { recursive: true });
  await writeFile(
    resolve(assets, "index.js"),
    `import migration from "./${WORKER_TEXT_MODULE}";\nexport default migration;\n`,
  );
  await writeFile(resolve(assets, "index.js.map"), "{}\n");
  await writeFile(resolve(assets, WORKER_TEXT_MODULE), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0001_better_auth.sql"), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0002_control_write_scope.sql"), "SELECT 1;\n");
  await writeFile(
    resolve(assets, "migrations", "0003_integration_catalog_scope.sql"),
    "SELECT 1;\n",
  );
  await writeFile(
    resolve(assets, "migrations", "0004_agent_definition_read_scope.sql"),
    "SELECT 1;\n",
  );
  await writeFile(resolve(assets, "migrations", "0005_agent_update_scope.sql"), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0006_connection_write_scope.sql"), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0007_connection_read_scope.sql"), "SELECT 1;\n");
  await writeFile(
    resolve(assets, "migrations", "0008_connection_config_read_scope.sql"),
    "SELECT 1;\n",
  );
  await writeFile(
    resolve(assets, "migrations", "0009_connection_config_write_scope.sql"),
    "SELECT 1;\n",
  );
  await writeFile(resolve(assets, "migrations", "0010_oauth_offline_access.sql"), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0011_autonomy_write_scope.sql"), "SELECT 1;\n");
  await writeFile(resolve(assets, "migrations", "0012_access_levels.sql"), "SELECT 1;\n");
  await writeFile(
    resolve(assets, "wrangler-template.json"),
    JSON.stringify({
      ai: { binding: "AI" },
      compatibility_date: "2026-07-22",
      compatibility_flags: ["global_fetch_strictly_public", "nodejs_compat"],
      d1_databases: [
        {
          binding: "AUTH_DB",
          database_id: DATABASE_ID,
          database_name: "template-auth",
          migrations_dir: "./migrations",
        },
      ],
      durable_objects: {
        bindings: [
          { class_name: "OwnerControlPlane", name: "OWNER_CONTROL_PLANE" },
          { class_name: "CrewAgent", name: "CREW_AGENT" },
          { class_name: "CrewSession", name: "CREW_SESSION" },
          { class_name: "CrewhelmSandbox", name: "CODE_SANDBOX" },
        ],
      },
      containers: [
        {
          class_name: "CrewhelmSandbox",
          image: "docker.io/cloudflare/sandbox:0.12.4-python",
          instance_type: "lite",
          max_instances: 5,
        },
      ],
      exports: {
        CrewAgent: {
          storage: "sqlite",
          type: "durable-object",
        },
        CrewSession: {
          storage: "sqlite",
          type: "durable-object",
        },
        CrewhelmSandbox: {
          storage: "sqlite",
          type: "durable-object",
        },
        OwnerControlPlane: {
          storage: "sqlite",
          type: "durable-object",
        },
      },
      main: "./index.js",
      name: "crewhelm",
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          head_sampling_rate: 1,
          invocation_logs: false,
        },
        traces: {
          enabled: false,
        },
      },
      r2_buckets: [{ binding: "SKILL_PACKAGES", bucket_name: "template-skills" }],
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
        {
          name: "COMPOSIO_WEBHOOK_RATE_LIMIT",
          namespace_id: "10003",
          simple: { limit: 600, period: 60 },
        },
      ],
      rules: [{ fallthrough: true, globs: ["**/*.sql"], type: "Text" }],
      triggers: { crons: ["17 * * * *"] },
      vars: { PUBLIC_ORIGIN: "https://template.example" },
      workflows: [
        {
          binding: "AGENT_TASK_WORKFLOW",
          class_name: "AgentTaskWorkflow",
          name: "crewhelm-agent-task-workflow",
        },
      ],
    }),
  );
  deploymentFingerprints.set(
    assets,
    await readPackagedDeploymentFingerprint({ deploymentAssetsDirectory: assets }),
  );
  return { assets, root };
}

function createDependencies(
  assets: string,
  runWrangler: RunWrangler,
  environment: Readonly<Record<string, string>> = {},
  initialBuckets: readonly string[] = [],
): BootstrapDependencies {
  const buckets = new Set(initialBuckets);

  return {
    deploymentAssetsDirectory: assets,
    fetch: healthyDeploymentFetch(deploymentFingerprints.get(assets)),
    readEnvironment: (name) => environment[name],
    wait: async () => {},
    runWrangler: (arguments_, options) => {
      if (arguments_[0] === "auth") {
        return Promise.resolve(success(JSON.stringify({ token: "test-token", type: "oauth" })));
      }

      if (arguments_.slice(0, 3).join(" ") === "r2 bucket info") {
        const name = arguments_[3] ?? "";

        return Promise.resolve(
          buckets.has(name)
            ? success(JSON.stringify({ name }))
            : {
                exitCode: 1,
                outcome: "completed",
                stderr: "The specified bucket does not exist. [code: 10006]",
                stdout: "",
              },
        );
      }

      if (arguments_.slice(0, 3).join(" ") === "r2 bucket create") {
        buckets.add(arguments_[3] ?? "");
        return Promise.resolve(success("Created"));
      }

      if (arguments_.slice(0, 3).join(" ") === "r2 bucket delete") {
        buckets.delete(arguments_[3] ?? "");
        return Promise.resolve(success("Deleted"));
      }

      return runWrangler(arguments_, options);
    },
  };
}

function successfulReuseWrangler(events: string[] = []): RunWrangler {
  return async (arguments_) => {
    events.push(`wrangler:${arguments_[0] ?? "unknown"}`);

    if (arguments_[0] === "whoami") {
      return whoami();
    }
    if (arguments_[0] === "deployments") {
      return success("[]");
    }
    if (arguments_[0] === "secret") {
      return secretList(WORKER_SECRET_NAMES);
    }
    if (arguments_[0] === "containers") {
      return sandboxContainerList();
    }
    if (arguments_[0] === "d1" && arguments_[1] === "list") {
      return success(JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]));
    }
    if (arguments_[0] === "d1" && arguments_[1] === "execute") {
      return arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
        ? queryResult([
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
          ])
        : queryResult(AUTH_TABLES);
    }

    return success();
  };
}

function recoveryWrangler({
  bindings = [
    { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
    { name: "AI_GATEWAY_ID", text: OPTIONS.workerName, type: "plain_text" },
    {
      name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
      text: "a".repeat(64),
      type: "plain_text",
    },
    { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
  ],
  databaseName = "crewhelm-development-auth",
  events = [],
  tables = AUTH_TABLES,
  versions = [{ percentage: 100, version_id: DEPLOYMENT_VERSION_ID }],
  workerExports = {
    CrewAgent: { storage: "sqlite", type: "durable-object" },
    CrewSession: { storage: "sqlite", type: "durable-object" },
    CrewhelmSandbox: { storage: "sqlite", type: "durable-object" },
    OwnerControlPlane: { storage: "sqlite", type: "durable-object" },
  },
}: {
  bindings?: readonly Readonly<Record<string, unknown>>[];
  databaseName?: string;
  events?: string[];
  tables?: readonly string[];
  versions?: readonly Readonly<Record<string, unknown>>[];
  workerExports?: Readonly<Record<string, unknown>>;
} = {}): RunWrangler {
  return async (arguments_) => {
    events.push(arguments_.slice(0, 2).join(":"));

    if (arguments_[0] === "whoami") {
      return whoami();
    }
    if (arguments_[0] === "deployments") {
      return success(
        JSON.stringify([
          {
            id: "24f9520f-a92f-47e8-8c7d-6cbd14c89309",
            versions,
          },
        ]),
      );
    }
    if (arguments_[0] === "versions") {
      return success(
        JSON.stringify({
          id: DEPLOYMENT_VERSION_ID,
          resources: {
            bindings,
            script_runtime: {
              exports: workerExports,
            },
          },
        }),
      );
    }
    if (arguments_[0] === "secret") {
      return secretList(WORKER_SECRET_NAMES);
    }
    if (arguments_[0] === "containers") {
      return sandboxContainerList();
    }
    if (arguments_[0] === "d1" && arguments_[1] === "list") {
      return success(JSON.stringify([{ name: databaseName, uuid: DATABASE_ID }]));
    }
    if (arguments_[0] === "d1" && arguments_[1] === "execute") {
      return arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
        ? queryResult(EXPECTED_MIGRATIONS)
        : queryResult(tables);
    }

    return success();
  };
}

describe("Cloudflare bootstrap", () => {
  it("reads bounded migration and secret evidence for exact upgrade coordinates", async () => {
    const { assets, root } = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }
      if (arguments_[0] === "deployments") {
        return success("[]");
      }
      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        return queryResult(["0001_better_auth.sql", "0002_control_write_scope.sql"]);
      }
      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES.toReversed());
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });

    try {
      await expect(
        inspectInstallationInfrastructure(
          {
            accountId: ACCOUNT_ID,
            databaseId: DATABASE_ID,
            workerName: OPTIONS.workerName,
          },
          createDependencies(assets, runWrangler),
        ),
      ).resolves.toEqual({
        appliedMigrations: ["0001_better_auth.sql", "0002_control_write_scope.sql"],
        secretNames: [...WORKER_SECRET_NAMES].toSorted(),
      });
      expect(runWrangler.mock.calls.map(([arguments_]) => arguments_.slice(0, 2))).toEqual([
        ["whoami", "--json"],
        ["deployments", "list"],
        ["d1", "execute"],
        ["secret", "list"],
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("derives stable independent rate-limit namespaces per Worker", () => {
    const first = rateLimitNamespacesForWorker("crewhelm");
    const second = rateLimitNamespacesForWorker("crewhelm-smoke");

    expect(first).toEqual(rateLimitNamespacesForWorker("crewhelm"));
    expect(first.auth).not.toBe(first.mcp);
    expect(first.auth).not.toBe(first.composio);
    expect(first.mcp).not.toBe(first.composio);
    expect(second.auth).not.toBe(second.mcp);
    expect(second.auth).not.toBe(second.composio);
    expect(second.mcp).not.toBe(second.composio);
    expect(new Set([...Object.values(first), ...Object.values(second)]).size).toBe(6);
    expect(
      [...Object.values(first), ...Object.values(second)].every(
        (value) => /^[1-9][0-9]*$/u.test(value) && BigInt(value) <= 2_147_483_647n,
      ),
    ).toBe(true);
    expect(rateLimitNamespacesForWorker("crewhelm-smoke-l57")).not.toEqual(
      rateLimitNamespacesForWorker("crewhelm-smoke-14cb"),
    );
  });

  it("derives one stable R2 Skill bucket per Worker", () => {
    const longWorkerName = `crewhelm-${"a".repeat(54)}`;

    expect(skillBucketNameForWorker("crewhelm")).toBe("crewhelm-skills");
    expect(skillBucketNameForWorker(longWorkerName)).toBe(skillBucketNameForWorker(longWorkerName));
    expect(skillBucketNameForWorker(longWorkerName)).toMatch(/^[a-z0-9-]{3,63}$/u);
    expect(skillBucketNameForWorker(longWorkerName)).not.toBe(
      skillBucketNameForWorker(`crewhelm-${"b".repeat(54)}`),
    );
  });

  it("rejects Recipe Registry overrides outside the exact testing installation", async () => {
    const runWrangler = vi.fn<RunWrangler>();
    const dependencies = createDependencies("unused", runWrangler);
    const recipeRegistryOrigin = "https://crewhelm-registry-dev.fkrein.workers.dev/";

    await expect(
      bootstrapDeployment({ ...REUSE_OPTIONS, recipeRegistryOrigin }, dependencies),
    ).rejects.toMatchObject({ stage: "configuration" });
    await expect(
      bootstrapDeployment(
        {
          ...REUSE_OPTIONS,
          recipeRegistryOrigin,
          testingInstallation: true,
        },
        dependencies,
      ),
    ).rejects.toMatchObject({ stage: "configuration" });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it("recovers an existing installation before any deployment mutation", async () => {
    const fixture = await createDeploymentAssets();
    const databaseName = "crewhelm-development-auth";
    const events: string[] = [];
    const progress: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          databaseName,
          events,
          workerExports: {
            CrewAgent: { storage: "sqlite", type: "durable-object" },
            OwnerControlPlane: { storage: "sqlite", type: "durable-object" },
          },
        }),
      ),
      reportProgress: ({ stage }: BootstrapProgress) => progress.push(stage),
      recoverExistingInstallation: { persist },
    };

    try {
      const report = await bootstrapDeployment(OPTIONS, dependencies);

      expect(report.database).toMatchObject({
        action: "reused",
        id: DATABASE_ID,
        name: databaseName,
      });
      expect(report.aiGateway).toEqual({ enabled: true, id: "crewhelm" });
      expect(persist).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        aiGatewayId: "crewhelm",
        databaseId: DATABASE_ID,
        databaseName,
        origin: OPTIONS.origin.origin,
        workerName: OPTIONS.workerName,
      });
      expect(events).not.toContain("d1:create");
      expect(events.indexOf("versions:view")).toBeLessThan(events.indexOf("d1:migrations"));
      expect(events.indexOf("d1:execute")).toBeLessThan(events.indexOf("d1:migrations"));
      expect(progress).toEqual([
        "assets",
        "authentication",
        "worker",
        "database",
        "storage",
        "configuration",
        "migrations",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
        "deployment",
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("recovers and preserves an existing paid Sandbox binding", async () => {
    const fixture = await createDeploymentAssets();
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          bindings: [
            { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
            { name: "AI_GATEWAY_ID", text: OPTIONS.workerName, type: "plain_text" },
            {
              name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
              text: "a".repeat(64),
              type: "plain_text",
            },
            { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
            { name: "CODE_SANDBOX", type: "durable_object_namespace" },
          ],
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).resolves.toMatchObject({ ok: true });
      expect(persist).toHaveBeenCalledWith(expect.objectContaining({ sandboxEnabled: true }));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("honors an explicit Sandbox opt-out while recovering an existing installation", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    let stagedConfig: Record<string, unknown> | undefined;
    const baseRunner = recoveryWrangler({
      bindings: [
        { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
        {
          name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
          text: "a".repeat(64),
          type: "plain_text",
        },
        { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
        { name: "CODE_SANDBOX", type: "durable_object_namespace" },
      ],
      events,
    });
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deploy") {
        const configPath = arguments_[arguments_.indexOf("--config") + 1];
        if (configPath) stagedConfig = JSON.parse(await readFile(configPath, "utf8"));
      }
      return baseRunner(arguments_, options);
    };
    const dependencies = {
      ...createDependencies(fixture.assets, runWrangler),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, sandboxEnabled: false }, dependencies),
      ).resolves.toMatchObject({ ok: true });
      expect(persist).toHaveBeenCalled();
      expect(
        persist.mock.calls.every(([installation]) => !Reflect.has(installation!, "sandboxEnabled")),
      ).toBe(true);
      expect(events).not.toContain("containers:list");
      expect(stagedConfig).not.toHaveProperty("containers");
      expect(stagedConfig).toHaveProperty("exports.CrewhelmSandbox", {
        storage: "sqlite",
        type: "durable-object",
      });
      expect(stagedConfig).not.toHaveProperty(
        "durable_objects.bindings",
        expect.arrayContaining([expect.objectContaining({ name: "CODE_SANDBOX" })]),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not persist requested Sandbox activation when recovered plan access is denied", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const baseRunner = recoveryWrangler({
      bindings: [
        { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
        {
          name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
          text: "a".repeat(64),
          type: "plain_text",
        },
        { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
        { bucket_name: "crewhelm-skills", name: "SKILL_PACKAGES", type: "r2_bucket" },
      ],
      events,
    });
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "containers") {
        events.push("containers:list");
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "Unauthorized",
          stdout: "",
        };
      }
      return baseRunner(arguments_, options);
    };
    const dependencies = {
      ...createDependencies(fixture.assets, runWrangler),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, sandboxEnabled: true }, dependencies),
      ).rejects.toMatchObject({
        message:
          "Sandbox code requires Cloudflare Workers Paid and Containers access. Upgrade the account or rerun with --no-sandbox; the core installation was not changed.",
        stage: "configuration",
      });
      expect(persist).toHaveBeenCalled();
      expect(
        persist.mock.calls.every(([installation]) => !Reflect.has(installation!, "sandboxEnabled")),
      ).toBe(true);
      expect(events).toContain("containers:list");
      expect(events.some((event) => event.startsWith("deploy:"))).toBe(false);
      expect(events).not.toContain("d1:migrations");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails closed before mutation when an existing Worker has split traffic", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          events,
          versions: [
            { percentage: 50, version_id: DEPLOYMENT_VERSION_ID },
            {
              percentage: 50,
              version_id: "5263bddc-9b96-45ff-8053-38bd0fdb0bf9",
            },
          ],
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Existing Worker has no single active version that can be adopted safely.",
        stage: "worker",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).toEqual(["whoami:--json", "deployments:list"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects ambiguous Worker bindings before D1 mutation", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          bindings: [
            { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
            { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
            { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
          ],
          events,
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Active Worker version contains ambiguous bindings.",
        stage: "worker",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).toEqual(["whoami:--json", "deployments:list", "versions:view"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects a conflicting Skill package binding before D1 mutation", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          bindings: [
            { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
            { bucket_name: "another-fleet-skills", name: "SKILL_PACKAGES", type: "r2_bucket" },
            { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
          ],
          events,
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Existing Worker has an invalid SKILL_PACKAGES binding.",
        stage: "worker",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).toEqual(["whoami:--json", "deployments:list", "versions:view"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not adopt an occupied Skill bucket from a legacy Worker", async () => {
    const fixture = await createDeploymentAssets();
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(fixture.assets, recoveryWrangler(), {}, ["crewhelm-skills"]),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Existing R2 Skill package storage is not bound to this Worker.",
        stage: "storage",
      });
      expect(persist).toHaveBeenCalledOnce();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an explicit D1 name that conflicts with the Worker binding", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(fixture.assets, recoveryWrangler({ events })),
      recoverExistingInstallation: {
        expectedDatabaseName: OPTIONS.databaseName,
        persist,
      },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "The requested D1 database name conflicts with the existing Worker binding.",
        stage: "configuration",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).not.toContain("d1:create");
      expect(events).not.toContain("d1:migrations");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("recovers an installation without inventing an AI Gateway binding", async () => {
    const fixture = await createDeploymentAssets();
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          bindings: [
            { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
            { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
          ],
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      const report = await bootstrapDeployment(OPTIONS, dependencies);

      expect(report.aiGateway).toEqual({ enabled: false });
      expect(persist).toHaveBeenCalledWith(
        expect.not.objectContaining({ aiGatewayId: expect.anything() }),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops before deployment mutation when recovered metadata cannot be persisted", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const dependencies = {
      ...createDependencies(fixture.assets, recoveryWrangler({ events })),
      recoverExistingInstallation: {
        persist: vi.fn<(installation: unknown) => Promise<void>>(async () => {
          throw new Error("private local detail");
        }),
      },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message:
          "Existing installation was verified, but local installation metadata could not be saved.",
        stage: "configuration",
      });
      expect(events).not.toContain("d1:create");
      expect(events).not.toContain("d1:migrations");
      expect(events).not.toContain("deploy:--config");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not adopt an empty D1 database as an existing installation", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(fixture.assets, recoveryWrangler({ events, tables: [] })),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Existing Worker D1 database has no Crewhelm provenance.",
        stage: "database",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).not.toContain("d1:migrations");
      expect(events).not.toContain("deploy:--config");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not adopt Durable Object namespaces that are mid-transfer", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const dependencies = {
      ...createDependencies(
        fixture.assets,
        recoveryWrangler({
          events,
          workerExports: {
            CrewAgent: {
              state: "expecting-transfer",
              storage: "sqlite",
              transfer_from: "another-worker",
              type: "durable-object",
            },
            CrewSession: {
              state: "created",
              storage: "sqlite",
              type: "durable-object",
            },
            OwnerControlPlane: {
              state: "created",
              storage: "sqlite",
              type: "durable-object",
            },
          },
        }),
      ),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Active Worker version returned an invalid response.",
        stage: "worker",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).toEqual(["whoami:--json", "deployments:list", "versions:view"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops when the active Worker version changes during recovery", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const persist = vi.fn<(installation: unknown) => Promise<void>>(async () => {});
    const baseRunner = recoveryWrangler({ events });
    let inventoryReads = 0;
    const dependencies = {
      ...createDependencies(fixture.assets, async (arguments_, options) => {
        if (arguments_[0] === "deployments" && ++inventoryReads === 2) {
          events.push("deployments:list");
          return success(
            JSON.stringify([
              {
                id: "881c0379-d3c4-4afb-b9d9-e2971cc4c0b5",
                versions: [
                  {
                    percentage: 100,
                    version_id: "5263bddc-9b96-45ff-8053-38bd0fdb0bf9",
                  },
                ],
              },
            ]),
          );
        }

        return baseRunner(arguments_, options);
      }),
      recoverExistingInstallation: { persist },
    };

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Existing Worker changed while its installation was recovered.",
        stage: "worker",
      });
      expect(persist).not.toHaveBeenCalled();
      expect(events).not.toContain("d1:migrations");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an unreferenced Worker text module", async () => {
    const fixture = await createDeploymentAssets();
    const unreferencedModule = "1111111111111111111111111111111111111111-0001_extra.sql";
    const runWrangler = vi.fn<RunWrangler>();

    try {
      await writeFile(resolve(fixture.assets, unreferencedModule), "SELECT 1;\n");
      await expect(
        bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).rejects.toMatchObject({
        message: "Packaged deployment assets are invalid.",
        name: "BootstrapError",
        stage: "assets",
      });
      expect(runWrangler).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses to replace a Worker that requires a newer deployment protocol", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>();
    const dependencies = createDependencies(fixture.assets, runWrangler);
    const normalFetch = dependencies.fetch;
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === "/health") {
          return Response.json({
            deployment: {
              fingerprint: "b".repeat(64),
              futureDeploymentField: true,
              protocolVersion: 2,
            },
            futureHealthField: true,
            service: "crewhelm",
            status: "ok",
          });
        }

        return normalFetch(input, init);
      });

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).rejects.toMatchObject({
        message: "The installed Worker requires a newer Crewhelm CLI. The Worker was not changed.",
        name: "BootstrapError",
        stage: "deployment",
      });
      expect(runWrangler).not.toHaveBeenCalled();
      expect(dependencies.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an invalid scoped Gateway token before inventory or D1 mutation", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      throw new Error("Inventory and D1 mutation must not run with an invalid Gateway token.");
    });

    try {
      await expect(
        bootstrapDeployment(
          { ...REUSE_OPTIONS, aiDailySpendUsd: 5 },
          createDependencies(fixture.assets, runWrangler, {
            CREWHELM_CLOUDFLARE_API_TOKEN: "short",
          }),
        ),
      ).rejects.toMatchObject({
        message:
          "Set CREWHELM_CLOUDFLARE_API_TOKEN to a valid account API token with AI Gateway Edit.",
        name: "BootstrapError",
        stage: "gateway",
      });
      expect(runWrangler).toHaveBeenCalledTimes(1);
      expect(runWrangler.mock.calls[0]?.[0][0]).toBe("whoami");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("updates an explicit Gateway limit before credential provisioning and verifies read-back", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler(events));
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    let gatewayLimit = 1;

    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      const method = init?.method ?? "GET";
      events.push(`gateway:${method}`);

      if (method === "PUT") {
        if (typeof init?.body !== "string") {
          throw new Error("Expected serialized Gateway update body.");
        }
        const body = z
          .looseObject({
            spend_limits: z.looseObject({
              rules: z.array(z.looseObject({ limit: z.number() })).min(1),
            }),
          })
          .parse(JSON.parse(init.body));
        gatewayLimit = body.spend_limits?.rules?.[0]?.limit ?? gatewayLimit;
      }

      return Response.json(gatewayPayload(gatewayLimit));
    });

    try {
      const report = await bootstrapDeployment(
        { ...REUSE_OPTIONS, aiDailySpendUsd: 5 },
        dependencies,
      );

      expect(report.aiGateway).toEqual({ enabled: true, id: OPTIONS.workerName });
      expect(events.filter((event) => event.startsWith("gateway:"))).toEqual([
        "gateway:GET",
        "gateway:PUT",
        "gateway:GET",
      ]);
      expect(events.indexOf("gateway:PUT")).toBeGreaterThan(events.indexOf("wrangler:d1"));
      expect(events.indexOf("gateway:PUT")).toBeLessThan(events.indexOf("wrangler:deploy"));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("configures a fresh Gateway after Cloudflare creates it without the requested spend limit", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    const createdResources: unknown[] = [];
    const gatewayMethods: string[] = [];
    let created = false;
    let configured = false;

    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      const method = init?.method ?? "GET";
      gatewayMethods.push(method);

      if (method === "POST") {
        created = true;
        return Response.json({
          result: { id: OPTIONS.workerName, spend_limits: null },
          success: true,
        });
      }

      if (method === "PUT") {
        configured = true;
      }

      if (!created) {
        return new Response(null, { status: 404 });
      }

      return Response.json(
        configured
          ? gatewayPayload(1)
          : { result: { id: OPTIONS.workerName, spend_limits: null }, success: true },
      );
    });
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...REUSE_OPTIONS, aiDailySpendUsd: 1 }, dependencies),
      ).resolves.toMatchObject({
        aiGateway: { enabled: true, id: OPTIONS.workerName },
      });
      expect(gatewayMethods).toEqual(["GET", "GET", "POST", "PUT", "GET"]);
      expect(createdResources).toEqual([
        { accountId: ACCOUNT_ID, kind: "bucket", name: "crewhelm-skills" },
        { accountId: ACCOUNT_ID, id: OPTIONS.workerName, kind: "gateway" },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("recovers and records an unconfigured Gateway after an ambiguous create response", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    const createdResources: unknown[] = [];
    const gatewayMethods: string[] = [];
    let created = false;
    let configured = false;

    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      const method = init?.method ?? "GET";
      gatewayMethods.push(method);

      if (method === "POST") {
        created = true;
        throw new Error("Injected ambiguous create response.");
      }

      if (method === "PUT") {
        configured = true;
      }

      if (!created) {
        return new Response(null, { status: 404 });
      }

      return Response.json(
        configured
          ? gatewayPayload(1)
          : { result: { id: OPTIONS.workerName, spend_limits: null }, success: true },
      );
    });
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...REUSE_OPTIONS, aiDailySpendUsd: 1 }, dependencies),
      ).resolves.toMatchObject({
        aiGateway: { enabled: true, id: OPTIONS.workerName },
      });
      expect(gatewayMethods).toEqual(["GET", "GET", "POST", "GET", "PUT", "GET"]);
      expect(createdResources).toEqual([
        { accountId: ACCOUNT_ID, kind: "bucket", name: "crewhelm-skills" },
        { accountId: ACCOUNT_ID, id: OPTIONS.workerName, kind: "gateway" },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requests scoped Cloudflare authorization and retries Gateway management", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    const requestCloudflareGatewayAuthorization = vi.fn<
      NonNullable<BootstrapDependencies["requestCloudflareGatewayAuthorization"]>
    >(
      async () =>
        ({
          action: "token",
          token: "scoped-gateway-token-value",
        }) as const,
    );

    dependencies.requestCloudflareGatewayAuthorization = requestCloudflareGatewayAuthorization;
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      const authorization = new Headers(init?.headers).get("authorization");

      return authorization === "Bearer test-token"
        ? Response.json({ result: null, success: false }, { status: 403 })
        : Response.json(gatewayPayload(5));
    });

    try {
      const report = await bootstrapDeployment(
        { ...REUSE_OPTIONS, aiDailySpendUsd: 5 },
        dependencies,
      );

      expect(report.aiGateway).toEqual({ enabled: true, id: OPTIONS.workerName });
      expect(requestCloudflareGatewayAuthorization).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        canSkip: true,
        dailySpendUsd: 5,
        workerName: OPTIONS.workerName,
      });
      expect(JSON.stringify(report)).not.toContain("scoped-gateway-token-value");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("continues an installation without Gateway when scoped authorization is skipped", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));

    dependencies.requestCloudflareGatewayAuthorization = vi.fn<
      NonNullable<BootstrapDependencies["requestCloudflareGatewayAuthorization"]>
    >(async () => ({ action: "skip" as const }));
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname === "api.cloudflare.com") {
        return Response.json({ result: null, success: false }, { status: 403 });
      }

      return deploymentFetch(input, init);
    });

    try {
      const report = await bootstrapDeployment(
        { ...REUSE_OPTIONS, aiDailySpendUsd: 5 },
        dependencies,
      );

      expect(report.aiGateway).toEqual({ enabled: false });
      expect(dependencies.requestCloudflareGatewayAuthorization).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        canSkip: true,
        dailySpendUsd: 5,
        workerName: OPTIONS.workerName,
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops Gateway recovery before infrastructure mutation", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(successfulReuseWrangler());
    const dependencies = createDependencies(fixture.assets, runWrangler);
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));

    dependencies.requestCloudflareGatewayAuthorization = vi.fn<
      NonNullable<BootstrapDependencies["requestCloudflareGatewayAuthorization"]>
    >(async () => ({ action: "stop" as const }));
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      return url.hostname === "api.cloudflare.com"
        ? Response.json({ result: null, success: false }, { status: 403 })
        : deploymentFetch(input, init);
    });

    try {
      await expect(
        bootstrapDeployment({ ...REUSE_OPTIONS, aiDailySpendUsd: 5 }, dependencies),
      ).rejects.toMatchObject({
        message: "AI Gateway setup stopped before infrastructure was changed.",
        stage: "gateway",
      });
      expect(
        runWrangler.mock.calls.some(
          ([arguments_]) =>
            arguments_[0] === "deploy" ||
            (arguments_[0] === "d1" &&
              (arguments_[1] === "create" ||
                arguments_[1] === "execute" ||
                arguments_[1] === "migrations")),
        ),
      ).toBe(false);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not inspect or configure AI Gateway when setup skips it", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler(events));
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));

    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      return url.hostname === "api.cloudflare.com"
        ? Response.json({ result: { id: OPTIONS.workerName }, success: true })
        : deploymentFetch(input, init);
    });

    try {
      const report = await bootstrapDeployment(REUSE_OPTIONS, dependencies);
      const gatewayRequests = vi.mocked(dependencies.fetch).mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.hostname === "api.cloudflare.com";
      });

      expect(report.aiGateway).toEqual({ enabled: false });
      expect(gatewayRequests).toHaveLength(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps paid Sandbox infrastructure out of the default deployment", async () => {
    const fixture = await createDeploymentAssets();
    const baseRunner = successfulReuseWrangler();
    let stagedConfig: Record<string, unknown> | undefined;
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deploy") {
        const configIndex = arguments_.indexOf("--config");
        const configPath = configIndex === -1 ? undefined : arguments_[configIndex + 1];
        if (configPath) stagedConfig = JSON.parse(await readFile(configPath, "utf8"));
      }
      return baseRunner(arguments_, options);
    };

    try {
      await expect(
        bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).resolves.toMatchObject({ ok: true });
      expect(stagedConfig).toBeDefined();
      expect(stagedConfig).not.toHaveProperty("containers");
      expect(stagedConfig).toHaveProperty("exports.CrewhelmSandbox", {
        storage: "sqlite",
        type: "durable-object",
      });
      expect(stagedConfig).not.toHaveProperty(
        "durable_objects.bindings",
        expect.arrayContaining([expect.objectContaining({ name: "CODE_SANDBOX" })]),
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses to adopt an existing Worker for a fresh installation", async () => {
    const fixture = await createDeploymentAssets();

    try {
      await expect(
        bootstrapDeployment(
          { ...OPTIONS, requireFresh: true },
          createDependencies(fixture.assets, successfulReuseWrangler()),
        ),
      ).rejects.toMatchObject({
        message: "Fresh installation requires an unused Worker name.",
        stage: "worker",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops before D1 mutation when an existing Worker is missing a required secret", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES_WITHOUT_COMPOSIO);
      }

      throw new Error("D1 mutation must not run with an incomplete Worker secret set.");
    });

    try {
      await expect(
        bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).rejects.toMatchObject({
        message:
          "Existing Worker is missing required secret: COMPOSIO_API_KEY. Set CREWHELM_COMPOSIO_API_KEY before retrying.",
        name: "BootstrapError",
        stage: "configuration",
      });
      expect(
        runWrangler.mock.calls.find(([arguments_]) => arguments_[0] === "secret")?.[0],
      ).toEqual([
        "secret",
        "list",
        "--name",
        OPTIONS.workerName,
        "--format",
        "json",
        "--config",
        expect.stringMatching(/account\.json$/u),
      ]);
      expect(runWrangler.mock.calls.some(([arguments_]) => arguments_[0] === "d1")).toBe(false);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("counts a supplied secret toward an existing Worker's pending secret set", async () => {
    const fixture = await createDeploymentAssets();
    const suppliedComposioKey = "replacement-composio-key";
    let uploadedSecrets: Record<string, string> | undefined;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES_WITHOUT_COMPOSIO);
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return success(JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]));
      }

      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        return arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
          ? queryResult([
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
            ])
          : queryResult(AUTH_TABLES);
      }

      if (arguments_[0] === "deploy") {
        const secretsIndex = arguments_.indexOf("--secrets-file");
        const secretsPath = secretsIndex === -1 ? undefined : arguments_[secretsIndex + 1];

        if (!secretsPath) {
          throw new Error("Expected replacement secret file.");
        }

        uploadedSecrets = z
          .record(z.string(), z.string())
          .parse(JSON.parse(await readFile(secretsPath, "utf8")));
      }

      return success();
    });

    try {
      const report = await bootstrapDeployment(
        REUSE_OPTIONS,
        createDependencies(fixture.assets, runWrangler, {
          CREWHELM_COMPOSIO_API_KEY: suppliedComposioKey,
        }),
      );

      expect(report.ok).toBe(true);
      expect(uploadedSecrets).toEqual({ COMPOSIO_API_KEY: suppliedComposioKey });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops before D1 mutation when Worker secret inventory is malformed", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return success(JSON.stringify([{ type: "secret_text" }]));
      }

      throw new Error("D1 mutation must not run after malformed Worker inventory.");
    });

    try {
      await expect(
        bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).rejects.toMatchObject({
        message: "Worker secret inventory returned an invalid response.",
        name: "BootstrapError",
        stage: "worker",
      });
      expect(runWrangler.mock.calls.some(([arguments_]) => arguments_[0] === "d1")).toBe(false);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops before D1 mutation when Worker secret inventory has an unknown outcome", async () => {
    const fixture = await createDeploymentAssets();
    const providerOutput = "provider-secret-like-output";
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return {
          exitCode: 1,
          outcome: "unknown",
          stderr: providerOutput,
          stdout: providerOutput,
        };
      }

      throw new Error("D1 mutation must not run after unknown Worker inventory.");
    });

    try {
      let failure: unknown;

      try {
        await bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler));
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        message: "Worker secret inventory outcome could not be confirmed.",
        name: "BootstrapError",
        stage: "worker",
      });
      expect(String(failure)).not.toContain(providerOutput);
      expect(
        runWrangler.mock.calls.some(
          ([arguments_]) => arguments_[0] === "d1" || arguments_[0] === "deploy",
        ),
      ).toBe(false);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("waits for the expected Worker fingerprint to reach the public edge", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const normalFetch = dependencies.fetch;
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});
    const progress: BootstrapProgress[] = [];
    let healthReads = 0;
    dependencies.wait = wait;
    dependencies.reportProgress = (event) => progress.push(event);
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === "/health" && ++healthReads >= 2 && healthReads <= 7) {
          return Response.json({
            deployment: { fingerprint: "b".repeat(64), protocolVersion: 1 },
            service: "crewhelm",
            status: "ok",
          });
        }

        return normalFetch(input, init);
      });

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).resolves.toMatchObject({
        deployment: { action: "updated" },
        ok: true,
      });
      expect(healthReads).toBe(10);
      expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000,
      ]);
      expect(
        progress
          .filter(({ message }) => message.startsWith("Checking the deployed control plane"))
          .map(({ message }) => message),
      ).toEqual([
        "Checking the deployed control plane (attempt 1 of 16)",
        "Checking the deployed control plane (attempt 2 of 16)",
        "Checking the deployed control plane (attempt 3 of 16)",
        "Checking the deployed control plane (attempt 4 of 16)",
        "Checking the deployed control plane (attempt 5 of 16)",
        "Checking the deployed control plane (attempt 6 of 16)",
        "Checking the deployed control plane (attempt 7 of 16)",
        "Checking the deployed control plane (attempt 8 of 16)",
        "Checking the deployed control plane (attempt 9 of 16)",
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("tolerates delayed edge propagation before requiring a stable fingerprint", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const normalFetch = dependencies.fetch;
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});
    let healthReads = 0;
    dependencies.wait = wait;
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === "/health" && ++healthReads >= 2 && healthReads <= 14) {
          return Response.json({
            deployment: { fingerprint: "b".repeat(64), protocolVersion: 1 },
            service: "crewhelm",
            status: "ok",
          });
        }

        return normalFetch(input, init);
      });

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).resolves.toMatchObject({
        deployment: { action: "updated" },
        ok: true,
      });
      expect(healthReads).toBe(17);
      expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
        30_000, 5_000, 5_000,
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("reports recoverable fingerprint details when edge verification expires", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const normalFetch = dependencies.fetch;
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});
    const staleFingerprint = "b".repeat(64);
    let healthReads = 0;
    dependencies.wait = wait;
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === "/health" && ++healthReads >= 2) {
          return Response.json({
            deployment: { fingerprint: staleFingerprint, protocolVersion: 1 },
            service: "crewhelm",
            status: "ok",
          });
        }

        return normalFetch(input, init);
      });

    try {
      let failure: unknown;

      try {
        await bootstrapDeployment(REUSE_OPTIONS, dependencies);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ name: "BootstrapError", stage: "deployment" });
      expect(String(failure)).toContain(
        `Expected fingerprint ${deploymentFingerprints.get(fixture.assets)}`,
      );
      expect(String(failure)).toContain(
        `last observed fingerprint ${staleFingerprint} (protocol 1)`,
      );
      expect(String(failure)).toContain(
        "rerun crewhelm up to continue verification without recreating existing resources",
      );
      expect(healthReads).toBe(17);
      expect(wait).toHaveBeenCalledTimes(15);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("distinguishes aligned fingerprints from failing public diagnostics", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const normalFetch = dependencies.fetch;
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});
    let protectedResourceReads = 0;
    dependencies.wait = wait;
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (
          url.pathname === "/.well-known/oauth-protected-resource" &&
          ++protectedResourceReads >= 2
        ) {
          return Response.json({}, { status: 503 });
        }

        return normalFetch(input, init);
      });

    try {
      let failure: unknown;

      try {
        await bootstrapDeployment(REUSE_OPTIONS, dependencies);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ name: "BootstrapError", stage: "deployment" });
      expect(String(failure)).toContain("packaged fingerprint is aligned");
      expect(String(failure)).toContain("mcp-protected-resource (http_status)");
      expect(String(failure)).toContain("Run crewhelm doctor for details");
      expect(String(failure)).not.toContain("Cloudflare may still be propagating");
      expect(wait).toHaveBeenCalledTimes(15);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires a stable Worker fingerprint after mixed edge responses", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());
    const normalFetch = dependencies.fetch;
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => {});
    let healthReads = 0;
    dependencies.wait = wait;
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);

        if (url.pathname === "/health" && ++healthReads === 4) {
          return Response.json({
            deployment: { fingerprint: "b".repeat(64), protocolVersion: 1 },
            service: "crewhelm",
            status: "ok",
          });
        }

        return normalFetch(input, init);
      });

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).resolves.toMatchObject({
        deployment: { action: "updated" },
        ok: true,
      });
      expect(healthReads).toBe(10);
      expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        1_000, 1_000, 1_000, 1_000, 1_000, 2_000, 4_000, 8_000,
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("reuses existing resources without requiring or replacing secrets", async () => {
    const fixture = await createDeploymentAssets();
    const workerName = "crewhelm-testing";
    let stagedDirectory: string | undefined;
    let stagedConfig: z.infer<typeof stagedConfigSchema> | undefined;
    let stagedTextModule = false;
    let deployArguments: readonly string[] | undefined;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES);
      }

      if (arguments_[0] === "containers") {
        return sandboxContainerList("ready", `${workerName}-crewhelmsandbox`);
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return success(JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]));
      }

      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        return arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
          ? queryResult([
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
            ])
          : queryResult(AUTH_TABLES);
      }

      const configIndex = arguments_.indexOf("--config");
      const configPath = configIndex === -1 ? undefined : arguments_[configIndex + 1];

      if (!configPath) {
        throw new Error("Expected staged config.");
      }

      stagedDirectory = resolve(configPath, "..");
      stagedConfig = stagedConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));

      if (arguments_[0] === "deploy") {
        deployArguments = arguments_;
        await access(resolve(stagedDirectory, WORKER_TEXT_MODULE));
        stagedTextModule = true;
      }

      return success();
    });

    try {
      const cloudflareApiToken = "cloudflare-api-token-value-0123456789";
      const dependencies = createDependencies(fixture.assets, runWrangler, {
        CREWHELM_CLOUDFLARE_API_TOKEN: cloudflareApiToken,
      });
      const allWranglerCalls = vi.fn<RunWrangler>(dependencies.runWrangler);
      dependencies.runWrangler = allWranglerCalls;
      const report = await bootstrapDeployment(
        { ...REUSE_OPTIONS, sandboxEnabled: true, workerName },
        dependencies,
      );

      expect(report.ok).toBe(true);
      expect(report.aiGateway).toEqual({ enabled: false });
      expect(report.features.sandboxCode).toEqual({
        enabled: true,
        requirement: "Cloudflare Workers Paid",
        setupCommand: "crewhelm up --sandbox",
      });
      expect(JSON.stringify(report)).not.toContain(HOSTILE_ACCOUNT_NAME);
      expect(JSON.stringify(report)).not.toContain("test-token");
      expect(JSON.stringify(report)).not.toContain(cloudflareApiToken);
      expect(report.database.action).toBe("reused");
      expect(report.deployment.action).toBe("updated");
      expect(stagedConfig?.account_id).toBe(ACCOUNT_ID);
      expect(stagedConfig?.ai.binding).toBe("AI");
      expect(stagedConfig?.d1_databases[0].database_id).toBe(DATABASE_ID);
      expect(stagedConfig?.durable_objects.bindings).toEqual([
        { class_name: "OwnerControlPlane", name: "OWNER_CONTROL_PLANE" },
        { class_name: "CrewAgent", name: "CREW_AGENT" },
        { class_name: "CrewSession", name: "CREW_SESSION" },
        { class_name: "CrewhelmSandbox", name: "CODE_SANDBOX" },
      ]);
      expect(stagedConfig?.containers).toEqual([
        {
          class_name: "CrewhelmSandbox",
          image: "docker.io/cloudflare/sandbox:0.12.4-python",
          instance_type: "lite",
          max_instances: 5,
          name: "crewhelm-testing-crewhelmsandbox",
        },
      ]);
      expect(stagedConfig?.workflows).toEqual([
        {
          binding: "AGENT_TASK_WORKFLOW",
          class_name: "AgentTaskWorkflow",
          name: "crewhelm-testing-agent-task-workflow",
        },
      ]);
      expect(stagedConfig?.observability.logs.invocation_logs).toBe(false);
      expect(stagedConfig?.observability.traces.enabled).toBe(false);
      expect(stagedConfig?.ratelimits.map(({ namespace_id }) => namespace_id)).toEqual(
        Object.values(rateLimitNamespacesForWorker(workerName)),
      );
      expect(stagedConfig?.rules).toEqual([
        { fallthrough: true, globs: ["**/*.sql"], type: "Text" },
      ]);
      expect(stagedTextModule).toBe(true);
      expect(stagedConfig?.secrets.required).toEqual([
        "BETTER_AUTH_SECRET",
        "COMPOSIO_API_KEY",
        "GITHUB_CLIENT_ID",
        "GITHUB_CLIENT_SECRET",
        "OWNER_GITHUB_USER_ID",
      ]);
      expect(stagedConfig?.vars.PUBLIC_ORIGIN).toBe(OPTIONS.origin.origin);
      expect(stagedConfig?.services).toBeUndefined();
      expect(stagedConfig?.vars.CREWHELM_DEPLOYMENT_FINGERPRINT).toBe(
        deploymentFingerprints.get(fixture.assets),
      );
      expect(stagedConfig?.vars.AI_GATEWAY_DAILY_LIMIT_MICROUSD).toBeUndefined();
      expect(stagedConfig?.vars.AI_GATEWAY_ID).toBeUndefined();
      expect(deployArguments).not.toContain("--secrets-file");
      expect(deployArguments).toContain("--strict");
      expect(allWranglerCalls.mock.calls.some(([arguments_]) => arguments_[0] === "auth")).toBe(
        false,
      );
      const gatewayRequests = vi.mocked(dependencies.fetch).mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.hostname === "api.cloudflare.com";
      });

      expect(gatewayRequests).toHaveLength(0);
      expect(
        runWrangler.mock.calls.every(([, runOptions]) => runOptions?.cwd === stagedDirectory),
      ).toBe(true);
      expect(
        runWrangler.mock.calls
          .filter(([arguments_]) => arguments_[0] !== "whoami")
          .every(([arguments_]) => arguments_.includes("--config")),
      ).toBe(true);
      expect(stagedDirectory).toBeDefined();
      await expect(access(stagedDirectory!)).rejects.toThrow("ENOENT");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("skips an identical Worker upload on a repeat upgrade", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const baseRunner = successfulReuseWrangler(events);
    let deploymentMessage: string | undefined;
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deployments") {
        events.push("wrangler:deployments");
        return success(
          deploymentMessage
            ? JSON.stringify([
                {
                  annotations: { "workers/message": "Automatic deployment on upload." },
                  id: "1e12da6f-e0f5-4989-8bea-6efbe8fc5811",
                },
                {
                  annotations: { "workers/message": deploymentMessage },
                  id: "31a2e99c-0bd4-46e0-9cbb-e9e9f0178024",
                },
              ])
            : "[]",
        );
      }

      if (arguments_[0] === "deploy") {
        events.push("wrangler:deploy");
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        return success("");
      }

      return baseRunner(arguments_, options);
    };
    const dependencies = createDependencies(fixture.assets, runWrangler);

    try {
      const first = await bootstrapDeployment(REUSE_OPTIONS, dependencies);
      dependencies.expectedSkillBucketName = skillBucketNameForWorker(REUSE_OPTIONS.workerName);
      const second = await bootstrapDeployment(REUSE_OPTIONS, dependencies);

      expect(first.deployment.action).toBe("updated");
      expect(second.deployment.action).toBe("unchanged");
      expect(second.features.sandboxCode.enabled).toBe(false);
      expect(events.filter((event) => event === "wrangler:deploy")).toHaveLength(1);
      expect(events.filter((event) => event === "wrangler:triggers")).toHaveLength(1);
      expect(events).not.toContain("wrangler:containers");
      expect(deploymentMessage).toMatch(/^Crewhelm [a-f0-9]{40}$/);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails before mutation when optional Sandbox plan access is unavailable", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const runWrangler: RunWrangler = async (arguments_) => {
      events.push(arguments_.slice(0, 2).join(":"));

      if (arguments_[0] === "whoami") return whoami();
      if (arguments_[0] === "deployments") return success("[]");
      if (arguments_[0] === "containers") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "Unauthorized",
          stdout: "",
        };
      }

      throw new Error(`Unexpected mutation: ${arguments_.join(" ")}`);
    };

    try {
      await expect(
        bootstrapDeployment(
          { ...REUSE_OPTIONS, sandboxEnabled: true },
          createDependencies(fixture.assets, runWrangler),
        ),
      ).rejects.toMatchObject({
        message:
          "Sandbox code requires Cloudflare Workers Paid and Containers access. Upgrade the account or rerun with --no-sandbox; the core installation was not changed.",
        stage: "configuration",
      });
      expect(events).toEqual(["whoami:--json", "deployments:list", "containers:list"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("finds an existing Sandbox application beyond Wrangler's first JSON page", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const baseRunner = successfulReuseWrangler(events);
    const firstPage = Array.from({ length: 25 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      image: "example.invalid/other:1",
      name: `other-application-${index}`,
      state: "ready",
    }));
    const runWrangler: RunWrangler = async (arguments_, options) =>
      arguments_[0] === "containers"
        ? success(JSON.stringify(firstPage))
        : baseRunner(arguments_, options);
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_CLOUDFLARE_API_TOKEN: "cloudflare-api-token-value-0123456789",
    });
    const deploymentFetch = dependencies.fetch;
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname.endsWith("/containers/dash/applications")) {
        return Response.json({
          result:
            url.searchParams.get("page_token") === "next-page"
              ? [
                  {
                    health: {
                      instances: { active: 0, failed: 0, scheduling: 0, starting: 0 },
                    },
                    id: "a039044b-a162-4e3e-ab30-98f8655e4138",
                    image: "docker.io/cloudflare/sandbox:0.12.4-python",
                    name: "crewhelm-crewhelmsandbox",
                  },
                ]
              : Array.from({ length: 100 }, (_, index) => ({
                  health: {
                    instances: { active: 0, failed: 0, scheduling: 0, starting: 0 },
                  },
                  id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
                  image: "example.invalid/other:1",
                  name: `paginated-other-application-${index}`,
                })),
          result_info:
            url.searchParams.get("page_token") === "next-page"
              ? {}
              : { next_page_token: "next-page" },
          success: true,
        });
      }

      return deploymentFetch(input, init);
    });

    try {
      await expect(
        bootstrapDeployment({ ...REUSE_OPTIONS, sandboxEnabled: true }, dependencies),
      ).resolves.toMatchObject({
        features: { sandboxCode: { enabled: true } },
        ok: true,
      });
      const containerRequests = vi.mocked(dependencies.fetch).mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.pathname.endsWith("/containers/dash/applications");
      });
      expect(containerRequests).toHaveLength(4);
      expect(
        containerRequests.every(([input]) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return url.searchParams.get("per_page") === "100";
        }),
      ).toBe(true);
      expect(
        containerRequests.filter(([input]) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return url.searchParams.get("page_token") === "next-page";
        }),
      ).toHaveLength(2);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("reconciles a missing paid Sandbox application even when Worker bytes are unchanged", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const progress: string[] = [];
    const waits: number[] = [];
    const baseRunner = successfulReuseWrangler(events);
    let containerState: "absent" | "provisioning" | "ready" = "absent";
    let deploymentMessage: string | undefined;
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deployments") {
        events.push("wrangler:deployments");
        return success(
          deploymentMessage
            ? JSON.stringify([
                {
                  annotations: { "workers/message": deploymentMessage },
                  id: "31a2e99c-0bd4-46e0-9cbb-e9e9f0178024",
                },
              ])
            : "[]",
        );
      }

      if (arguments_[0] === "containers") {
        events.push("wrangler:containers");
        return containerState === "absent" ? success("[]") : sandboxContainerList(containerState);
      }

      if (arguments_[0] === "deploy") {
        events.push("wrangler:deploy");
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        containerState = "provisioning";
        return success();
      }

      return baseRunner(arguments_, options);
    };
    const dependencies = createDependencies(fixture.assets, runWrangler);
    dependencies.reportProgress = ({ message }) => progress.push(message);
    dependencies.wait = async (milliseconds) => {
      waits.push(milliseconds);
      containerState = "ready";
    };

    try {
      const first = await bootstrapDeployment(
        { ...REUSE_OPTIONS, sandboxEnabled: true },
        dependencies,
      );
      containerState = "absent";
      dependencies.expectedSkillBucketName = skillBucketNameForWorker(REUSE_OPTIONS.workerName);
      const repaired = await bootstrapDeployment(
        { ...REUSE_OPTIONS, sandboxEnabled: true },
        dependencies,
      );
      const unchanged = await bootstrapDeployment(
        { ...REUSE_OPTIONS, sandboxEnabled: true },
        dependencies,
      );

      expect(first.deployment.action).toBe("updated");
      expect(repaired.deployment.action).toBe("updated");
      expect(unchanged.deployment.action).toBe("unchanged");
      expect(events.filter((event) => event === "wrangler:deploy")).toHaveLength(2);
      expect(
        progress.filter((message) =>
          message.startsWith("Checking optional Sandbox readiness (attempt 2"),
        ),
      ).toHaveLength(2);
      expect(waits).toContain(1_000);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("preserves installed secrets during an upgrade rehearsal", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const baseRunner = recoveryWrangler({
      bindings: [
        { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
        {
          name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
          text: "a".repeat(64),
          type: "plain_text",
        },
        { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
      ],
      databaseName: OPTIONS.databaseName,
      events,
    });
    const deploymentArguments: (readonly string[])[] = [];
    let deploymentMessage: string | undefined;
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deployments") {
        events.push("wrangler:deployments");
        return success(
          deploymentMessage
            ? JSON.stringify([
                {
                  annotations: { "workers/message": deploymentMessage },
                  id: "31a2e99c-0bd4-46e0-9cbb-e9e9f0178024",
                  versions: [{ percentage: 100, version_id: DEPLOYMENT_VERSION_ID }],
                },
              ])
            : JSON.stringify([
                {
                  id: "24f9520f-a92f-47e8-8c7d-6cbd14c89309",
                  versions: [{ percentage: 100, version_id: DEPLOYMENT_VERSION_ID }],
                },
              ]),
        );
      }

      if (arguments_[0] === "deploy") {
        events.push("wrangler:deploy");
        deploymentArguments.push(arguments_);
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        return success("");
      }

      return baseRunner(arguments_, options);
    };
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
      CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
      CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret",
      CREWHELM_OWNER_GITHUB_USER_ID: "123456",
    });

    try {
      const first = await bootstrapUpgradeDeployment(REUSE_OPTIONS, dependencies, ["a".repeat(64)]);
      dependencies.expectedSkillBucketName = skillBucketNameForWorker(REUSE_OPTIONS.workerName);
      const second = await bootstrapUpgradeDeployment(REUSE_OPTIONS, dependencies, [
        "a".repeat(64),
      ]);

      expect(first.deployment.action).toBe("updated");
      expect(second.deployment.action).toBe("unchanged");
      expect(events.filter((event) => event === "wrangler:deploy")).toHaveLength(1);
      expect(deploymentArguments).toHaveLength(1);
      expect(deploymentArguments[0]).not.toContain("--secrets-file");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rejects an upgrade when the active Worker fingerprint is not pinned", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const runWrangler = recoveryWrangler({
      bindings: [
        { database_id: DATABASE_ID, name: "AUTH_DB", type: "d1" },
        {
          name: "CREWHELM_DEPLOYMENT_FINGERPRINT",
          text: "b".repeat(64),
          type: "plain_text",
        },
        { name: "PUBLIC_ORIGIN", text: OPTIONS.origin.origin, type: "plain_text" },
      ],
      databaseName: OPTIONS.databaseName,
      events,
    });

    try {
      await expect(
        bootstrapUpgradeDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler), [
          "a".repeat(64),
        ]),
      ).rejects.toMatchObject({
        message: "Existing Worker fingerprint does not match the supported upgrade state.",
        stage: "configuration",
      });
      expect(events).toEqual(["whoami:--json", "deployments:list", "versions:view"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("refuses to create a missing Worker during an upgrade", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const runWrangler: RunWrangler = async (arguments_) => {
      events.push(arguments_.slice(0, 2).join(":"));

      if (arguments_[0] === "whoami") {
        return whoami();
      }

      return {
        exitCode: 1,
        outcome: "completed",
        stderr: "This Worker does not exist. [code: 10007]",
        stdout: "",
      };
    };

    try {
      await expect(
        bootstrapUpgradeDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler), [
          "a".repeat(64),
        ]),
      ).rejects.toMatchObject({
        message: "Upgrade requires one existing active Worker version.",
        stage: "worker",
      });
      expect(events).toEqual(["whoami:--json", "deployments:list"]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails closed when trigger reconciliation fails for unchanged Worker code", async () => {
    const fixture = await createDeploymentAssets();
    const baseRunner = successfulReuseWrangler();
    let deploymentMessage: string | undefined;
    const runWrangler: RunWrangler = async (arguments_, options) => {
      if (arguments_[0] === "deployments") {
        return success(
          deploymentMessage
            ? JSON.stringify([
                {
                  annotations: { "workers/message": deploymentMessage },
                  id: "31a2e99c-0bd4-46e0-9cbb-e9e9f0178024",
                },
              ])
            : "[]",
        );
      }

      if (arguments_[0] === "deploy") {
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        return success();
      }

      if (arguments_[0] === "triggers") {
        return { exitCode: 1, outcome: "completed", stderr: "", stdout: "" };
      }

      return baseRunner(arguments_, options);
    };
    const dependencies = createDependencies(fixture.assets, runWrangler);

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).resolves.toMatchObject({
        deployment: { action: "updated" },
      });
      dependencies.expectedSkillBucketName = skillBucketNameForWorker(REUSE_OPTIONS.workerName);
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Worker code is current, but route or schedule reconciliation failed.",
        stage: "deployment",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("preserves an existing Gateway route without requiring Gateway API access", async () => {
    const fixture = await createDeploymentAssets();
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler());

    try {
      const report = await bootstrapDeployment(
        { ...REUSE_OPTIONS, aiGatewayId: OPTIONS.workerName },
        dependencies,
      );
      const gatewayRequests = vi.mocked(dependencies.fetch).mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.hostname === "api.cloudflare.com";
      });

      expect(report.aiGateway).toEqual({ enabled: true, id: OPTIONS.workerName });
      expect(gatewayRequests).toHaveLength(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("creates missing D1 and uploads fresh secrets through a private file", async () => {
    const fixture = await createDeploymentAssets();
    const suppliedSecret = "github-client-secret-value";
    let listCount = 0;
    let deployCount = 0;
    let stagedDirectory: string | undefined;
    let deployArguments: readonly string[] | undefined;
    let deploymentMessage: string | undefined;
    let uploadedSecrets: z.infer<typeof stagedSecretsSchema> | undefined;
    const createdResources: unknown[] = [];
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        if (deploymentMessage) {
          return success(
            JSON.stringify([
              {
                annotations: { "workers/message": deploymentMessage },
                id: "3ea0d625-657c-4e22-89d1-4b6b0e2649df",
              },
            ]),
          );
        }

        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        listCount += 1;
        return success(
          listCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (arguments_[0] === "d1" && arguments_[1] === "create") {
        return success();
      }

      if (arguments_[0] === "deploy") {
        deployCount += 1;
        const secretsIndex = arguments_.indexOf("--secrets-file");
        const secretsPath = secretsIndex === -1 ? undefined : arguments_[secretsIndex + 1];

        if (!secretsPath) {
          throw new Error("Expected secrets file.");
        }

        stagedDirectory = resolve(secretsPath, "..");
        uploadedSecrets = stagedSecretsSchema.parse(
          JSON.parse(await readFile(secretsPath, "utf8")),
        );
        deployArguments = arguments_;
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        return deployCount === 1
          ? { exitCode: 1, outcome: "unknown", stderr: "", stdout: "" }
          : success();
      }

      return success();
    });

    try {
      const dependencies = createDependencies(fixture.assets, runWrangler, {
        CREWHELM_BRAVE_SEARCH_API_KEY: "brave-search-api-key-value",
        CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
        CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
        CREWHELM_GITHUB_CLIENT_SECRET: suppliedSecret,
        CREWHELM_OWNER_GITHUB_USER_ID: "123456",
      });
      dependencies.recordCreatedResource = async (resource) => {
        createdResources.push(resource);
      };
      const report = await bootstrapDeployment({ ...OPTIONS, requireFresh: true }, dependencies);

      expect(report.database.action).toBe("created");
      expect(report.deployment.action).toBe("created");
      expect(deployCount).toBe(2);
      expect(uploadedSecrets?.GITHUB_CLIENT_SECRET).toBe(suppliedSecret);
      expect(uploadedSecrets?.COMPOSIO_API_KEY).toBe("composio-project-key");
      expect(uploadedSecrets?.BRAVE_SEARCH_API_KEY).toBe("brave-search-api-key-value");
      expect(uploadedSecrets?.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(deployArguments?.join(" ")).not.toContain(suppliedSecret);
      expect(createdResources).toEqual([
        {
          accountId: ACCOUNT_ID,
          id: DATABASE_ID,
          kind: "database",
          name: OPTIONS.databaseName,
        },
        { accountId: ACCOUNT_ID, kind: "bucket", name: "crewhelm-skills" },
        { accountId: ACCOUNT_ID, kind: "worker", name: OPTIONS.workerName },
      ]);
      expect(stagedDirectory).toBeDefined();
      await expect(access(stagedDirectory!)).rejects.toThrow("ENOENT");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("records a reconciled D1 after an ambiguous create outcome", async () => {
    const fixture = await createDeploymentAssets();
    let databaseListCount = 0;
    const createdResources: unknown[] = [];
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        databaseListCount += 1;
        return success(
          databaseListCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (arguments_[0] === "d1" && arguments_[1] === "create") {
        return { exitCode: 1, outcome: "unknown", stderr: "", stdout: "" };
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
      CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
      CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret-value",
      CREWHELM_OWNER_GITHUB_USER_ID: "123456",
    });
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, requireFresh: true }, dependencies),
      ).rejects.toMatchObject({
        message: expect.stringContaining(`--database-id ${DATABASE_ID}`),
        stage: "database",
      });
      expect(createdResources).toEqual([
        {
          accountId: ACCOUNT_ID,
          id: DATABASE_ID,
          kind: "database",
          name: OPTIONS.databaseName,
        },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not record a planned Gateway when provisioning fails before its mutation", async () => {
    const fixture = await createDeploymentAssets();
    const createdResources: unknown[] = [];
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "auth") {
        return success(JSON.stringify({ token: "cloudflare-oauth-token", type: "oauth" }));
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return { exitCode: 1, outcome: "completed", stderr: "", stdout: "" };
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
      CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
      CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret-value",
      CREWHELM_OWNER_GITHUB_USER_ID: "123456",
    });
    dependencies.fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, aiDailySpendUsd: 1, requireFresh: true }, dependencies),
      ).rejects.toMatchObject({ stage: "database" });
      expect(createdResources).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("records a created Gateway before a failed verification read", async () => {
    const fixture = await createDeploymentAssets();
    const createdResources: unknown[] = [];
    let databaseListCount = 0;
    let gatewayRequestCount = 0;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        databaseListCount += 1;
        return success(
          databaseListCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (
        arguments_[0] === "d1" &&
        (arguments_[1] === "create" || arguments_[1] === "migrations")
      ) {
        return success();
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
      CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
      CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret-value",
      CREWHELM_OWNER_GITHUB_USER_ID: "123456",
    });
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      gatewayRequestCount += 1;

      if (gatewayRequestCount <= 2) {
        return new Response(null, { status: 404 });
      }

      return gatewayRequestCount === 3 || gatewayRequestCount === 4
        ? Response.json(gatewayPayload(1))
        : Response.json({ result: null, success: false }, { status: 500 });
    });
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, aiDailySpendUsd: 1, requireFresh: true }, dependencies),
      ).rejects.toMatchObject({
        message: "Cloudflare AI Gateway configuration could not be verified.",
        stage: "gateway",
      });
      expect(createdResources).toEqual([
        {
          accountId: ACCOUNT_ID,
          id: DATABASE_ID,
          kind: "database",
          name: OPTIONS.databaseName,
        },
        { accountId: ACCOUNT_ID, kind: "bucket", name: "crewhelm-skills" },
        { accountId: ACCOUNT_ID, id: OPTIONS.workerName, kind: "gateway" },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not adopt a Gateway after a definitive create conflict", async () => {
    const fixture = await createDeploymentAssets();
    const createdResources: unknown[] = [];
    let databaseListCount = 0;
    let gatewayRequestCount = 0;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        databaseListCount += 1;
        return success(
          databaseListCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (
        arguments_[0] === "d1" &&
        (arguments_[1] === "create" || arguments_[1] === "migrations")
      ) {
        return success();
      }

      throw new Error(`Unexpected Wrangler command: ${arguments_.join(" ")}`);
    });
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
      CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
      CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret-value",
      CREWHELM_OWNER_GITHUB_USER_ID: "123456",
    });
    const deploymentFetch = healthyDeploymentFetch(deploymentFingerprints.get(fixture.assets));
    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.hostname !== "api.cloudflare.com") {
        return deploymentFetch(input, init);
      }

      gatewayRequestCount += 1;
      return gatewayRequestCount <= 2
        ? new Response(null, { status: 404 })
        : Response.json({ result: null, success: false }, { status: 409 });
    });
    dependencies.recordCreatedResource = async (resource) => {
      createdResources.push(resource);
    };

    try {
      await expect(
        bootstrapDeployment({ ...OPTIONS, aiDailySpendUsd: 1, requireFresh: true }, dependencies),
      ).rejects.toMatchObject({
        message: "Cloudflare AI Gateway could not be configured.",
        stage: "gateway",
      });
      expect(gatewayRequestCount).toBe(3);
      expect(createdResources).toEqual([
        {
          accountId: ACCOUNT_ID,
          id: DATABASE_ID,
          kind: "database",
          name: OPTIONS.databaseName,
        },
        { accountId: ACCOUNT_ID, kind: "bucket", name: "crewhelm-skills" },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("does not create a GitHub App before infrastructure validation succeeds", async () => {
    const fixture = await createDeploymentAssets();
    const createGitHubApp = vi.fn<
      (options: { origin: URL; workerName: string }) => Promise<{
        clientId: string;
        clientSecret: string;
        ownerUserId: string;
      }>
    >(async () => ({
      clientId: "github-client-id",
      clientSecret: "github-client-secret",
      ownerUserId: "123456",
    }));
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return { exitCode: 1, outcome: "completed", stderr: "", stdout: "" };
      }

      return success();
    });
    const dependencies = createDependencies(fixture.assets, runWrangler, {
      CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
    });
    dependencies.createGitHubApp = createGitHubApp;

    try {
      await expect(bootstrapDeployment(OPTIONS, dependencies)).rejects.toMatchObject({
        stage: "database",
      });
      expect(createGitHubApp).not.toHaveBeenCalled();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("stops before D1 mutation when a new deployment has incomplete OAuth settings", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      return {
        exitCode: 1,
        outcome: "completed",
        stderr: "This Worker does not exist. [code: 10007]",
        stdout: "",
      };
    });

    try {
      await expect(
        bootstrapDeployment(
          OPTIONS,
          createDependencies(fixture.assets, runWrangler, {
            CREWHELM_GITHUB_CLIENT_ID: "only-one-setting",
          }),
        ),
      ).rejects.toMatchObject({
        name: "BootstrapError",
        stage: "configuration",
      });
      expect(runWrangler).toHaveBeenCalledTimes(2);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each([
    ["no", {}],
    ["an invalid short", { CREWHELM_COMPOSIO_API_KEY: "short" }],
  ])(
    "stops before D1 mutation when a new deployment has %s Composio project key",
    async (_label, composioEnvironment) => {
      const fixture = await createDeploymentAssets();
      const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
        if (arguments_[0] === "whoami") {
          return whoami();
        }

        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      });

      try {
        await expect(
          bootstrapDeployment(
            OPTIONS,
            createDependencies(fixture.assets, runWrangler, {
              ...composioEnvironment,
              CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
              CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret",
              CREWHELM_OWNER_GITHUB_USER_ID: "123456",
            }),
          ),
        ).rejects.toMatchObject({
          message: "Set CREWHELM_COMPOSIO_API_KEY to a valid Composio project API key.",
          name: "BootstrapError",
          stage: "configuration",
        });
        expect(runWrangler).toHaveBeenCalledTimes(2);
      } finally {
        await rm(fixture.root, { force: true, recursive: true });
      }
    },
  );

  it("stops before D1 mutation when an optional Brave Search key is invalid", async () => {
    const fixture = await createDeploymentAssets();
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") return whoami();
      return {
        exitCode: 1,
        outcome: "completed",
        stderr: "This Worker does not exist. [code: 10007]",
        stdout: "",
      };
    });
    try {
      await expect(
        bootstrapDeployment(
          OPTIONS,
          createDependencies(fixture.assets, runWrangler, {
            CREWHELM_BRAVE_SEARCH_API_KEY: "short",
            CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
            CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
            CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret",
            CREWHELM_OWNER_GITHUB_USER_ID: "123456",
          }),
        ),
      ).rejects.toMatchObject({
        message: "Set CREWHELM_BRAVE_SEARCH_API_KEY to a valid Brave Search API key.",
        stage: "configuration",
      });
      expect(runWrangler).toHaveBeenCalledTimes(2);
      expect(runWrangler).not.toHaveBeenCalledWith(expect.arrayContaining(["d1", "migrations"]));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires explicit reuse after an ambiguous concurrent database creation", async () => {
    const fixture = await createDeploymentAssets();
    let listCount = 0;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami" || arguments_[0] === "deployments") {
        return arguments_[0] === "whoami" ? whoami() : success("[]");
      }

      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES);
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        listCount += 1;
        return success(
          listCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (arguments_[0] === "d1" && arguments_[1] === "create") {
        return {
          exitCode: 1,
          outcome: "unknown",
          stderr: "name already exists",
          stdout: "",
        };
      }

      return success();
    });

    try {
      await expect(
        bootstrapDeployment(OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).rejects.toMatchObject({
        message: expect.stringContaining(`--database-id ${DATABASE_ID}`),
        stage: "database",
      });
      expect(
        runWrangler.mock.calls.filter(
          ([arguments_]) => arguments_[0] === "d1" && arguments_[1] === "create",
        ),
      ).toHaveLength(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("fails closed when post-upload trigger reconciliation also fails", async () => {
    const fixture = await createDeploymentAssets();
    let deployCount = 0;
    let deploymentMessage: string | undefined;
    let inventoryCount = 0;
    let stagedDirectory: string | undefined;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_, runOptions) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        inventoryCount += 1;

        if (inventoryCount > 1 && deploymentMessage) {
          return success(
            JSON.stringify([
              {
                annotations: { "workers/message": deploymentMessage },
                id: "3ea0d625-657c-4e22-89d1-4b6b0e2649df",
              },
            ]),
          );
        }

        return success("[]");
      }

      if (arguments_[0] === "secret") {
        return secretList(WORKER_SECRET_NAMES);
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        return success(JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]));
      }

      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        return arguments_.includes("SELECT name FROM d1_migrations ORDER BY id")
          ? queryResult([
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
            ])
          : queryResult(AUTH_TABLES);
      }

      if (arguments_[0] === "deploy") {
        deployCount += 1;
        stagedDirectory = runOptions.cwd;
        const messageIndex = arguments_.indexOf("--message");
        deploymentMessage = arguments_[messageIndex + 1];
        return { exitCode: 1, outcome: "completed", stderr: "", stdout: "" };
      }

      return success();
    });
    const dependencies = createDependencies(fixture.assets, runWrangler);
    const persistProvisionedInstallation = vi.fn<
      NonNullable<BootstrapDependencies["persistProvisionedInstallation"]>
    >(async () => {});
    dependencies.persistProvisionedInstallation = persistProvisionedInstallation;

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).rejects.toMatchObject({
        message: "Worker code was deployed, but route or schedule reconciliation failed.",
        stage: "deployment",
      });
      expect(persistProvisionedInstallation).toHaveBeenCalledWith({
        accountId: ACCOUNT_ID,
        databaseId: DATABASE_ID,
        databaseName: OPTIONS.databaseName,
        origin: OPTIONS.origin.origin,
        skillBucketName: "crewhelm-skills",
        workerName: OPTIONS.workerName,
      });
      expect(deployCount).toBe(2);
      expect(stagedDirectory).toBeDefined();
      await expect(access(stagedDirectory!)).rejects.toThrow("ENOENT");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps the database but removes staged files when migrations fail", async () => {
    const fixture = await createDeploymentAssets();
    let stagedDirectory: string | undefined;
    let listCount = 0;
    const runWrangler = vi.fn<RunWrangler>(async (arguments_) => {
      if (arguments_[0] === "whoami") {
        return whoami();
      }

      if (arguments_[0] === "deployments") {
        return {
          exitCode: 1,
          outcome: "completed",
          stderr: "This Worker does not exist. [code: 10007]",
          stdout: "",
        };
      }

      if (arguments_[0] === "d1" && arguments_[1] === "list") {
        listCount += 1;
        return success(
          listCount === 1
            ? "[]"
            : JSON.stringify([{ name: OPTIONS.databaseName, uuid: DATABASE_ID }]),
        );
      }

      if (arguments_[0] === "d1" && arguments_[1] === "create") {
        return success();
      }

      if (arguments_[0] === "d1" && arguments_[1] === "execute") {
        return queryResult([]);
      }

      if (arguments_[0] === "d1" && arguments_[1] === "migrations") {
        const configIndex = arguments_.indexOf("--config");
        const configPath = arguments_[configIndex + 1];
        stagedDirectory = configPath ? resolve(configPath, "..") : undefined;
        return {
          exitCode: 1,
          outcome: "unknown",
          stderr: "provider-secret-error",
          stdout: "",
        };
      }

      throw new Error("Deploy must not run after migration failure.");
    });

    try {
      await expect(
        bootstrapDeployment(
          OPTIONS,
          createDependencies(fixture.assets, runWrangler, {
            CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
            CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
            CREWHELM_GITHUB_CLIENT_SECRET: "github-client-secret",
            CREWHELM_OWNER_GITHUB_USER_ID: "123456",
          }),
        ),
      ).rejects.toMatchObject({
        message:
          "D1 migrations did not finish cleanly. The database is preserved for a safe retry.",
        stage: "migrations",
      });
      expect(stagedDirectory).toBeDefined();
      await expect(access(stagedDirectory!)).rejects.toThrow("ENOENT");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
