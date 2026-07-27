import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrationsPath = fileURLToPath(new URL("./migrations", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-better-auth-secret-that-is-at-least-32-bytes",
          COMPOSIO_API_KEY: "test-composio-api-key",
          GITHUB_CLIENT_ID: "test-github-client",
          GITHUB_CLIENT_SECRET: "test-github-secret",
          OWNER_GITHUB_USER_ID: "123456",
          PUBLIC_ORIGIN: "https://crewhelm.test",
          TEST_MIGRATIONS: await readD1Migrations(migrationsPath),
        },
      },
      wrangler: {
        configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
      },
    })),
  ],
  test: {
    clearMocks: true,
    include: ["test/**/*.test.ts"],
    name: "worker",
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 15_000,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
