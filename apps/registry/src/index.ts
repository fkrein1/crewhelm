import { runRegistryMaintenance } from "./maintenance.js";
import { createRegistryServer } from "./server.js";

const server = createRegistryServer();

export default {
  fetch: server.fetch,
  async scheduled(_controller: ScheduledController, env: Cloudflare.Env): Promise<void> {
    await runRegistryMaintenance(env);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
