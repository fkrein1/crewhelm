import {
  connectionAuthorizationAuthenticatorSchema,
  connectionAuthorizationTokenSchema,
  connectionLinkReservationIdSchema,
  ownerKeySchema,
} from "@crewhelm/contracts";
import * as z from "zod";

export const CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX = "/connections/composio/callback/";
const CONNECTION_AUTHORIZATION_RETURN_VERSION = "crewhelm.connection-authorization-return.v1";
const textEncoder = new TextEncoder();
const publicOriginSchema = z
  .url()
  .max(2_048)
  .refine((value) => {
    const url = new URL(value);

    return url.protocol === "https:" && url.origin === value;
  });
const callbackSigningSecretSchema = z.string().min(32).max(1_024);
const callbackExpiresAtSchema = z
  .string()
  .regex(/^[1-9][0-9]{12}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));
const callbackClaimsSchema = z.strictObject({
  expiresAt: callbackExpiresAtSchema,
  authorizationToken: connectionAuthorizationTokenSchema,
  ownerKey: ownerKeySchema,
  reservationId: connectionLinkReservationIdSchema,
});
export const callbackParametersSchema = callbackClaimsSchema.extend({
  authenticator: connectionAuthorizationAuthenticatorSchema,
});
const connectionAuthorizationCallbackInputSchema = z.strictObject({
  authorizationExpiresAt: z.iso.datetime(),
  authorizationToken: connectionAuthorizationTokenSchema,
  ownerKey: ownerKeySchema,
  origin: publicOriginSchema,
  reservationId: connectionLinkReservationIdSchema,
  signingSecret: callbackSigningSecretSchema,
});

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
  const binary = atob(base64);

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function callbackSignaturePayload(parameters: z.infer<typeof callbackClaimsSchema>): string {
  return JSON.stringify([
    CONNECTION_AUTHORIZATION_RETURN_VERSION,
    parameters.ownerKey,
    parameters.reservationId,
    parameters.expiresAt,
    parameters.authorizationToken,
  ]);
}

async function callbackSigningKey(signingSecret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

async function signCallback(
  signingSecret: string,
  parameters: z.infer<typeof callbackClaimsSchema>,
): Promise<string> {
  const claims = callbackClaimsSchema.parse(parameters);
  const signature = await crypto.subtle.sign(
    "HMAC",
    await callbackSigningKey(signingSecret),
    textEncoder.encode(callbackSignaturePayload(claims)),
  );

  return connectionAuthorizationAuthenticatorSchema.parse(
    encodeBase64Url(new Uint8Array(signature)),
  );
}

export async function hasValidCallbackAuthenticator(
  signingSecretInput: unknown,
  parameters: z.infer<typeof callbackParametersSchema>,
): Promise<boolean> {
  const signingSecret = callbackSigningSecretSchema.safeParse(signingSecretInput);

  if (!signingSecret.success) {
    return false;
  }

  try {
    return await crypto.subtle.verify(
      "HMAC",
      await callbackSigningKey(signingSecret.data),
      decodeBase64Url(parameters.authenticator),
      textEncoder.encode(callbackSignaturePayload(parameters)),
    );
  } catch {
    return false;
  }
}

export async function createConnectionAuthorizationCallback(input: unknown): Promise<{
  callbackSecrets: [string, string];
  callbackUrl: string;
}> {
  const request = connectionAuthorizationCallbackInputSchema.parse(input);
  const expiresAt = callbackExpiresAtSchema.parse(
    Date.parse(request.authorizationExpiresAt).toString(),
  );
  const parameters = {
    authorizationToken: request.authorizationToken,
    expiresAt,
    ownerKey: request.ownerKey,
    reservationId: request.reservationId,
  };
  const authenticator = await signCallback(request.signingSecret, parameters);

  return {
    callbackSecrets: [request.authorizationToken, authenticator],
    callbackUrl:
      `${request.origin}${CONNECTION_AUTHORIZATION_RETURN_PATH_PREFIX}` +
      `${request.ownerKey}/${request.reservationId}/${expiresAt}/` +
      `${request.authorizationToken}/${authenticator}`,
  };
}
