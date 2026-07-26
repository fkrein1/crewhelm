import type { OwnerControlPlane } from "./owner-control-plane.js";

declare global {
  namespace Cloudflare {
    interface Env {
      OWNER_CONTROL_PLANE: DurableObjectNamespace<OwnerControlPlane>;
    }
  }
}

export type WorkerEnv = Cloudflare.Env;
