import {
  OWNER_DEFAULT_SCOPE_CLAIM,
  OWNER_SCOPES,
  ownerScopeClaimSchema,
  ownerScopesSchema,
} from "@crewhelm/contracts";
import * as z from "zod";

export const OFFLINE_ACCESS_SCOPE = "offline_access";
export const OAUTH_SCOPES = [...OWNER_SCOPES, OFFLINE_ACCESS_SCOPE] as const;
export const OAUTH_DEFAULT_SCOPE_CLAIM =
  `${OWNER_DEFAULT_SCOPE_CLAIM} ${OFFLINE_ACCESS_SCOPE}` as const;

export const oauthScopesSchema = z
  .array(z.enum(OAUTH_SCOPES))
  .min(1)
  .max(OAUTH_SCOPES.length)
  .refine((scopes) => new Set(scopes).size === scopes.length, "Duplicate OAuth scope.")
  .refine(
    (scopes) =>
      ownerScopesSchema.safeParse(scopes.filter((scope) => scope !== OFFLINE_ACCESS_SCOPE)).success,
    "An OAuth grant must include at least one owner scope.",
  );

export const oauthScopeClaimSchema = z
  .string()
  .min(1)
  .max(OAUTH_DEFAULT_SCOPE_CLAIM.length)
  .transform((claim, context) => {
    const parsedScopes = oauthScopesSchema.safeParse(claim.split(" "));

    if (!parsedScopes.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid OAuth scope claim.",
      });
      return z.NEVER;
    }

    return OAUTH_SCOPES.filter((scope) => parsedScopes.data.includes(scope)).join(" ");
  });

export function ownerScopeClaimFromOAuthClaim(claim: string): string | null {
  const parsed = oauthScopeClaimSchema.safeParse(claim);

  if (!parsed.success) {
    return null;
  }

  const ownerClaim = parsed.data
    .split(" ")
    .filter((scope) => scope !== OFFLINE_ACCESS_SCOPE)
    .join(" ");
  const ownerScopes = ownerScopeClaimSchema.safeParse(ownerClaim);

  return ownerScopes.success ? ownerScopes.data : null;
}
