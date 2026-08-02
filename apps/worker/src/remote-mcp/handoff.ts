import {
  createRemoteMcpConnectionInputSchema,
  ownerKeySchema,
  remoteMcpEndpointSchema,
  remoteMcpConnectionNameSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

export const REMOTE_MCP_BEARER_SETUP_PATH_PREFIX = "/connections/remote-mcp/setup/";
const HANDOFF_VERSION = "crewhelm.remote-mcp-bearer-setup.v1";
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

function payload(claims: RemoteMcpBearerSetupClaims): string {
  return JSON.stringify([HANDOFF_VERSION, claims]);
}

export async function createRemoteMcpBearerSetup(input: {
  claims: RemoteMcpBearerSetupClaims;
  origin: string;
  signingSecret: string;
}): Promise<{ expiresAt: string; url: string }> {
  const claims = claimsSchema.parse(input.claims);
  const origin = publicOriginSchema.parse(input.origin);
  const secret = signingSecretSchema.parse(input.signingSecret);
  const encodedClaims = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await signingKey(secret), encoder.encode(payload(claims))),
    ),
  );

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
    const claims = claimsSchema.parse(JSON.parse(new TextDecoder().decode(decodedClaims)));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret.data),
      decodedSignature,
      encoder.encode(payload(claims)),
    );
    return valid && claims.expiresAt > Date.now() ? claims : null;
  } catch {
    return null;
  }
}
