import type { OwnerControlPlane } from "./owner-control-plane.js";

declare global {
  namespace Cloudflare {
    interface Env {
      AUTH_DB: D1Database;
      BETTER_AUTH_SECRET: string;
      COMPOSIO_API_KEY?: string;
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
