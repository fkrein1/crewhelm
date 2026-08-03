import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest(async () => ({
      main: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      miniflare: {
        compatibilityDate: "2026-07-22",
        compatibilityFlags: ["global_fetch_strictly_public"],
        bindings: {
          AI: {},
          GITHUB_CLIENT_ID: "test-github-client",
          GITHUB_CLIENT_SECRET: "test-github-secret",
          PUBLIC_API_PREFIX: "/api/registry",
          PUBLIC_ORIGIN: "https://registry.crewhelm.test/",
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
        d1Databases: ["REGISTRY_DB"],
        ratelimits: {
          PUBLIC_READ_RATE_LIMIT: {
            namespace_id: "20001",
            simple: { limit: 300, period: 60 },
          },
          PUBLISH_RATE_LIMIT: {
            namespace_id: "20003",
            simple: { limit: 10, period: 60 },
          },
          SEARCH_RATE_LIMIT: {
            namespace_id: "20002",
            simple: { limit: 60, period: 60 },
          },
        },
        r2Buckets: ["REGISTRY_PACKAGES"],
      },
    })),
  ],
  test: {
    clearMocks: true,
    include: ["src/**/*.test.ts"],
    name: "registry",
    restoreMocks: true,
    testTimeout: 15_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
