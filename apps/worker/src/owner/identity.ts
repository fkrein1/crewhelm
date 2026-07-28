import {
  ownerKeySchema,
  verifiedOwnerIdentitySchema,
  type VerifiedOwnerIdentity,
} from "@crewhelm/contracts";

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function deriveOwnerKey(identityInput: unknown): Promise<string> {
  const identity: VerifiedOwnerIdentity = verifiedOwnerIdentitySchema.parse(identityInput);
  const canonicalIdentity = JSON.stringify([
    identity.issuer,
    identity.subject,
    identity.tenant ?? null,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalIdentity));

  return ownerKeySchema.parse(`owner_${encodeBase64Url(new Uint8Array(digest))}`);
}
