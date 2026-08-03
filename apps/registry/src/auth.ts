import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq, gte } from "drizzle-orm";

import type { RegistryEnv } from "./env.js";
import { sha256Hex } from "./packages.js";
import {
  oauthStates,
  publishers,
  publisherSessions,
  registryDatabase,
  type RegistryDatabase,
} from "./schema.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const OAUTH_STATE_COOKIE = "crewhelm_registry_oauth_state";
const SESSION_COOKIE = "crewhelm_registry_session";
const OAUTH_STATE_SECONDS = 10 * 60;
const SESSION_SECONDS = 24 * 60 * 60;
const MAXIMUM_GITHUB_RESPONSE_BYTES = 16 * 1_024;

type Publisher = {
  displayName: string;
  githubUserId: number;
  namespace: string;
  profileUrl?: string;
};

function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (
      !/^\d+$/u.test(contentLengthHeader) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength > MAXIMUM_GITHUB_RESPONSE_BYTES
    ) {
      throw new Error("GitHub response too large");
    }
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("GitHub response body unavailable");
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error("Invalid GitHub response body");
      byteLength += chunk.value.byteLength;
      if (byteLength > MAXIMUM_GITHUB_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GitHub response too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function hashesEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function publisherNamespace(login: string, githubUserId: number): string {
  const normalized = login
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 39);
  return normalized || `github-${githubUserId}`;
}

async function stablePublisherNamespace(
  database: RegistryDatabase,
  login: string,
  githubUserId: number,
): Promise<string> {
  const [current] = await database
    .select({ namespace: publishers.namespace })
    .from(publishers)
    .where(eq(publishers.githubUserId, githubUserId))
    .limit(1);
  if (current) return current.namespace;
  const preferred = publisherNamespace(login, githubUserId);
  const [occupied] = await database
    .select({ githubUserId: publishers.githubUserId })
    .from(publishers)
    .where(eq(publishers.namespace, preferred))
    .limit(1);
  if (!occupied) return preferred;
  const suffix = `-${githubUserId}`;
  return `${preferred.slice(0, 39 - suffix.length).replace(/-$/u, "")}${suffix}`;
}

function safeReturnTo(raw: string | undefined, publicOrigin: string): string {
  if (!raw?.startsWith("/") || raw.startsWith("//") || raw.length > 512) return "/publish";
  try {
    const origin = new URL(publicOrigin);
    const destination = new URL(raw, origin);
    if (destination.origin !== origin.origin) return "/publish";
    return `${destination.pathname}${destination.search}`;
  } catch {
    return "/publish";
  }
}

function publicRegistryPath(env: RegistryEnv, path: string): string {
  if (env.PUBLIC_API_PREFIX !== "/api/registry" || !path.startsWith("/")) {
    throw new Error("Invalid public Registry route configuration");
  }
  return `${env.PUBLIC_API_PREFIX}${path}`;
}

function publicRegistryUrl(env: RegistryEnv, path: string): string {
  return new URL(publicRegistryPath(env, path), env.PUBLIC_ORIGIN).toString();
}

export async function startGithubAuth(
  context: Context<{ Bindings: RegistryEnv }>,
): Promise<Response> {
  const state = randomToken();
  const verifier = randomToken(48);
  const challengeBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  let challengeBinary = "";
  for (const byte of challengeBytes) challengeBinary += String.fromCharCode(byte);
  const challenge = btoa(challengeBinary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const now = Math.floor(Date.now() / 1_000);
  const database = registryDatabase(context.env.REGISTRY_DB);

  await database.insert(oauthStates).values({
    expiresAt: now + OAUTH_STATE_SECONDS,
    returnTo: safeReturnTo(context.req.query("return_to"), context.env.PUBLIC_ORIGIN),
    stateHash: await tokenHash(state),
    verifier,
  });
  setCookie(context, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    maxAge: OAUTH_STATE_SECONDS,
    path: publicRegistryPath(context.env, "/auth/github"),
    sameSite: "Lax",
    secure: true,
  });

  const callback = publicRegistryUrl(context.env, "/auth/github/callback");
  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", context.env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return context.redirect(authorize.toString(), 302);
}

