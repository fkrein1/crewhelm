import {
  createRemoteMcpConnectionInputSchema,
  ownerKeySchema,
  remoteMcpEndpointSchema,
  remoteMcpConnectionNameSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

export const REMOTE_MCP_BEARER_SETUP_PATH_PREFIX = "/connections/remote-mcp/setup/";
export const REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX = "/connections/remote-mcp/oauth/setup/";
export const REMOTE_MCP_OAUTH_CALLBACK_PATH = "/connections/remote-mcp/oauth/callback";
export const REMOTE_MCP_OAUTH_CLIENT_METADATA_PATH = "/.well-known/oauth-client/crewhelm";
const BEARER_HANDOFF_VERSION = "crewhelm.remote-mcp-bearer-setup.v1";
const OAUTH_SETUP_VERSION = "crewhelm.remote-mcp-oauth-setup.v1";
const OAUTH_STATE_VERSION = "crewhelm.remote-mcp-oauth-state.v1";
const encoder = new TextEncoder();
const publicOriginSchema = z
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:" && new URL(value).origin === value);
const signingSecretSchema = z.string().min(32).max(1_024);
const claimsSchema = z.strictObject({
  endpoint: remoteMcpEndpointSchema,
  expiresAt: z.number().int().positive().safe(),
  idempotencyKey: createRemoteMcpConnectionInputSchema.shape.idempotencyKey,
  name: remoteMcpConnectionNameSchema,
  ownerKey: ownerKeySchema,
});
const oauthClaimsSchema = z.strictObject({
  expiresAt: z.number().int().positive().safe(),
  ownerKey: ownerKeySchema,
  requestId: z
    .string()
    .regex(
      /^remote_mcp_oauth_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
});

export type RemoteMcpBearerSetupClaims = z.infer<typeof claimsSchema>;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

function payload(version: string, claims: unknown): string {
  return JSON.stringify([version, claims]);
}

async function signClaims(input: {
  claims: unknown;
  signingSecret: string;
  version: string;
}): Promise<{ encodedClaims: string; signature: string }> {
  const secret = signingSecretSchema.parse(input.signingSecret);
  const encodedClaims = encodeBase64Url(encoder.encode(JSON.stringify(input.claims)));
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        encoder.encode(payload(input.version, input.claims)),
      ),
    ),
  );
  return { encodedClaims, signature };
}

async function readClaims<T extends { expiresAt: number }>(input: {
  encodedClaims: string;
  schema: z.ZodType<T>;
  signature: string;
  signingSecret: unknown;
  version: string;
}): Promise<T | null> {
  const secret = signingSecretSchema.safeParse(input.signingSecret);
  if (!secret.success || !/^[A-Za-z0-9_-]{1,4096}$/.test(input.encodedClaims)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.signature)) return null;

  try {
    const decodedClaims = decodeBase64Url(input.encodedClaims);
    const decodedSignature = decodeBase64Url(input.signature);
    if (
      encodeBase64Url(decodedClaims) !== input.encodedClaims ||
      encodeBase64Url(decodedSignature) !== input.signature
    ) {
      return null;
    }
    const claims = input.schema.parse(JSON.parse(new TextDecoder().decode(decodedClaims)));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret.data),
      decodedSignature,
      encoder.encode(payload(input.version, claims)),
    );
    return valid && claims.expiresAt > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

export async function createRemoteMcpBearerSetup(input: {
  claims: RemoteMcpBearerSetupClaims;
  origin: string;
  signingSecret: string;
}): Promise<{ expiresAt: string; url: string }> {
  const claims = claimsSchema.parse(input.claims);
  const origin = publicOriginSchema.parse(input.origin);
  const { encodedClaims, signature } = await signClaims({
    claims,
    signingSecret: input.signingSecret,
    version: BEARER_HANDOFF_VERSION,
  });

  return {
    expiresAt: new Date(claims.expiresAt).toISOString(),
    url: `${origin}${REMOTE_MCP_BEARER_SETUP_PATH_PREFIX}${encodedClaims}/${signature}`,
  };
}

export async function readRemoteMcpBearerSetup(input: {
  encodedClaims: string;
  signature: string;
  signingSecret: unknown;
}): Promise<RemoteMcpBearerSetupClaims | null> {
  return readClaims({
    ...input,
    schema: claimsSchema,
    version: BEARER_HANDOFF_VERSION,
  });
}

export type RemoteMcpOAuthClaims = z.infer<typeof oauthClaimsSchema>;

export async function createRemoteMcpOAuthSetup(input: {
  claims: RemoteMcpOAuthClaims;
  origin: string;
  signingSecret: string;
}): Promise<{ expiresAt: string; url: string }> {
  const claims = oauthClaimsSchema.parse(input.claims);
  const origin = publicOriginSchema.parse(input.origin);
  const { encodedClaims, signature } = await signClaims({
    claims,
    signingSecret: input.signingSecret,
    version: OAUTH_SETUP_VERSION,
  });
  return {
    expiresAt: new Date(claims.expiresAt).toISOString(),
    url: `${origin}${REMOTE_MCP_OAUTH_SETUP_PATH_PREFIX}${encodedClaims}/${signature}`,
  };
}

export async function readRemoteMcpOAuthSetup(input: {
  encodedClaims: string;
  signature: string;
  signingSecret: unknown;
}): Promise<RemoteMcpOAuthClaims | null> {
  return readClaims({ ...input, schema: oauthClaimsSchema, version: OAUTH_SETUP_VERSION });
}

export async function createRemoteMcpOAuthState(input: {
  claims: RemoteMcpOAuthClaims;
  signingSecret: string;
}): Promise<string> {
  const claims = oauthClaimsSchema.parse(input.claims);
  const signed = await signClaims({
    claims,
    signingSecret: input.signingSecret,
    version: OAUTH_STATE_VERSION,
  });
  return `${signed.encodedClaims}.${signed.signature}`;
}

export async function readRemoteMcpOAuthState(input: {
  signingSecret: unknown;
  state: string;
}): Promise<RemoteMcpOAuthClaims | null> {
  const [encodedClaims, signature, extra] = input.state.split(".");
  if (encodedClaims === undefined || signature === undefined || extra !== undefined) return null;
  return readClaims({
    encodedClaims,
    schema: oauthClaimsSchema,
    signature,
    signingSecret: input.signingSecret,
    version: OAUTH_STATE_VERSION,
  });
}
