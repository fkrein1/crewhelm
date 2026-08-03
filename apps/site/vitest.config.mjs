import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    clearMocks: true,
    include: ["src/**/*.test.ts"],
    name: "site",
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
