import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import * as z from "zod";

const testMigrationsSchema = z.array(
  z.strictObject({
    name: z.string(),
    queries: z.array(z.string()),
  }),
);

export function readAuthTestMigrations(): z.infer<typeof testMigrationsSchema> {
  return testMigrationsSchema.parse(Reflect.get(env, "TEST_MIGRATIONS"));
}

export function registerAuthTestDatabase(): void {
  beforeAll(async () => {
    await applyD1Migrations(env.AUTH_DB, readAuthTestMigrations());
  });
}
