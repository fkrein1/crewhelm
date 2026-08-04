declare module "cloudflare:workers" {
  export const env: {
    REGISTRY?: { fetch(request: Request): Promise<Response> };
    REGISTRY_PUBLIC_ORIGIN?: string;
  };
}
