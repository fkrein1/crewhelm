import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)),
      },
    }),
  ],
  test: {
    clearMocks: true,
    include: ["test/**/*.test.ts"],
    name: "worker",
    passWithNoTests: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
