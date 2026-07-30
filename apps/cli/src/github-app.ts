import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import * as z from "zod";

import {
  LOCAL_PAGE_STYLES,
  LOCAL_PAGE_STYLES_PATH,
  localPageHeaders,
  renderLocalPage,
} from "./local-page.js";

const GITHUB_APP_MANIFEST_URL = "https://github.com/settings/apps/new";
const GITHUB_API_URL = "https://api.github.com";
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1_000;
const MAXIMUM_RESPONSE_BYTES = 64 * 1_024;

const manifestConversionSchema = z.looseObject({
  client_id: z.string().min(1).max(255),
  client_secret: z.string().min(1).max(1_024),
  owner: z.looseObject({
    id: z.number().int().positive().safe(),
    type: z.literal("User"),
  }),
});

export interface GitHubAppCredentials {
  clientId: string;
  clientSecret: string;
  ownerUserId: string;
}

export interface CreateGitHubAppDependencies {
  fetch: typeof globalThis.fetch;
  openUrl: (url: URL) => Promise<void>;
  writeOutput: (text: string) => void;
}

export interface CreateGitHubAppOptions {
  origin: URL;
  workerName: string;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function readBoundedBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();

  if (!reader) {
    return "";
  }

  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";

  for (;;) {
    const chunk = await reader.read();

    if (chunk.done) {
      return body + decoder.decode();
    }

    bytes += chunk.value.byteLength;

    if (bytes > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("GitHub App response exceeded its limit.");
    }

    body += decoder.decode(chunk.value, { stream: true });
  }
}

function manifestFor(options: CreateGitHubAppOptions, redirectUrl: URL) {
  return {
    default_events: [],
    default_permissions: {},
    description: "Owner authentication for a self-hosted Crewhelm fleet.",
    name: `Crewhelm ${options.workerName} ${stateSuffix(redirectUrl)}`,
    public: false,
    redirect_url: redirectUrl.href,
    url: options.origin.origin,
    callback_urls: [`${options.origin.origin}/api/auth/callback/github`],
  };
}

function stateSuffix(redirectUrl: URL): string {
  return createHash("sha256").update(redirectUrl.href).digest("hex").slice(0, 8);
}

export async function createGitHubApp(
  options: CreateGitHubAppOptions,
  dependencies: CreateGitHubAppDependencies,
): Promise<GitHubAppCredentials> {
  const state = randomBytes(32).toString("base64url");
  const setupCapability = randomBytes(32).toString("base64url");
  const setupPath = `/setup/${setupCapability}`;
  let expectedHost: string | undefined;
  let resolveCallback: ((code: string) => void) | undefined;
  const code = new Promise<string>((resolve) => {
    resolveCallback = resolve;
  });

  const server = createServer((request, response) => {
    if (expectedHost === undefined || request.headers.host !== expectedHost) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && requestUrl.pathname === LOCAL_PAGE_STYLES_PATH) {
      response.writeHead(200, {
        "cache-control": "private, max-age=600",
        "content-type": "text/css; charset=utf-8",
        "x-content-type-options": "nosniff",
      });
      response.end(`${LOCAL_PAGE_STYLES}\n`);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/callback") {
      const returnedState = requestUrl.searchParams.get("state");
      const returnedCode = requestUrl.searchParams.get("code");

      if (returnedState !== state || !returnedCode || returnedCode.length > 1_024) {
        response.writeHead(400, localPageHeaders());
        response.end(
          renderLocalPage({
            heading: "GitHub App setup could not be verified",
            paragraphs: ["Return to Crewhelm and start the setup again."],
            title: "GitHub App setup not verified",
            tone: "negative",
          }),
        );
        return;
      }

      response.writeHead(200, localPageHeaders());
      response.end(
        renderLocalPage({
          heading: "GitHub App connected",
          paragraphs: ["Return to Crewhelm to finish the installation."],
          title: "GitHub App connected",
          tone: "positive",
        }),
      );
      resolveCallback?.(returnedCode);
      return;
    }

    if (request.method !== "GET" || requestUrl.pathname !== setupPath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found.");
      return;
    }

    const address = server.address();

    if (!address || typeof address === "string") {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      response.end("GitHub App setup is unavailable.");
      return;
    }

    const redirectUrl = new URL(`http://127.0.0.1:${address.port}/callback`);
    const manifest = JSON.stringify(manifestFor(options, redirectUrl));
    response.writeHead(200, localPageHeaders("https://github.com"));
    response.end(
      renderLocalPage({
        form: {
          action: `${GITHUB_APP_MANIFEST_URL}?state=${encodeURIComponent(state)}`,
          fields: { manifest },
          label: "Continue to GitHub",
        },
        heading: "Create your Crewhelm GitHub App",
        paragraphs: [
          "GitHub will create a private app with no repository permissions. Crewhelm uses it only to verify the fleet owner.",
        ],
        title: "Connect Crewhelm to GitHub",
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("GitHub App setup could not start.");
  }

  expectedHost = `127.0.0.1:${address.port}`;
  const setupUrl = new URL(`http://${expectedHost}${setupPath}`);
  dependencies.writeOutput(`Browser did not open? ${setupUrl.href}\n`);
  await dependencies.openUrl(setupUrl);

  let authorizationCode: string;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    authorizationCode = await Promise.race([
      code,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("GitHub App setup timed out.")),
          CALLBACK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    await closeServer(server);
  }

  const response = await dependencies.fetch(
    `${GITHUB_API_URL}/app-manifests/${encodeURIComponent(authorizationCode)}/conversions`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "crewhelm-cli",
        "x-github-api-version": "2022-11-28",
      },
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await readBoundedBody(response);

  if (!response.ok) {
    throw new Error("GitHub App credentials could not be created.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("GitHub App returned an invalid response.");
  }

  const parsed = manifestConversionSchema.safeParse(payload);

  if (!parsed.success) {
    throw new Error("GitHub App returned incomplete owner credentials.");
  }

  return {
    clientId: parsed.data.client_id,
    clientSecret: parsed.data.client_secret,
    ownerUserId: String(parsed.data.owner.id),
  };
}
