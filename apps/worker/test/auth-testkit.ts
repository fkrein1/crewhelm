import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";
import * as z from "zod";

const testMigrationsSchema = z.array(
  z.strictObject({
    name: z.string(),
    queries: z.array(z.string()),
  }),
);

export function registerAuthTestDatabase(): void {
  beforeAll(async () => {
    const migrations = testMigrationsSchema.parse(Reflect.get(env, "TEST_MIGRATIONS"));
    await applyD1Migrations(env.AUTH_DB, migrations);
  });
}
