import { lt } from "drizzle-orm";

import { cleanupExpiredPublishIntents, indexPendingRecipes } from "./registry.js";
import { oauthStates, publisherSessions, registryDatabase } from "./schema.js";
import { createRegistryServer } from "./server.js";

const server = createRegistryServer();

export default {
  fetch: server.fetch,
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env): Promise<void> {
    const now = Math.floor(Date.now() / 1_000);
    const database = registryDatabase(env.REGISTRY_DB);
    await database.batch([
      database.delete(oauthStates).where(lt(oauthStates.expiresAt, now)),
      database.delete(publisherSessions).where(lt(publisherSessions.expiresAt, now)),
    ]);
    await cleanupExpiredPublishIntents(env, now);
    await indexPendingRecipes(env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
