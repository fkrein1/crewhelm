import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  selectClientAuthMethod,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  type AuthorizationServerMetadata,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { remoteMcpOAuthScopesSchema } from "@crewhelm/contracts";
import * as z from "zod";

import { normalizeRemoteMcpEndpoint, normalizeRemoteMcpPublicHttpsUrl } from "./client.js";

const MAXIMUM_OAUTH_RESPONSE_BYTES = 64 * 1_024;
const MAXIMUM_OAUTH_REDIRECTS = 3;
const MAXIMUM_OAUTH_TOKEN_CHARACTERS = 8 * 1_024;
const OAUTH_EXPIRY_SKEW_MS = 60_000;

const oauthClientInformationSchema = z.union([
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
]);
const authorizationServerMetadataSchema = z.union([
  OAuthMetadataSchema,
  OpenIdProviderDiscoveryMetadataSchema,
]);
const authorizationServerMetadataExtensionsSchema = z.object({
  revocation_endpoint: z.url().optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});
const storedTokensSchema = z.strictObject({
  accessToken: z.string().min(1).max(MAXIMUM_OAUTH_TOKEN_CHARACTERS),
  expiresAt: z.number().int().positive().safe().nullable(),
  refreshToken: z.string().min(1).max(MAXIMUM_OAUTH_TOKEN_CHARACTERS).optional(),
  tokenType: z.literal("Bearer"),
});
export const remoteMcpOAuthAuthorizationSchema = z.strictObject({
  authorizationServerMetadata: authorizationServerMetadataSchema,
  authorizationServerUrl: z.url().max(2_048),
  clientInformation: oauthClientInformationSchema,
  codeVerifier: z.string().min(43).max(128),
  requestedScopes: remoteMcpOAuthScopesSchema,
  resource: z.url().max(2_048).optional(),
  version: z.literal(1),
});
export const remoteMcpOAuthCredentialSchema = remoteMcpOAuthAuthorizationSchema
  .omit({ codeVerifier: true })
  .extend({
    grantedScopes: remoteMcpOAuthScopesSchema,
    tokens: storedTokensSchema,
  });

export type RemoteMcpOAuthAuthorization = z.infer<typeof remoteMcpOAuthAuthorizationSchema>;
export type RemoteMcpOAuthCredential = z.infer<typeof remoteMcpOAuthCredentialSchema>;

export class RemoteMcpOAuthError extends Error {
  readonly code:
    | "authorization_denied"
    | "authentication_required"
    | "invalid_authorization_server"
    | "invalid_client_registration"
    | "invalid_scope"
    | "invalid_token_response"
    | "oauth_request_failed";

  constructor(code: RemoteMcpOAuthError["code"]) {
    super(`Remote MCP OAuth request failed: ${code}.`);
    this.name = "RemoteMcpOAuthError";
    this.code = code;
  }
}

