import { OWNER_READ_SCOPE, ownerKeySchema } from "@crewhelm/contracts";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { jwt } from "better-auth/plugins/jwt";
import { and, eq, gt } from "drizzle-orm/sql/expressions/conditions";
import { drizzle } from "drizzle-orm/d1";
import * as z from "zod";

import { authSchema, mcpTokenRevocation } from "./auth-schema.js";
import type { WorkerEnv } from "./env.js";
import { deriveOwnerKey } from "./owner-identity.js";

const GITHUB_ISSUER = "https://github.com";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const MAX_GITHUB_RESPONSE_BYTES = 16 * 1024;
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_BASE_PATH = "/api/auth";

type AuthorizationFailureStage =
  | "better_auth"
  | "github_owner_mismatch"
  | "github_token_body"
  | "github_token_payload"
  | "github_token_request"
  | "github_token_response"
  | "github_user_body"
  | "github_user_payload"
  | "github_user_request"
  | "github_user_response"
  | "github_user_token";

const configurationSchema = z.strictObject({
  BETTER_AUTH_SECRET: z.string().min(32).max(1_024),
  GITHUB_CLIENT_ID: z.string().min(1).max(255),
  GITHUB_CLIENT_SECRET: z.string().min(1).max(1_024),
  OWNER_GITHUB_USER_ID: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const githubUserSchema = z.looseObject({
  id: z.number().int().positive().safe(),
});
const githubTokenSchema = z.looseObject({
  access_token: z.string().min(1).max(4_096),
  scope: z.literal("").optional(),
  token_type: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.toLowerCase() === "bearer"),
});
const storedAccountSchema = z.looseObject({
  accessToken: z.unknown().optional(),
  accessTokenExpiresAt: z.unknown().optional(),
  idToken: z.unknown().optional(),
  refreshToken: z.unknown().optional(),
  refreshTokenExpiresAt: z.unknown().optional(),
});
const accessTokenClaimsSchema = z.looseObject({
  azp: z.string().min(1).max(2_048),
  exp: z.number().int().positive(),
  scope: z.literal(OWNER_READ_SCOPE),
  sub: ownerKeySchema,
});

export type CrewhelmAuth = ReturnType<typeof createCrewhelmAuth>;

function logAuthorizationFailure(stage: AuthorizationFailureStage): void {
  console.error("crewhelm.authorization_unavailable", { stage });
}

function isBetterAuthPlugin(plugin: unknown): plugin is BetterAuthPlugin {
  return (
    typeof plugin === "object" &&
    plugin !== null &&
    Reflect.get(plugin, "id") === "oauth-provider" &&
    typeof Reflect.get(plugin, "endpoints") === "object"
  );
}

async function accessTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  let binary = "";

  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function authBaseUrl(origin: string): string {
  return `${origin}${AUTH_BASE_PATH}`;
}

function mcpResourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null) {
    const length = Number(declaredLength);

    if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
      return null;
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytesRead = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      body += decoder.decode();
      return body;
    }

    bytesRead += value.byteLength;

    if (bytesRead > maximumBytes) {
      await reader.cancel();
      return null;
    }

    body += decoder.decode(value, { stream: true });
  }
}

