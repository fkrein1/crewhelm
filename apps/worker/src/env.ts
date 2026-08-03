import type { CrewAgent, CrewSession } from "./agent/durable-object.js";
import type { OwnerControlPlane } from "./owner/durable-object.js";
import type { AgentTaskWorkflow } from "./agent-workflows/agent-task.js";
import type { CrewhelmSandbox } from "./sandbox.js";

declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      AI_GATEWAY_ID?: string;
      AGENT_TASK_WORKFLOW?: Workflow<AgentTaskWorkflow>;
      AUTH_DB: D1Database;
      BETTER_AUTH_SECRET: string;
      BRAVE_SEARCH_API_KEY?: string;
      COMPOSIO_API_KEY?: string;
      CREW_AGENT: DurableObjectNamespace<CrewAgent>;
      CREW_SESSION: DurableObjectNamespace<CrewSession>;
      CODE_SANDBOX?: DurableObjectNamespace<CrewhelmSandbox>;
      CREWHELM_DEPLOYMENT_FINGERPRINT: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      AUTH_RATE_LIMIT: RateLimit;
      COMPOSIO_WEBHOOK_RATE_LIMIT: RateLimit;
      MCP_RATE_LIMIT: RateLimit;
      OWNER_CONTROL_PLANE: DurableObjectNamespace<OwnerControlPlane>;
      OWNER_GITHUB_USER_ID: string;
      PUBLIC_ORIGIN: string;
      RECIPE_REGISTRY_ORIGIN?: string;
      SKILL_PACKAGES: R2Bucket;
    }
  }
}

export type WorkerEnv = Cloudflare.Env;