function boundedResponse(response: Response): Response {
  const length = response.headers.get("content-length");
  if (length !== null) {
    const parsed = Number(length);
    if (Number.isFinite(parsed) && parsed > MAXIMUM_OAUTH_RESPONSE_BYTES) {
      throw new RemoteMcpOAuthError("oauth_request_failed");
    }
  }
  if (response.body === null) return response;

  let received = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > MAXIMUM_OAUTH_RESPONSE_BYTES) {
          throw new RemoteMcpOAuthError("oauth_request_failed");
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function oauthFetch(input: {
  allowedPosts: ReadonlySet<string>;
  fetchImplementation: typeof fetch;
  signal: AbortSignal;
}): typeof fetch {
  return async (requestInput, init) => {
    const method = (init?.method ?? (requestInput instanceof Request ? requestInput.method : "GET"))
      .toUpperCase()
      .trim();
    let requestUrl = normalizeRemoteMcpPublicHttpsUrl(
      requestInput instanceof Request
        ? requestInput.url
        : requestInput instanceof URL
          ? requestInput.toString()
          : requestInput,
      { allowQuery: true },
    );
    const isMetadataRead = method === "GET" || method === "HEAD";
    if (!isMetadataRead && (method !== "POST" || !input.allowedPosts.has(requestUrl))) {
      throw new RemoteMcpOAuthError("oauth_request_failed");
    }

    for (let redirects = 0; ; redirects += 1) {
      const response = await input.fetchImplementation(requestUrl, {
        ...init,
        method,
        redirect: "manual",
        signal: AbortSignal.any([input.signal, ...(init?.signal == null ? [] : [init.signal])]),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return boundedResponse(response);
      }

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!isMetadataRead || redirects >= MAXIMUM_OAUTH_REDIRECTS || location === null) {
        throw new RemoteMcpOAuthError("oauth_request_failed");
      }
      const redirected = normalizeRemoteMcpPublicHttpsUrl(
        new URL(location, requestUrl).toString(),
        {
          allowQuery: true,
        },
      );
      if (new URL(redirected).origin !== new URL(requestUrl).origin) {
        throw new RemoteMcpOAuthError("oauth_request_failed");
      }
      requestUrl = redirected;
    }
  };
}

function exactAuthorizationServerMetadata(input: {
  endpoint: string;
  metadata: AuthorizationServerMetadata | undefined;
  resourceMetadata:
    | {
        authorization_servers?: string[] | undefined;
        resource: string;
        scopes_supported?: string[] | undefined;
      }
    | undefined;
  serverUrl: string;
}): {
  authorizationServerMetadata: AuthorizationServerMetadata;
  authorizationServerUrl: string;
  resource?: string;
} {
  if (input.metadata === undefined) {
    throw new RemoteMcpOAuthError("invalid_authorization_server");
  }
  const metadata = authorizationServerMetadataSchema.parse(input.metadata);
  const authorizationServerUrl = normalizeRemoteMcpPublicHttpsUrl(input.serverUrl, {
    allowQuery: false,
  });
  const issuer = normalizeRemoteMcpPublicHttpsUrl(metadata.issuer, { allowQuery: false });
  if (issuer !== authorizationServerUrl) {
    throw new RemoteMcpOAuthError("invalid_authorization_server");
  }
  if (
    !metadata.response_types_supported.includes("code") ||
    (metadata.grant_types_supported !== undefined &&
      !metadata.grant_types_supported.includes("authorization_code")) ||
    (metadata.code_challenge_methods_supported !== undefined &&
      !metadata.code_challenge_methods_supported.includes("S256"))
  ) {
    throw new RemoteMcpOAuthError("invalid_authorization_server");
  }

  const serverOrigin = new URL(authorizationServerUrl).origin;
  const extensions = authorizationServerMetadataExtensionsSchema.parse(metadata);
  for (const value of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
    extensions.revocation_endpoint,
  ]) {
    if (value === undefined) continue;
    const normalized = normalizeRemoteMcpPublicHttpsUrl(value, { allowQuery: true });
    if (new URL(normalized).origin !== serverOrigin) {
      throw new RemoteMcpOAuthError("invalid_authorization_server");
    }
  }

  if ((input.resourceMetadata?.authorization_servers?.length ?? 0) > 1) {
    throw new RemoteMcpOAuthError("invalid_authorization_server");
  }
  const expectedResource = resourceUrlFromServerUrl(input.endpoint);
  let resource: string | undefined;
  if (input.resourceMetadata !== undefined) {
    const configured = normalizeRemoteMcpPublicHttpsUrl(input.resourceMetadata.resource, {
      allowQuery: true,
    });
    if (
      !checkResourceAllowed({ configuredResource: configured, requestedResource: expectedResource })
    ) {
      throw new RemoteMcpOAuthError("invalid_authorization_server");
    }
    resource = configured;
  }

  return {
    authorizationServerMetadata: metadata,
    authorizationServerUrl,
    ...(resource === undefined ? {} : { resource }),
  };
}

function validateScopes(
  requestedScopes: string[],
  supportedScopes: string[] | undefined,
): string[] {
  const scopes = remoteMcpOAuthScopesSchema.parse(requestedScopes);
  if (supportedScopes !== undefined && scopes.some((scope) => !supportedScopes.includes(scope))) {
    throw new RemoteMcpOAuthError("invalid_scope");
  }
  return scopes;
}

function clientMetadata(input: {
  clientMetadataUrl: string;
  redirectUrl: string;
  requestedScopes: string[];
}): OAuthClientMetadata {
  return {
    client_name: "Crewhelm",
    client_uri: new URL(input.clientMetadataUrl).origin,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [input.redirectUrl],
    response_types: ["code"],
    ...(input.requestedScopes.length === 0 ? {} : { scope: input.requestedScopes.join(" ") }),
    software_id: "crewhelm",
    software_version: "1",
    token_endpoint_auth_method: "none",
  };
}

function validateClientInformation(
  value: OAuthClientInformationMixed,
  redirectUrl: string,
): OAuthClientInformationMixed {
  const client = oauthClientInformationSchema.parse(value);
  if (
    client.client_id.length > 2_048 ||
    (client.client_secret?.length ?? 0) > MAXIMUM_OAUTH_TOKEN_CHARACTERS ||
    ("redirect_uris" in client &&
      (client.redirect_uris.length !== 1 || client.redirect_uris[0] !== redirectUrl))
  ) {
    throw new RemoteMcpOAuthError("invalid_client_registration");
  }
  return client;
}