async function readGithubOwner(
  accessToken: string,
  ownerGithubUserId: string,
): Promise<{ ownerKey: string } | null> {
  let response: Response;

  try {
    response = await fetch(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "crewhelm-worker",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    logAuthorizationFailure("github_user_request");
    return null;
  }

  if (!response.ok) {
    logAuthorizationFailure("github_user_response");
    return null;
  }

  let rawBody: string | null;

  try {
    rawBody = await readBoundedResponseBody(response, MAX_GITHUB_RESPONSE_BYTES);
  } catch {
    logAuthorizationFailure("github_user_body");
    return null;
  }

  if (rawBody === null) {
    logAuthorizationFailure("github_user_body");
    return null;
  }

  let body: unknown;

  try {
    body = JSON.parse(rawBody);
  } catch {
    logAuthorizationFailure("github_user_payload");
    return null;
  }

  const result = githubUserSchema.safeParse(body);

  if (!result.success) {
    logAuthorizationFailure("github_user_payload");
    return null;
  }

  if (String(result.data.id) !== ownerGithubUserId) {
    logAuthorizationFailure("github_owner_mismatch");
    return null;
  }

  return {
    ownerKey: await deriveOwnerKey({
      issuer: GITHUB_ISSUER,
      subject: ownerGithubUserId,
    }),
  };
}

export async function exchangeGithubAuthorizationCode(
  configuration: Pick<
    z.infer<typeof configurationSchema>,
    "GITHUB_CLIENT_ID" | "GITHUB_CLIENT_SECRET"
  >,
  input: {
    code: string;
    codeVerifier?: string | undefined;
    redirectURI: string;
  },
): Promise<{
  accessToken: string;
  scopes: string[];
  tokenType: string;
}> {
  const body = new URLSearchParams({
    client_id: configuration.GITHUB_CLIENT_ID,
    client_secret: configuration.GITHUB_CLIENT_SECRET,
    code: input.code,
    redirect_uri: input.redirectURI,
  });

  if (input.codeVerifier !== undefined) {
    body.set("code_verifier", input.codeVerifier);
  }

  let response: Response;

  try {
    response = await fetch(GITHUB_TOKEN_URL, {
      body,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    logAuthorizationFailure("github_token_request");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  if (!response.ok) {
    logAuthorizationFailure("github_token_response");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  let rawBody: string | null;

  try {
    rawBody = await readBoundedResponseBody(response, MAX_GITHUB_RESPONSE_BYTES);
  } catch {
    logAuthorizationFailure("github_token_body");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  if (rawBody === null) {
    logAuthorizationFailure("github_token_body");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    logAuthorizationFailure("github_token_payload");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  const result = githubTokenSchema.safeParse(payload);

  if (!result.success) {
    logAuthorizationFailure("github_token_payload");
    throw new Error("GitHub OAuth token exchange failed.");
  }

  return {
    accessToken: result.data.access_token,
    scopes: [],
    tokenType: result.data.token_type,
  };
}

function stripUpstreamTokens<T>(account: T): T {
  const parsed = storedAccountSchema.safeParse(account);

  if (!parsed.success) {
    throw new Error("Upstream account persistence denied.");
  }

  return {
    ...account,
    accessToken: null,
    accessTokenExpiresAt: null,
    idToken: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
  };
}

export function createCrewhelmAuth(env: WorkerEnv, origin: string) {
  const configuration = configurationSchema.parse({
    BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    GITHUB_CLIENT_ID: env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
    OWNER_GITHUB_USER_ID: env.OWNER_GITHUB_USER_ID,
  });
  const database = drizzle(env.AUTH_DB, { schema: authSchema });

  return betterAuth({
    account: {
      updateAccountOnSignIn: false,
    },
    advanced: {
      cookiePrefix: "crewhelm",
      useSecureCookies: true,
    },
    basePath: AUTH_BASE_PATH,
    baseURL: origin,
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: authSchema,
    }),
    databaseHooks: {
      account: {
        create: {
          before: async (account) => ({ data: stripUpstreamTokens(account) }),
        },
        update: {
          before: async (account) => ({ data: stripUpstreamTokens(account) }),
        },
      },
      user: {
        create: {
          before: async (candidate) => {
            const ownerKey = await deriveOwnerKey({
              issuer: GITHUB_ISSUER,
              subject: configuration.OWNER_GITHUB_USER_ID,
            });
            const expectedSyntheticEmail = `${ownerKey}@identity.invalid`.toLowerCase();

            if (candidate.email !== expectedSyntheticEmail) {
              return false;
            }

            return {
              data: {
                ...candidate,
                id: ownerKey,
                ownerKey,
              },
            };
          },
        },
      },
    },
    logger: {
      level: "error",
      log: () => {
        logAuthorizationFailure("better_auth");
      },
    },
    onAPIError: {
      errorURL: "/oauth/error",
      throw: true,
    },
    plugins: [
      jwt(),
      genericOAuth({
        config: [
          {
            authorizationUrl: GITHUB_AUTHORIZE_URL,
            clientId: configuration.GITHUB_CLIENT_ID,
            clientSecret: configuration.GITHUB_CLIENT_SECRET,
            getToken: (input) => exchangeGithubAuthorizationCode(configuration, input),
            getUserInfo: async (tokens) => {
              if (typeof tokens.accessToken !== "string" || tokens.accessToken.length > 4_096) {
                logAuthorizationFailure("github_user_token");
                return null;
              }

              const owner = await readGithubOwner(
                tokens.accessToken,
                configuration.OWNER_GITHUB_USER_ID,
              );

              if (owner === null) {
                return null;
              }

              return {
                email: `${owner.ownerKey}@identity.invalid`,
                emailVerified: false,
                id: owner.ownerKey,
                name: "Crewhelm owner",
              };
            },
            name: "GitHub",
            providerId: "github",
            scopes: [],
          },
        ],
      }),
      (() => {
        // beta.10's OpenAPI declaration makes optional schema.items incompatible with
        // Better Auth's exact-optional plugin type. Validate the runtime seam instead;
        // the complete OAuth integration test exercises the resulting plugin.
        const provider = oauthProvider({
          accessTokenExpiresIn: 15 * 60,
          allowDynamicClientRegistration: true,
          allowPublicClientPrelogin: true,
          allowUnauthenticatedClientRegistration: true,
          clientRegistrationAllowedScopes: [OWNER_READ_SCOPE],
          clientRegistrationDefaultScopes: [OWNER_READ_SCOPE],
          codeExpiresIn: 10 * 60,
          consentPage: "/oauth/consent",
          customAccessTokenClaims: async ({ resources, scopes, user }) => {
            const expectedOwnerKey = await deriveOwnerKey({
              issuer: GITHUB_ISSUER,
              subject: configuration.OWNER_GITHUB_USER_ID,
            });

            if (
              user?.id !== expectedOwnerKey ||
              resources?.length !== 1 ||
              resources[0] !== mcpResourceUrl(origin) ||
              scopes.length !== 1 ||
              scopes[0] !== OWNER_READ_SCOPE
            ) {
              throw new Error("Access token authority denied.");
            }

            return {};
          },
          grantTypes: ["authorization_code"],
          loginPage: "/oauth/login",
          resources: [
            {
              accessTokenTtl: 15 * 60,
              allowedScopes: [OWNER_READ_SCOPE],
              identifier: mcpResourceUrl(origin),
              name: "Crewhelm MCP",
            },
          ],
          resourceSeedMode: "insertOnly",
          scopes: [OWNER_READ_SCOPE],
          silenceWarnings: {
            oauthAuthServerConfig: true,
          },
        });

        if (!isBetterAuthPlugin(provider)) {
          throw new Error("Better Auth OAuth provider compatibility check failed.");
        }

        return provider;
      })(),
    ],
    rateLimit: {
      enabled: false,
    },
    secret: configuration.BETTER_AUTH_SECRET,
    session: {
      disableSessionRefresh: true,
      expiresIn: 10 * 60,
    },
    telemetry: {
      enabled: false,
    },
    trustedOrigins: [origin],
    user: {
      additionalFields: {
        ownerKey: {
          input: false,
          required: false,
          type: "string",
        },
      },
    },
  });
}

async function verifyMcpAccessTokenSignature(
  auth: CrewhelmAuth,
  origin: string,
  token: string,
): Promise<z.infer<typeof accessTokenClaimsSchema> | null> {
  try {
    const claims = await verifyJwsAccessToken(token, {
      jwksFetch: async () => {
        const response = await auth.handler(
          new Request(`${origin}${AUTH_BASE_PATH}/jwks`, {
            headers: {
              accept: "application/json",
            },
          }),
        );

        if (!response.ok) {
          return undefined;
        }

        return response.json();
      },
      verifyOptions: {
        audience: mcpResourceUrl(origin),
        issuer: authBaseUrl(origin),
      },
    });
    const result = accessTokenClaimsSchema.safeParse(claims);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function revokeMcpAccessToken(
  env: Pick<WorkerEnv, "AUTH_DB">,
  auth: CrewhelmAuth,
  origin: string,
  token: string,
  clientId: string,
): Promise<void> {
  const claims = await verifyMcpAccessTokenSignature(auth, origin, token);

  if (claims === null || claims.azp !== clientId) {
    return;
  }

  const now = new Date();
  const expiresAt = new Date(claims.exp * 1_000);

  if (expiresAt <= now) {
    return;
  }

  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  await database
    .insert(mcpTokenRevocation)
    .values({
      tokenHash: await accessTokenHash(token),
      createdAt: now,
      expiresAt,
    })
    .onConflictDoNothing();
}

export async function verifyMcpAccessToken(
  env: Pick<WorkerEnv, "AUTH_DB">,
  auth: CrewhelmAuth,
  origin: string,
  token: string,
): Promise<z.infer<typeof accessTokenClaimsSchema> | null> {
  const claims = await verifyMcpAccessTokenSignature(auth, origin, token);

  if (claims === null) {
    return null;
  }

  const database = drizzle(env.AUTH_DB, { schema: authSchema });
  const revocations = await database
    .select({ tokenHash: mcpTokenRevocation.tokenHash })
    .from(mcpTokenRevocation)
    .where(
      and(
        eq(mcpTokenRevocation.tokenHash, await accessTokenHash(token)),
        gt(mcpTokenRevocation.expiresAt, new Date()),
      ),
    )
    .limit(1);

  return revocations.length === 0 ? claims : null;
}
