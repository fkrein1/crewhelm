const REGISTRY_PUBLIC_PREFIX = "/api/registry";

interface RequestService {
  fetch(request: Request): Promise<Response>;
}

export interface SiteEnv {
  ASSETS: RequestService;
  REGISTRY?: RequestService;
  REGISTRY_PUBLIC_ORIGIN?: string;
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

function exactHttpsOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.origin !== value
  ) {
    throw new Error("Invalid Registry public origin configuration.");
  }
  return origin.origin;
}

export async function routeSiteRequest(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url);
  const internalPath = registryPath(url.pathname);
  if (internalPath === null) return env.ASSETS.fetch(request);

  try {
    if (env.REGISTRY) {
      url.pathname = internalPath;
      return await env.REGISTRY.fetch(new Request(url, request));
    }
    if (!env.REGISTRY_PUBLIC_ORIGIN || (request.method !== "GET" && request.method !== "HEAD")) {
      throw new Error("Registry public fallback is unavailable.");
    }
    const origin = exactHttpsOrigin(env.REGISTRY_PUBLIC_ORIGIN);
    url.protocol = "https:";
    url.host = new URL(origin).host;
    return await fetch(
      new Request(url, { headers: registryReadHeaders(request), method: request.method }),
    );
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
