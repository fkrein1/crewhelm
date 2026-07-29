import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

import {
  bootstrapDeployment,
  type BootstrapDependencies,
  type BootstrapOptions,
} from "../src/bootstrap.js";
import { type RunWrangler, type WranglerResult } from "../src/wrangler.js";

const DATABASE_ID = "c58217fd-fe09-447b-b79c-5d63ed1cedc0";
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
const WORKER_TEXT_MODULE = "0000000000000000000000000000000000000000-0000_test.sql";
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
    bindings: z.tuple([
      z.looseObject({
        class_name: z.literal("OwnerControlPlane"),
        name: z.literal("OWNER_CONTROL_PLANE"),
      }),
      z.looseObject({
        class_name: z.literal("CrewAgent"),
        name: z.literal("CREW_AGENT"),
      }),
    ]),
  }),
  observability: z.looseObject({
    logs: z.looseObject({ invocation_logs: z.literal(false) }),
    traces: z.looseObject({ enabled: z.literal(false) }),
  }),
  rules: z.tuple([
    z.looseObject({
      globs: z.tuple([z.literal("**/*.sql")]),
      type: z.literal("Text"),
    }),
  ]),
  secrets: z.looseObject({ required: z.array(z.string()) }),
  vars: z.looseObject({ PUBLIC_ORIGIN: z.url() }),
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

function healthyDeploymentFetch(): typeof globalThis.fetch {
  return vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    let payload: unknown;

    if (url.hostname === "api.cloudflare.com") {
      payload = gatewayPayload(1);
    } else if (url.pathname === "/health") {
      payload = { service: "crewhelm", status: "ok" };
    } else if (url.pathname === "/.well-known/oauth-protected-resource") {
      payload = {
        authorization_servers: ["https://crewhelm.example/api/auth"],
        bearer_methods_supported: ["header"],
        resource: "https://crewhelm.example/mcp",
        scopes_supported: [
          "control:read",
          "control:write",
          "agents:read",
          "agents:write",
          "autonomy:write",
          "connections:read",
          "connections:write",
          "connection-configs:read",
          "connection-configs:write",
          "integrations:read",
          "offline_access",
        ],
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
        scopes_supported: [
          "control:read",
          "control:write",
          "agents:read",
          "agents:write",
          "autonomy:write",
          "connections:read",
          "connections:write",
          "connection-configs:read",
          "connection-configs:write",
          "integrations:read",
          "offline_access",
        ],
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
  await writeFile(
    resolve(assets, "wrangler-template.json"),
    JSON.stringify({
      ai: { binding: "AI" },
      compatibility_date: "2026-07-22",
      compatibility_flags: ["nodejs_compat"],
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
        ],
      },
      exports: {
        CrewAgent: {
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
      vars: { PUBLIC_ORIGIN: "https://template.example" },
    }),
  );
  return { assets, root };
}

function createDependencies(
  assets: string,
  runWrangler: RunWrangler,
  environment: Readonly<Record<string, string>> = {},
): BootstrapDependencies {
  return {
    deploymentAssetsDirectory: assets,
    fetch: healthyDeploymentFetch(),
    readEnvironment: (name) => environment[name],
    runWrangler: (arguments_, options) =>
      arguments_[0] === "auth"
        ? Promise.resolve(success(JSON.stringify({ token: "test-token", type: "oauth" })))
        : runWrangler(arguments_, options),
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
          ])
        : queryResult(AUTH_TABLES);
    }

    return success();
  };
}