function authorizationUrl(input: {
  expectedClientId: string;
  expectedEndpoint: string;
  expectedRedirectUrl: string;
  expectedResource?: string;
  expectedScopes: string[];
  expectedState: string;
  value: URL;
}): string {
  const normalized = normalizeRemoteMcpPublicHttpsUrl(input.value.toString(), { allowQuery: true });
  const url = new URL(normalized);
  if (
    `${url.origin}${url.pathname}` !== input.expectedEndpoint ||
    url.searchParams.get("client_id") !== input.expectedClientId ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.get("redirect_uri") !== input.expectedRedirectUrl ||
    url.searchParams.get("state") !== input.expectedState ||
    url.searchParams.get("code_challenge_method") !== "S256" ||
    (url.searchParams.get("code_challenge")?.length ?? 0) < 43 ||
    (input.expectedResource === undefined
      ? url.searchParams.has("resource")
      : url.searchParams.get("resource") !== input.expectedResource) ||
    (input.expectedScopes.length === 0
      ? url.searchParams.has("scope")
      : url.searchParams.get("scope") !== input.expectedScopes.join(" "))
  ) {
    throw new RemoteMcpOAuthError("invalid_authorization_server");
  }
  return normalized;
}

function normalizedTokens(input: {
  allowedScopes: string[] | undefined;
  issuedAt: number;
  tokens: OAuthTokens;
}): { grantedScopes: string[]; tokens: z.infer<typeof storedTokensSchema> } {
  const tokens = OAuthTokensSchema.parse(input.tokens);
  if (tokens.token_type.toLowerCase() !== "bearer") {
    throw new RemoteMcpOAuthError("invalid_token_response");
  }
  const grantedScopes = remoteMcpOAuthScopesSchema.parse(
    tokens.scope === undefined
      ? (input.allowedScopes ?? [])
      : tokens.scope
          .split(" ")
          .filter((scope) => scope.length > 0)
          .toSorted(),
  );
  if (
    input.allowedScopes !== undefined &&
    grantedScopes.some((scope) => !input.allowedScopes?.includes(scope))
  ) {
    throw new RemoteMcpOAuthError("invalid_scope");
  }
  if (
    tokens.access_token.length > MAXIMUM_OAUTH_TOKEN_CHARACTERS ||
    (tokens.refresh_token?.length ?? 0) > MAXIMUM_OAUTH_TOKEN_CHARACTERS ||
    (tokens.expires_in !== undefined &&
      (!Number.isSafeInteger(tokens.expires_in) ||
        tokens.expires_in <= 0 ||
        tokens.expires_in > 31_536_000))
  ) {
    throw new RemoteMcpOAuthError("invalid_token_response");
  }
  return {
    grantedScopes,
    tokens: storedTokensSchema.parse({
      accessToken: tokens.access_token,
      expiresAt:
        tokens.expires_in === undefined ? null : input.issuedAt + tokens.expires_in * 1_000,
      ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
      tokenType: "Bearer",
    }),
  };
}

