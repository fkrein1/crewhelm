import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          clearMocks: true,
          include: ["packages/**/*.test.ts", "test/**/*.test.ts"],
          name: "foundation",
          restoreMocks: true,
          unstubEnvs: true,
          unstubGlobals: true,
        },
      },
      "./apps/*/vitest.config.mjs",
    ],
  },
});
