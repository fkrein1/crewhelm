const REGISTRY_PUBLIC_PREFIX = "/api/registry";

export interface SiteEnv {
  ASSETS: RequestService;
  REGISTRY: RequestService;
}

interface RequestService {
  fetch(request: Request): Promise<Response>;
}

function registryPath(pathname: string): string | null {
  if (pathname === REGISTRY_PUBLIC_PREFIX) return "/";
  if (!pathname.startsWith(`${REGISTRY_PUBLIC_PREFIX}/`)) return null;
  return pathname.slice(REGISTRY_PUBLIC_PREFIX.length);
}

export async function routeSiteRequest(request: Request, env: SiteEnv): Promise<Response> {
  const url = new URL(request.url);
  const internalPath = registryPath(url.pathname);
  if (internalPath === null) return env.ASSETS.fetch(request);

  url.pathname = internalPath;
  try {
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

export default {
  fetch: routeSiteRequest,
} satisfies ExportedHandler<SiteEnv>;
