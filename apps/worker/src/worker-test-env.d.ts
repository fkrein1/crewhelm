import type { CrewAgent } from "./agent/durable-object.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
    }
  }
}
