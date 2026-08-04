const REGISTRY_PUBLIC_PREFIX = "/api/registry";

interface RequestService {
  fetch(request: Request): Promise<Response>;
}

export interface SiteEnv {
  ASSETS: RequestService;
  REGISTRY: RequestService;
  REGISTRY_ORIGIN?: string;
}

export function registryPath(pathname: string): string | null {
  if (pathname === REGISTRY_PUBLIC_PREFIX) return "/";
  if (!pathname.startsWith(`${REGISTRY_PUBLIC_PREFIX}/`)) return null;
  return pathname.slice(REGISTRY_PUBLIC_PREFIX.length);
}

export function registryReadHeaders(request: Request): Headers {
  const headers = new Headers({ accept: "application/json" });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set("cf-connecting-ip", clientIp);
  return headers;
}

export async function routeSiteRequest(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url);
  const internalPath = registryPath(url.pathname);
  if (internalPath === null) return env.ASSETS.fetch(request);

  try {
    if (env.REGISTRY_ORIGIN !== undefined) {
      const registryOrigin = new URL(env.REGISTRY_ORIGIN);
      if (
        registryOrigin.protocol !== "https:" ||
        registryOrigin.pathname !== "/" ||
        registryOrigin.search !== "" ||
        registryOrigin.hash !== "" ||
        registryOrigin.username !== "" ||
        registryOrigin.password !== "" ||
        registryOrigin.origin !== env.REGISTRY_ORIGIN
      ) {
        throw new Error("Invalid Registry origin configuration.");
      }
      url.protocol = registryOrigin.protocol;
      url.host = registryOrigin.host;
    }
    url.pathname = internalPath;
    return await env.REGISTRY.fetch(new Request(url, request));
  } catch {
    return Response.json(
      { error: "unavailable" },
      {
        headers: { "cache-control": "no-store" },
        status: 503,
      },
    );
  }
}