export async function finishGithubAuth(
  context: Context<{ Bindings: RegistryEnv }>,
): Promise<Response> {
  const code = context.req.query("code");
  const state = context.req.query("state");
  if (!code || !state || code.length > 512 || state.length > 128) return context.notFound();
  const browserState = getCookie(context, OAUTH_STATE_COOKIE);
  if (!browserState || browserState.length > 128) return context.notFound();

  const now = Math.floor(Date.now() / 1_000);
  const database = registryDatabase(context.env.REGISTRY_DB);
  const stateHash = await tokenHash(state);
  if (!hashesEqual(stateHash, await tokenHash(browserState))) return context.notFound();
  deleteCookie(context, OAUTH_STATE_COOKIE, {
    path: publicRegistryPath(context.env, "/auth/github"),
    secure: true,
  });
  const [stored] = await database
    .delete(oauthStates)
    .where(and(eq(oauthStates.stateHash, stateHash), gte(oauthStates.expiresAt, now)))
    .returning({ returnTo: oauthStates.returnTo, verifier: oauthStates.verifier });
  if (!stored) return context.notFound();

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      body: new URLSearchParams({
        client_id: context.env.GITHUB_CLIENT_ID,
        client_secret: context.env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: stored.verifier,
      }),
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
    });
    const tokenBody = await boundedJson(tokenResponse);
    if (
      !tokenResponse.ok ||
      typeof tokenBody !== "object" ||
      tokenBody === null ||
      !("access_token" in tokenBody) ||
      typeof tokenBody.access_token !== "string"
    ) {
      return await context.notFound();
    }

    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${tokenBody.access_token}`,
        "user-agent": "crewhelm-registry",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const user = await boundedJson(userResponse);
    if (
      !userResponse.ok ||
      typeof user !== "object" ||
      user === null ||
      !("id" in user) ||
      !("login" in user) ||
      typeof user.id !== "number" ||
      typeof user.login !== "string" ||
      !Number.isSafeInteger(user.id)
    ) {
      return await context.notFound();
    }

    const displayName =
      "name" in user && typeof user.name === "string" && user.name.trim()
        ? user.name.trim().slice(0, 80)
        : user.login.slice(0, 80);
    const profileUrl =
      "html_url" in user && typeof user.html_url === "string" ? user.html_url : undefined;
    const namespace = await stablePublisherNamespace(database, user.login, user.id);
    await database
      .insert(publishers)
      .values({
        createdAt: now,
        displayName,
        githubLogin: user.login,
        githubUserId: user.id,
        namespace,
        profileUrl: profileUrl ?? null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          displayName,
          githubLogin: user.login,
          profileUrl: profileUrl ?? null,
          updatedAt: now,
        },
        target: publishers.githubUserId,
      });

    const session = randomToken();
    await database.insert(publisherSessions).values({
      createdAt: now,
      expiresAt: now + SESSION_SECONDS,
      githubUserId: user.id,
      tokenHash: await tokenHash(session),
    });
    setCookie(context, SESSION_COOKIE, session, {
      httpOnly: true,
      maxAge: SESSION_SECONDS,
      path: publicRegistryPath(context.env, "/"),
      sameSite: "Lax",
      secure: true,
    });
    return context.redirect(new URL(stored.returnTo, context.env.PUBLIC_ORIGIN).toString(), 302);
  } catch {
    return await context.notFound();
  } finally {
    clearTimeout(timeout);
  }
}

export async function authenticatePublisher(
  context: Context<{ Bindings: RegistryEnv }>,
): Promise<Publisher | null> {
  const session = getCookie(context, SESSION_COOKIE);
  if (!session || session.length > 128) return null;
  const now = Math.floor(Date.now() / 1_000);
  const database = registryDatabase(context.env.REGISTRY_DB);
  const [row] = await database
    .select({
      displayName: publishers.displayName,
      githubUserId: publishers.githubUserId,
      namespace: publishers.namespace,
      profileUrl: publishers.profileUrl,
    })
    .from(publisherSessions)
    .innerJoin(publishers, eq(publishers.githubUserId, publisherSessions.githubUserId))
    .where(
      and(
        eq(publisherSessions.tokenHash, await tokenHash(session)),
        gte(publisherSessions.expiresAt, now),
        eq(publishers.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    displayName: row.displayName,
    githubUserId: row.githubUserId,
    namespace: row.namespace,
    ...(row.profileUrl === null ? {} : { profileUrl: row.profileUrl }),
  };
}

export async function endPublisherSession(
  context: Context<{ Bindings: RegistryEnv }>,
): Promise<void> {
  const session = getCookie(context, SESSION_COOKIE);
  if (session && session.length <= 128) {
    await registryDatabase(context.env.REGISTRY_DB)
      .delete(publisherSessions)
      .where(eq(publisherSessions.tokenHash, await tokenHash(session)));
  }
  deleteCookie(context, SESSION_COOKIE, {
    path: publicRegistryPath(context.env, "/"),
    secure: true,
  });
}