export async function beginRemoteMcpOAuthAuthorization(input: {
  clientInformation?: OAuthClientInformationMixed;
  clientMetadataUrl: string;
  endpoint: string;
  fetchImplementation?: typeof fetch;
  redirectUrl: string;
  requestedScopes: string[];
  signal: AbortSignal;
  state: string;
}): Promise<{ authorization: RemoteMcpOAuthAuthorization; authorizationUrl: string }> {
  const endpoint = normalizeRemoteMcpEndpoint(input.endpoint);
  const redirectUrl = normalizeRemoteMcpPublicHttpsUrl(input.redirectUrl, { allowQuery: false });
  const clientMetadataUrl = normalizeRemoteMcpPublicHttpsUrl(input.clientMetadataUrl, {
    allowQuery: false,
  });
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const discovery = await discoverOAuthServerInfo(endpoint, {
    fetchFn: oauthFetch({ allowedPosts: new Set(), fetchImplementation, signal: input.signal }),
  });
  const exact = exactAuthorizationServerMetadata({
    endpoint,
    metadata: discovery.authorizationServerMetadata,
    resourceMetadata: discovery.resourceMetadata,
    serverUrl: discovery.authorizationServerUrl,
  });
  const scopes = validateScopes(
    input.requestedScopes,
    discovery.resourceMetadata?.scopes_supported,
  );
  const metadata = clientMetadata({ clientMetadataUrl, redirectUrl, requestedScopes: scopes });
  let clientInformation = input.clientInformation;
  if (clientInformation === undefined) {
    if (exact.authorizationServerMetadata.client_id_metadata_document_supported === true) {
      clientInformation = { client_id: clientMetadataUrl };
    } else {
      const registrationEndpoint = exact.authorizationServerMetadata.registration_endpoint;
      if (registrationEndpoint === undefined) {
        throw new RemoteMcpOAuthError("invalid_client_registration");
      }
      clientInformation = await registerClient(exact.authorizationServerUrl, {
        clientMetadata: metadata,
        fetchFn: oauthFetch({
          allowedPosts: new Set([
            normalizeRemoteMcpPublicHttpsUrl(registrationEndpoint, { allowQuery: true }),
          ]),
          fetchImplementation,
          signal: input.signal,
        }),
        metadata: exact.authorizationServerMetadata,
        ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
      });
    }
  }
  const validatedClient = validateClientInformation(clientInformation, redirectUrl);
  const started = await startAuthorization(exact.authorizationServerUrl, {
    clientInformation: validatedClient,
    metadata: exact.authorizationServerMetadata,
    redirectUrl,
    ...(exact.resource === undefined ? {} : { resource: new URL(exact.resource) }),
    ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }),
    state: input.state,
  });
  return {
    authorization: remoteMcpOAuthAuthorizationSchema.parse({
      authorizationServerMetadata: exact.authorizationServerMetadata,
      authorizationServerUrl: exact.authorizationServerUrl,
      clientInformation: validatedClient,
      codeVerifier: started.codeVerifier,
      requestedScopes: scopes,
      ...(exact.resource === undefined ? {} : { resource: exact.resource }),
      version: 1,
    }),
    authorizationUrl: authorizationUrl({
      expectedClientId: validatedClient.client_id,
      expectedEndpoint: `${new URL(exact.authorizationServerMetadata.authorization_endpoint).origin}${new URL(exact.authorizationServerMetadata.authorization_endpoint).pathname}`,
      expectedRedirectUrl: redirectUrl,
      ...(exact.resource === undefined ? {} : { expectedResource: exact.resource }),
      expectedScopes: scopes,
      expectedState: input.state,
      value: started.authorizationUrl,
    }),
  };
}

export async function completeRemoteMcpOAuthAuthorization(input: {
  authorization: RemoteMcpOAuthAuthorization;
  authorizationCode: string;
  fetchImplementation?: typeof fetch;
  redirectUrl: string;
  signal: AbortSignal;
}): Promise<RemoteMcpOAuthCredential> {
  const authorization = remoteMcpOAuthAuthorizationSchema.parse(input.authorization);
  if (!/^[\x21-\x7e]{1,4096}$/.test(input.authorizationCode)) {
    throw new RemoteMcpOAuthError("authorization_denied");
  }
  const tokenEndpoint = normalizeRemoteMcpPublicHttpsUrl(
    authorization.authorizationServerMetadata.token_endpoint,
    { allowQuery: true },
  );
  const tokens = await exchangeAuthorization(authorization.authorizationServerUrl, {
    authorizationCode: input.authorizationCode,
    clientInformation: authorization.clientInformation,
    codeVerifier: authorization.codeVerifier,
    fetchFn: oauthFetch({
      allowedPosts: new Set([tokenEndpoint]),
      fetchImplementation: input.fetchImplementation ?? fetch,
      signal: input.signal,
    }),
    metadata: authorization.authorizationServerMetadata,
    redirectUri: normalizeRemoteMcpPublicHttpsUrl(input.redirectUrl, { allowQuery: false }),
    ...(authorization.resource === undefined ? {} : { resource: new URL(authorization.resource) }),
  });
  const normalized = normalizedTokens({
    allowedScopes:
      authorization.requestedScopes.length === 0 ? undefined : authorization.requestedScopes,
    issuedAt: Date.now(),
    tokens,
  });
  return remoteMcpOAuthCredentialSchema.parse({
    authorizationServerMetadata: authorization.authorizationServerMetadata,
    authorizationServerUrl: authorization.authorizationServerUrl,
    clientInformation: authorization.clientInformation,
    grantedScopes: normalized.grantedScopes,
    requestedScopes: authorization.requestedScopes,
    ...(authorization.resource === undefined ? {} : { resource: authorization.resource }),
    tokens: normalized.tokens,
    version: 1,
  });
}

