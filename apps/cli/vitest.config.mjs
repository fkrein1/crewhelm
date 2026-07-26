import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    clearMocks: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    name: "cli",
    passWithNoTests: false,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
