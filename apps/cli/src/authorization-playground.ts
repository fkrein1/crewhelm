import { createServer, type Server } from "node:http";

const DEFAULT_PLAYGROUND_PORT = 4_173;
const PLAYGROUND_HOST = "127.0.0.1";

export interface AuthorizationPlaygroundPage {
  description: string;
  group: "CLI loopback" | "Connection return" | "Worker OAuth";
  html: string;
  path: string;
  title: string;
}

interface AuthorizationPlaygroundOptions {
  actionsScript: string;
  pages: readonly AuthorizationPlaygroundPage[];
  port?: number;
  styles: string;
}

const PLAYGROUND_STYLES = `
:root {
  color-scheme: dark;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: #e6edf7;
  background: #0c1118;
}

* { box-sizing: border-box; }
body { margin: 0; background: #0c1118; }
header { padding: 40px clamp(20px, 5vw, 72px) 28px; border-bottom: 1px solid #344152; }
h1 { margin: 0; font: 800 clamp(28px, 5vw, 52px)/.95 ui-sans-serif, system-ui, sans-serif; letter-spacing: -.04em; }
header p { max-width: 760px; margin: 18px 0 0; color: #a9b8c9; font: 14px/1.6 ui-sans-serif, system-ui, sans-serif; }
main { display: grid; gap: 48px; padding: 32px clamp(20px, 5vw, 72px) 72px; }
section { display: grid; gap: 18px; }
h2 { margin: 0; color: #72adff; font-size: 12px; letter-spacing: .1em; text-transform: uppercase; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 520px), 1fr)); gap: 24px; }
article { overflow: hidden; border: 1px solid #344152; background: #111923; }
.card__bar { display: flex; align-items: start; justify-content: space-between; gap: 20px; min-height: 86px; padding: 16px 18px; border-bottom: 1px solid #344152; }
.card__bar h3 { margin: 0 0 7px; font-size: 14px; }
.card__bar p { margin: 0; color: #91a2b6; font: 12px/1.45 ui-sans-serif, system-ui, sans-serif; }
.card__bar a { flex: 0 0 auto; color: #72adff; font-size: 11px; text-underline-offset: 4px; }
iframe { display: block; width: 100%; height: 560px; border: 0; background: #f5f0e7; }
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderAuthorizationPlaygroundIndex(
  pages: readonly AuthorizationPlaygroundPage[],
): string {
  const groups = ["Worker OAuth", "Connection return", "CLI loopback"] as const;
  const sections = groups
    .map((group) => {
      const cards = pages
        .filter((page) => page.group === group)
        .map(
          (page) => `        <article>
          <div class="card__bar">
            <div><h3>${escapeHtml(page.title)}</h3><p>${escapeHtml(page.description)}</p></div>
            <a href="${page.path}" target="_blank" rel="noreferrer">Open raw</a>
          </div>
          <iframe src="${page.path}" title="${escapeHtml(page.title)}"></iframe>
        </article>`,
        )
        .join("\n");

      return `    <section>
      <h2>${group}</h2>
      <div class="grid">
${cards}
      </div>
    </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Crewhelm authorization playground</title>
    <link rel="stylesheet" href="/playground.css">
  </head>
  <body>
    <header>
      <h1>Authorization UI playground</h1>
      <p>${pages.length} fixture-only production views. Buttons and forms terminate inside this loopback server; no signed capabilities, provider calls, or Crewhelm state are used.</p>
    </header>
    <main>
${sections}
    </main>
  </body>
</html>
`;
}

export function authorizationPlaygroundUrl(port: number): URL {
  return new URL(`http://${PLAYGROUND_HOST}:${port}/`);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function responseHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; connect-src 'none'; form-action 'self'; frame-ancestors 'self'; frame-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
  };
}

export async function startAuthorizationPlayground(
  options: AuthorizationPlaygroundOptions,
): Promise<{ close: () => Promise<void>; url: URL }> {
  let expectedHost: string | undefined;
  const pages = new Map(options.pages.map((page) => [page.path, page.html]));
  const server = createServer((request, response) => {
    if (expectedHost === undefined || request.headers.host !== expectedHost) {
      response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
      response.end("Not found.\n");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${expectedHost}`);

    if (
      (request.method === "POST" &&
        ["/oauth/consent", "/playground/noop"].includes(requestUrl.pathname)) ||
      (request.method === "GET" && requestUrl.pathname === "/oauth/login/continue")
    ) {
      response.writeHead(204, responseHeaders("text/plain; charset=utf-8"));
      response.end();
      return;
    }

    if (request.method !== "GET" || requestUrl.search !== "") {
      response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
      response.end("Not found.\n");
      return;
    }

    if (requestUrl.pathname === "/") {
      response.writeHead(200, responseHeaders("text/html; charset=utf-8"));
      response.end(renderAuthorizationPlaygroundIndex(options.pages));
      return;
    }

    if (requestUrl.pathname === "/playground.css") {
      response.writeHead(200, responseHeaders("text/css; charset=utf-8"));
      response.end(`${PLAYGROUND_STYLES}\n`);
      return;
    }

    if (
      requestUrl.pathname === "/oauth/styles.css" ||
      requestUrl.pathname === "/assets/crewhelm.css"
    ) {
      response.writeHead(200, responseHeaders("text/css; charset=utf-8"));
      response.end(`${options.styles}\n`);
      return;
    }

    if (requestUrl.pathname === "/oauth/actions.js") {
      response.writeHead(200, responseHeaders("text/javascript; charset=utf-8"));
      response.end(`${options.actionsScript}\n`);
      return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
      response.writeHead(204, responseHeaders("image/x-icon"));
      response.end();
      return;
    }

    const page = pages.get(requestUrl.pathname);

    if (page !== undefined) {
      response.writeHead(200, responseHeaders("text/html; charset=utf-8"));
      response.end(page);
      return;
    }

    response.writeHead(404, responseHeaders("text/plain; charset=utf-8"));
    response.end("Not found.\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PLAYGROUND_PORT, PLAYGROUND_HOST, resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Authorization playground could not start.");
  }

  const url = authorizationPlaygroundUrl(address.port);
  expectedHost = url.host;

  return {
    close: () => closeServer(server),
    url,
  };
}
