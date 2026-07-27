import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./control-plane-migrations",
  schema: "./src/control-plane-schema.ts",
});
