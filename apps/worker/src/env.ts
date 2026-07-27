import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

import type { OwnerControlPlane } from "./owner-control-plane.js";

export type OAuthAuthorizationApi = Pick<
  OAuthHelpers,
  "completeAuthorization" | "lookupClient" | "parseAuthRequest"
>;

declare global {
  namespace Cloudflare {
    interface Env {
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      AUTH_RATE_LIMIT: RateLimit;
      MCP_RATE_LIMIT: RateLimit;
      OAUTH_KV: KVNamespace;
      OAUTH_PROVIDER?: OAuthAuthorizationApi;
      OWNER_CONTROL_PLANE: DurableObjectNamespace<OwnerControlPlane>;
      OWNER_GITHUB_USER_ID: string;
    }
  }
}

export type WorkerEnv = Cloudflare.Env;