describe("Cloudflare bootstrap", () => {
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
          REUSE_OPTIONS,
          createDependencies(fixture.assets, runWrangler, {
            CREWHELM_CLOUDFLARE_API_TOKEN: "short",
          }),
        ),
      ).rejects.toMatchObject({
        message:
          "Set CREWHELM_CLOUDFLARE_API_TOKEN to a valid account API token with AI Gateway Read and Edit.",
        name: "BootstrapError",
        stage: "gateway",
      });
      expect(runWrangler).toHaveBeenCalledTimes(1);
      expect(runWrangler.mock.calls[0]?.[0][0]).toBe("whoami");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("updates the explicit Gateway limit only after deployment and verifies read-back", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler(events));
    const deploymentFetch = healthyDeploymentFetch();
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

      expect(report.aiGateway).toEqual({ dailySpendUsd: 5, id: OPTIONS.workerName });
      expect(events.filter((event) => event.startsWith("gateway:"))).toEqual([
        "gateway:GET",
        "gateway:PUT",
        "gateway:GET",
      ]);
      expect(events.indexOf("gateway:PUT")).toBeGreaterThan(events.indexOf("wrangler:deploy"));
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("requires an explicit repair when an existing Gateway limit cannot be verified", async () => {
    const fixture = await createDeploymentAssets();
    const events: string[] = [];
    const dependencies = createDependencies(fixture.assets, successfulReuseWrangler(events));
    const deploymentFetch = healthyDeploymentFetch();

    dependencies.fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);

      return url.hostname === "api.cloudflare.com"
        ? Response.json({ result: { id: OPTIONS.workerName }, success: true })
        : deploymentFetch(input, init);
    });

    try {
      await expect(bootstrapDeployment(REUSE_OPTIONS, dependencies)).rejects.toMatchObject({
        message:
          "The existing AI Gateway spend limit could not be verified. Pass --ai-budget-usd to repair it explicitly.",
        name: "BootstrapError",
        stage: "gateway",
      });
      expect(events.some((event) => event === "wrangler:d1")).toBe(false);
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

  it("reuses existing resources without requiring or replacing secrets", async () => {
    const fixture = await createDeploymentAssets();
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
      const report = await bootstrapDeployment(REUSE_OPTIONS, dependencies);

      expect(report.ok).toBe(true);
      expect(report.aiGateway).toEqual({ dailySpendUsd: 1, id: OPTIONS.workerName });
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
      ]);
      expect(stagedConfig?.observability.logs.invocation_logs).toBe(false);
      expect(stagedConfig?.observability.traces.enabled).toBe(false);
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
      expect(stagedConfig?.vars.AI_GATEWAY_DAILY_LIMIT_MICROUSD).toBe("1000000");
      expect(stagedConfig?.vars.AI_GATEWAY_ID).toBe(OPTIONS.workerName);
      expect(deployArguments).not.toContain("--secrets-file");
      expect(deployArguments).toContain("--strict");
      expect(allWranglerCalls.mock.calls.some(([arguments_]) => arguments_[0] === "auth")).toBe(
        false,
      );
      const gatewayRequests = vi.mocked(dependencies.fetch).mock.calls.filter(([input]) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return url.hostname === "api.cloudflare.com";
      });

      expect(gatewayRequests).toHaveLength(2);
      expect(
        gatewayRequests.every(([, init]) => {
          const headers = new Headers(init?.headers);
          return headers.get("authorization") === `Bearer ${cloudflareApiToken}`;
        }),
      ).toBe(true);
      expect(gatewayRequests.every(([, init]) => init?.method === "GET")).toBe(true);
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

  it("creates missing D1 and uploads fresh secrets through a private file", async () => {
    const fixture = await createDeploymentAssets();
    const suppliedSecret = "github-client-secret-value";
    let listCount = 0;
    let deployCount = 0;
    let stagedDirectory: string | undefined;
    let deployArguments: readonly string[] | undefined;
    let deploymentMessage: string | undefined;
    let uploadedSecrets: z.infer<typeof stagedSecretsSchema> | undefined;
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
      const report = await bootstrapDeployment(
        OPTIONS,
        createDependencies(fixture.assets, runWrangler, {
          CREWHELM_COMPOSIO_API_KEY: "composio-project-key",
          CREWHELM_GITHUB_CLIENT_ID: "github-client-id",
          CREWHELM_GITHUB_CLIENT_SECRET: suppliedSecret,
          CREWHELM_OWNER_GITHUB_USER_ID: "123456",
        }),
      );

      expect(report.database.action).toBe("created");
      expect(report.deployment.action).toBe("created");
      expect(deployCount).toBe(2);
      expect(uploadedSecrets?.GITHUB_CLIENT_SECRET).toBe(suppliedSecret);
      expect(uploadedSecrets?.COMPOSIO_API_KEY).toBe("composio-project-key");
      expect(uploadedSecrets?.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(deployArguments?.join(" ")).not.toContain(suppliedSecret);
      expect(stagedDirectory).toBeDefined();
      await expect(access(stagedDirectory!)).rejects.toThrow("ENOENT");
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

    try {
      await expect(
        bootstrapDeployment(REUSE_OPTIONS, createDependencies(fixture.assets, runWrangler)),
      ).rejects.toMatchObject({
        message: "Worker code was deployed, but route or schedule reconciliation failed.",
        stage: "deployment",
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
