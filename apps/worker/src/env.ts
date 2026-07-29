import type { CrewAgent } from "./agent/durable-object.js";
import type { OwnerControlPlane } from "./owner/durable-object.js";

declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      AI_GATEWAY_DAILY_LIMIT_MICROUSD: string;
      AI_GATEWAY_ID: string;
      AUTH_DB: D1Database;
      BETTER_AUTH_SECRET: string;
      COMPOSIO_API_KEY?: string;
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      AUTH_RATE_LIMIT: RateLimit;
      MCP_RATE_LIMIT: RateLimit;
      OWNER_CONTROL_PLANE: DurableObjectNamespace<OwnerControlPlane>;
      OWNER_GITHUB_USER_ID: string;
      PUBLIC_ORIGIN: string;
    }
  }
}

export type WorkerEnv = Cloudflare.Env;
