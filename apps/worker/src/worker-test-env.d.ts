import type { CrewAgent, CrewSession } from "./agent/durable-object.js";
import type { CrewhelmSandbox } from "./sandbox.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
      CREW_SESSION: DurableObjectNamespace<CrewSession>;
      CODE_SANDBOX?: DurableObjectNamespace<CrewhelmSandbox>;
    }
  }
}
