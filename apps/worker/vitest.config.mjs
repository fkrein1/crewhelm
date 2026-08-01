import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest(async () => ({
      main: fileURLToPath(new URL("./src/worker-test-entry.ts", import.meta.url)),
      miniflare: {
        compatibilityDate: "2026-07-22",
        compatibilityFlags: ["global_fetch_strictly_public", "nodejs_compat"],
        bindings: {
          AI: {},
          BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
          BRAVE_SEARCH_API_KEY: "test-brave-search-api-key",
          COMPOSIO_API_KEY: "test-composio-api-key",
          CREWHELM_DEPLOYMENT_FINGERPRINT:
            "0000000000000000000000000000000000000000000000000000000000000000",
          GITHUB_CLIENT_ID: "test-github-client",
          GITHUB_CLIENT_SECRET: "test-github-secret",
          OWNER_GITHUB_USER_ID: "123456",
          PUBLIC_ORIGIN: "https://crewhelm.test",
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
        d1Databases: ["AUTH_DB"],
        durableObjects: {
          CODE_SANDBOX: {
            className: "TestCodeSandbox",
            useSQLite: true,
          },
          CREW_AGENT: {
            className: "TestCrewAgent",
            useSQLite: true,
          },
          CREW_SESSION: {
            className: "TestCrewSession",
            useSQLite: true,
          },
          OWNER_CONTROL_PLANE: {
            className: "OwnerControlPlane",
            useSQLite: true,
          },
        },
        modulesRules: [
          {
            fallthrough: true,
            include: ["**/*.sql"],
            type: "Text",
          },
        ],
        ratelimits: {
          AUTH_RATE_LIMIT: {
            namespace_id: "10001",
            simple: {
              limit: 10,
              period: 60,
            },
          },
          MCP_RATE_LIMIT: {
            namespace_id: "10002",
            simple: {
              limit: 60,
              period: 60,
            },
          },
        },
        r2Buckets: ["SKILL_PACKAGES"],
      },
    })),
  ],
  test: {
    clearMocks: true,
    include: ["src/**/*.test.ts"],
    name: "worker",
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 15_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
