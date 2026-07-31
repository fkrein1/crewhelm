import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  LOCAL_PAGE_STYLES,
  LOCAL_PAGE_STYLES_PATH,
  localPageHeaders,
  renderLocalPage,
} from "./local-page.js";

const DEFAULT_HANDOFF_TIMEOUT_MS = 10 * 60 * 1_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export interface CodexBrowserDependencies {
  handoffTimeoutMs?: number;
  writeError: (text: string) => void;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function openInCodexBrowser(
  targetUrl: URL,
  dependencies: CodexBrowserDependencies,
): Promise<void> {
  const isHttps = targetUrl.protocol === "https:";
  const isLoopbackHttp = targetUrl.protocol === "http:" && LOOPBACK_HOSTS.has(targetUrl.hostname);

  if (
    (!isHttps && !isLoopbackHttp) ||
    targetUrl.username !== "" ||
    targetUrl.password !== "" ||
    targetUrl.href.length > 16 * 1_024
  ) {
    throw new Error("Codex browser target was invalid.");
  }

  const capability = randomBytes(32).toString("base64url");
  const handoffPath = `/codex/browser/${capability}`;
  const continuePath = `${handoffPath}/continue`;
  let consumed = false;
  let expectedHost: string | undefined;
  let resolveVisit: (() => void) | undefined;
  const visit = new Promise<void>((resolve) => {
    resolveVisit = resolve;
  });
  const server = createServer((request, response) => {
    let requestUrl: URL;

    try {
      requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end("Not found.");
      return;
    }

    if (
      expectedHost !== undefined &&
      request.headers.host === expectedHost &&
      request.method === "GET" &&
      requestUrl.pathname === LOCAL_PAGE_STYLES_PATH &&
      requestUrl.search === ""
    ) {
      response.writeHead(200, {
        "cache-control": "private, max-age=600",
        "content-type": "text/css; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(`${LOCAL_PAGE_STYLES}\n`);
      return;
    }

    if (
      !consumed &&
      expectedHost !== undefined &&
      request.headers.host === expectedHost &&
      request.method === "GET" &&
      requestUrl.pathname === handoffPath &&
      requestUrl.search === ""
    ) {
      response.writeHead(200, localPageHeaders("'self'"));
      response.end(
        renderLocalPage({
          form: {
            action: continuePath,
            fields: {},
            label: "Continue to Crewhelm",
          },
          heading: "Continue in Codex Browser",
          paragraphs: [
            "Crewhelm will open the authorization page without exposing its signed URL in the terminal.",
          ],
          title: "Crewhelm browser handoff",
        }),
      );
      return;
    }

    if (
      consumed ||
      expectedHost === undefined ||
      request.headers.host !== expectedHost ||
      request.method !== "POST" ||
      requestUrl.pathname !== continuePath ||
      requestUrl.search !== ""
    ) {
      response.writeHead(404, {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end("Not found.");
      return;
    }

    consumed = true;
    response.writeHead(303, {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
      location: targetUrl.href,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(undefined, () => resolveVisit?.());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Codex browser handoff could not start.");
  }

  expectedHost = `127.0.0.1:${address.port}`;
  const handoffUrl = new URL(`http://${expectedHost}${handoffPath}`);
  dependencies.writeError(`CODEX_BROWSER_HANDOFF ${handoffUrl.href}\n`);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      visit,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Codex browser handoff timed out.")),
          dependencies.handoffTimeoutMs ?? DEFAULT_HANDOFF_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await closeServer(server);
  }
}