export async function refreshRemoteMcpOAuthCredential(input: {
  credential: RemoteMcpOAuthCredential;
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
}): Promise<RemoteMcpOAuthCredential> {
  const credential = remoteMcpOAuthCredentialSchema.parse(input.credential);
  if (credential.tokens.refreshToken === undefined) {
    throw new RemoteMcpOAuthError("authentication_required");
  }
  const tokenEndpoint = normalizeRemoteMcpPublicHttpsUrl(
    credential.authorizationServerMetadata.token_endpoint,
    { allowQuery: true },
  );
  let refreshed: OAuthTokens;
  try {
    refreshed = await refreshAuthorization(credential.authorizationServerUrl, {
      clientInformation: credential.clientInformation,
      fetchFn: oauthFetch({
        allowedPosts: new Set([tokenEndpoint]),
        fetchImplementation: input.fetchImplementation ?? fetch,
        signal: input.signal,
      }),
      metadata: credential.authorizationServerMetadata,
      refreshToken: credential.tokens.refreshToken,
      ...(credential.resource === undefined ? {} : { resource: new URL(credential.resource) }),
    });
  } catch {
    throw new RemoteMcpOAuthError("authentication_required");
  }
  const normalized = normalizedTokens({
    allowedScopes: credential.grantedScopes,
    issuedAt: Date.now(),
    tokens: refreshed,
  });
  return remoteMcpOAuthCredentialSchema.parse({
    ...credential,
    grantedScopes:
      normalized.grantedScopes.length === 0 ? credential.grantedScopes : normalized.grantedScopes,
    tokens: normalized.tokens,
  });
}

export function remoteMcpOAuthAccessToken(
  credential: RemoteMcpOAuthCredential,
  currentTime = Date.now(),
): string | null {
  const parsed = remoteMcpOAuthCredentialSchema.parse(credential);
  return parsed.tokens.expiresAt === null ||
    parsed.tokens.expiresAt > currentTime + OAUTH_EXPIRY_SKEW_MS
    ? parsed.tokens.accessToken
    : null;
}

function applyRevocationClientAuthentication(input: {
  clientInformation: OAuthClientInformationMixed;
  headers: Headers;
  metadata: AuthorizationServerMetadata;
  parameters: URLSearchParams;
}): void {
  const methods =
    authorizationServerMetadataExtensionsSchema.parse(input.metadata)
      .revocation_endpoint_auth_methods_supported ??
    input.metadata.token_endpoint_auth_methods_supported ??
    [];
  const method = selectClientAuthMethod(input.clientInformation, methods);
  if (method === "client_secret_basic") {
    if (input.clientInformation.client_secret === undefined) {
      throw new RemoteMcpOAuthError("oauth_request_failed");
    }
    input.headers.set(
      "authorization",
      `Basic ${btoa(`${input.clientInformation.client_id}:${input.clientInformation.client_secret}`)}`,
    );
  } else {
    input.parameters.set("client_id", input.clientInformation.client_id);
    if (method === "client_secret_post" && input.clientInformation.client_secret !== undefined) {
      input.parameters.set("client_secret", input.clientInformation.client_secret);
    }
  }
}

export async function revokeRemoteMcpOAuthCredential(input: {
  credential: RemoteMcpOAuthCredential;
  fetchImplementation?: typeof fetch;
  signal: AbortSignal;
}): Promise<"confirmed" | "not_supported" | "unconfirmed"> {
  const credential = remoteMcpOAuthCredentialSchema.parse(input.credential);
  const revocationEndpoint = authorizationServerMetadataExtensionsSchema.parse(
    credential.authorizationServerMetadata,
  ).revocation_endpoint;
  if (revocationEndpoint === undefined) return "not_supported";
  const endpoint = normalizeRemoteMcpPublicHttpsUrl(revocationEndpoint, { allowQuery: true });
  const tokens = [
    ...(credential.tokens.refreshToken === undefined
      ? []
      : [{ token: credential.tokens.refreshToken, type: "refresh_token" }]),
    { token: credential.tokens.accessToken, type: "access_token" },
  ];

  try {
    for (const token of tokens) {
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      });
      const parameters = new URLSearchParams({ token: token.token, token_type_hint: token.type });
      applyRevocationClientAuthentication({
        clientInformation: credential.clientInformation,
        headers,
        metadata: credential.authorizationServerMetadata,
        parameters,
      });
      const response = await oauthFetch({
        allowedPosts: new Set([endpoint]),
        fetchImplementation: input.fetchImplementation ?? fetch,
        signal: input.signal,
      })(endpoint, { body: parameters, headers, method: "POST" });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) return "unconfirmed";
    }
    return "confirmed";
  } catch {
    return "unconfirmed";
  }
}
