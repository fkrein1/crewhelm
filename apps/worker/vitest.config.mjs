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
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          AI: {},
          BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
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
          CREW_AGENT: {
            className: "TestCrewAgent",
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
