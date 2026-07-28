import type { CrewAgent } from "../src/crew-agent.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
    }
  }
}
