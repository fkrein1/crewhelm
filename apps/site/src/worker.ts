import { handle } from "@astrojs/cloudflare/handler";

import { registryPath, routeSiteRequest, type SiteEnv } from "./site-registry-gateway.js";

declare global {
  interface Env extends SiteEnv {}
}

export default {
  fetch(request, env, context) {
    const url = new URL(request.url);
    return registryPath(url.pathname) === null
      ? handle(request, env, context)
      : routeSiteRequest(request, env);
  },
} satisfies ExportedHandler<SiteEnv>;
