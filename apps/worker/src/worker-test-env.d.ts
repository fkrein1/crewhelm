import type { CrewAgent, CrewSession } from "./agent/durable-object.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
      CREW_SESSION: DurableObjectNamespace<CrewSession>;
    }
  }
}
