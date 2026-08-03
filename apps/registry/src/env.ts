declare global {
  namespace Cloudflare {
    interface Env {
      AI: Ai;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      PUBLIC_API_PREFIX: string;
      PUBLIC_ORIGIN: string;
      PUBLIC_READ_RATE_LIMIT: RateLimit;
      PUBLISH_RATE_LIMIT: RateLimit;
      RECIPE_SEARCH_INDEX: VectorizeIndex;
      REGISTRY_DB: D1Database;
      REGISTRY_PACKAGES: R2Bucket;
      SEARCH_RATE_LIMIT: RateLimit;
    }
  }
}

export type RegistryEnv = Cloudflare.Env;
