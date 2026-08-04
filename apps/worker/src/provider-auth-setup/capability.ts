import { ownerKeySchema, providerAuthSetupIdSchema } from "@crewhelm/contracts";
import * as z from "zod";

export const PROVIDER_AUTH_SETUP_PATH = "/setup/provider-auth";
export const PROVIDER_AUTH_SETUP_COOKIE = "crewhelm_provider_auth";
const CAPABILITY_VERSION = "crewhelm.provider-auth-setup.v1";
const SESSION_VERSION = "crewhelm.provider-auth-session.v1";
const encoder = new TextEncoder();
const signingSecretSchema = z.string().min(32).max(1_024);
const capabilityClaimsSchema = z.strictObject({
  expiresAt: z.number().int().positive().safe(),
  ownerKey: ownerKeySchema,
  setupId: providerAuthSetupIdSchema,
});
const sessionClaimsSchema = z.strictObject({
  ownerKey: ownerKeySchema,
  setupId: providerAuthSetupIdSchema,
});

export type ProviderAuthSetupCapabilityClaims = z.infer<typeof capabilityClaimsSchema>;
export interface ProviderAuthSetupCapability {
  capability: string;
  capabilityDigest: string;
  url: string;
}
export interface ProviderAuthSetupSession {
  claims: z.infer<typeof sessionClaimsSchema>;
  sessionDigest: string;
  token: string;
}

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

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function signedPayload(claims: ProviderAuthSetupCapabilityClaims): Uint8Array {
  return encoder.encode(JSON.stringify([CAPABILITY_VERSION, claims]));
}

function signedSessionPayload(claims: z.infer<typeof sessionClaimsSchema>, random: string) {
  return encoder.encode(JSON.stringify([SESSION_VERSION, claims, random]));
}

export async function createProviderAuthSetupCapability(input: {
  claims: ProviderAuthSetupCapabilityClaims;
  origin: string;
  signingSecret: string;
}): Promise<ProviderAuthSetupCapability> {
  const claims = capabilityClaimsSchema.parse(input.claims);
  const secret = signingSecretSchema.parse(input.signingSecret);
  const origin = new URL(input.origin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== input.origin ||
    origin.username !== "" ||
    origin.password !== ""
  ) {
    throw new TypeError("Expected a public HTTPS origin.");
  }

  const encodedClaims = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", await signingKey(secret), signedPayload(claims)),
    ),
  );
  const capability = `${encodedClaims}.${signature}`;
  return {
    capability,
    capabilityDigest: await digest(capability),
    url: `${input.origin}${PROVIDER_AUTH_SETUP_PATH}#capability=${capability}`,
  };
}

export async function readProviderAuthSetupCapability(input: {
  capability: unknown;
  signingSecret: unknown;
}): Promise<{ capabilityDigest: string; claims: ProviderAuthSetupCapabilityClaims } | null> {
  const secret = signingSecretSchema.safeParse(input.signingSecret);
  if (!secret.success || typeof input.capability !== "string") return null;
  const [encodedClaims, signature, extra] = input.capability.split(".");
  if (
    extra !== undefined ||
    encodedClaims === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(encodedClaims) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return null;
  }

  try {
    const decodedClaims = decodeBase64Url(encodedClaims);
    const decodedSignature = decodeBase64Url(signature);
    if (
      encodeBase64Url(decodedClaims) !== encodedClaims ||
      encodeBase64Url(decodedSignature) !== signature
    ) {
      return null;
    }
    const claims = capabilityClaimsSchema.parse(
      JSON.parse(new TextDecoder().decode(decodedClaims)),
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret.data),
      decodedSignature,
      signedPayload(claims),
    );
    return valid && claims.expiresAt > Date.now()
      ? { capabilityDigest: await digest(input.capability), claims }
      : null;
  } catch {
    return null;
  }
}

export async function createProviderAuthSetupSession(input: {
  ownerKey: string;
  setupId: string;
  signingSecret: string;
}): Promise<ProviderAuthSetupSession> {
  const claims = sessionClaimsSchema.parse({ ownerKey: input.ownerKey, setupId: input.setupId });
  const secret = signingSecretSchema.parse(input.signingSecret);
  const encodedClaims = encodeBase64Url(encoder.encode(JSON.stringify(claims)));
  const random = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const signature = encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        signedSessionPayload(claims, random),
      ),
    ),
  );
  const token = `${encodedClaims}.${random}.${signature}`;
  return { claims, sessionDigest: await digest(token), token };
}

export async function readProviderAuthSetupSession(input: {
  signingSecret: unknown;
  token: unknown;
}): Promise<Omit<ProviderAuthSetupSession, "token"> | null> {
  const secret = signingSecretSchema.safeParse(input.signingSecret);
  if (!secret.success || typeof input.token !== "string") return null;
  const [encodedClaims, random, signature, extra] = input.token.split(".");
  if (
    extra !== undefined ||
    encodedClaims === undefined ||
    random === undefined ||
    signature === undefined ||
    !/^[A-Za-z0-9_-]{1,4096}$/.test(encodedClaims) ||
    !/^[A-Za-z0-9_-]{43}$/.test(random) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signature)
  ) {
    return null;
  }
  try {
    const decoded = decodeBase64Url(encodedClaims);
    const decodedSignature = decodeBase64Url(signature);
    if (
      encodeBase64Url(decoded) !== encodedClaims ||
      encodeBase64Url(decodedSignature) !== signature
    ) {
      return null;
    }
    const claims = sessionClaimsSchema.parse(JSON.parse(new TextDecoder().decode(decoded)));
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret.data),
      decodedSignature,
      signedSessionPayload(claims, random),
    );
    return valid ? { claims, sessionDigest: await digest(input.token) } : null;
  } catch {
    return null;
  }
}
